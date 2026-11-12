export * as VoiceEngine from "./engine"

// Dictation runs inside the app itself: the CPU build of sherpa-onnx transcribes whole-file WAV
// takes through a cached recognizer whose heavy calls (model load, decode) run on the addon's own
// native threads, and the Parakeet v3 weights download straight from their HuggingFace release the
// first time the app needs them. No sidecar process anywhere.
import { createHash } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { mkdir, rename, rm, stat } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import type { ReadableStream } from "node:stream/web"
import { app, BrowserWindow } from "electron"
import log from "electron-log/main.js"
import { emitIpcEvent } from "../ipc-events"
import { VoiceModelProgress } from "../../shared/ipc-rpc/events"
import { VoiceModelRow } from "../../shared/ipc-rpc/voice"
import { Wav } from "./wav"

// The one verdict with a fix the user can act on: the renderer maps it onto
// `dictation.failure.modelLoad` ("re-download it in Settings"); everything else lands generic.
const PREPARE_FAILED = "model-prepare-failed"

const MODEL_ID = "parakeet_v3"
const MODEL_NAME = "Parakeet v3"
// NVIDIA's parakeet-tdt-0.6b-v3, exported to ONNX by the sherpa-onnx project (25 European
// languages in one transducer, 16 kHz mono). The int8 release is ~670 MB across four files.
const RELEASE = "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/main"

const LANGUAGES = [
  "bg", "hr", "cs", "da", "nl", "en", "et", "fi", "fr", "de", "el", "hu", "it", "lv", "lt",
  "mt", "pl", "pt", "ro", "sk", "sl", "es", "sv", "ru", "uk",
] as const

// Each file's identity is pinned: the download checks the size it claimed and the digest it
// promised before the model may load. tokens.txt ships as a plain git file, so its sha256 was
// taken from the identical tokens.txt the k2-fsa fine-tune repos publish.
interface ModelFile {
  readonly name: string
  readonly bytes: number
  readonly sha256: string
}

const FILES: readonly ModelFile[] = [
  { name: "encoder.int8.onnx", bytes: 652_282_294, sha256: "1afbe69c1ffdabee94755f42e4daf1d93549131a3da11356bda84fcef0f2c479" },
  { name: "decoder.int8.onnx", bytes: 11_845_274, sha256: "0222a86147299d4dee90edf95b6d13827edb42ad8b7c9cf0b2582f030937c0b5" },
  { name: "joiner.int8.onnx", bytes: 6_355_277, sha256: "cbd02f3696e9944970111fb439d9c3fd365a80374565f13f2b9c7007d253fc98" },
  { name: "tokens.txt", bytes: 93_939, sha256: "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d" },
]

const TOTAL_BYTES = FILES.reduce((total, file) => total + file.bytes, 0)

const modelsDirectory = () => path.join(app.getPath("userData"), "voice-models")

// The binding's Windows build links onnxruntime.dll and its sherpa DLLs from its own directory,
// which the standard DLL search path skips: the directory rides PATH while the require runs.
type OfflineStream = { acceptWaveform: (input: { sampleRate: number; samples: Float32Array }) => void }
type RecognizerConfig = {
  featConfig: { sampleRate: number; featureDim: number }
  modelConfig: {
    transducer: { encoder: string; decoder: string; joiner: string }
    tokens: string
    numThreads: number
    provider: string
    debug: number
    modelType: string
  }
  decodingMethod: string
}
type Recognizer = {
  createStream: () => OfflineStream
  decodeAsync: (stream: OfflineStream) => Promise<{ text: string }>
}
type Addon = {
  OfflineRecognizer: { createAsync: (config: RecognizerConfig) => Promise<Recognizer> }
  version: string | (() => string)
}

let bindingPromise: Promise<Addon | undefined> | undefined

const ready = () => {
  bindingPromise ??= loadBinding()
  return bindingPromise
}

const loadBinding = async (): Promise<Addon | undefined> => {
  try {
    if (process.platform === "win32") {
      const nodeRequire = createRequire(import.meta.url)
      const directory = path.join(path.dirname(nodeRequire.resolve("sherpa-onnx-node/package.json")), "..", "sherpa-onnx-win-x64")
      if (!process.env.PATH?.split(path.delimiter).includes(directory)) {
        process.env.PATH = `${directory}${path.delimiter}${process.env.PATH ?? ""}`
      }
    }
    const mod = createRequire(import.meta.url)("sherpa-onnx-node") as Addon
    if (typeof mod.OfflineRecognizer?.createAsync !== "function") throw new Error("the binding answered an unknown shape")
    return mod
  } catch (error) {
    // A platform the binding cannot run on (or a broken install) keeps dictation hidden: the
    // composer reads this same verdict, so nothing wakes for an engine that cannot exist.
    log.warn(`The sherpa-onnx binding did not load: ${describeError(error)}`)
    return undefined
  }
}

export type VoiceStatus = {
  readonly available: boolean
  readonly reason?: "platform"
  readonly version?: string
}

export const status = async (): Promise<VoiceStatus> => {
  if (process.platform !== "win32" || process.arch !== "x64") return { available: false, reason: "platform" }
  const addon = await ready()
  if (!addon) return { available: false, reason: "platform" }
  return { available: true, version: typeof addon.version === "function" ? addon.version() : addon.version }
}

const assertModel = (model: string): string => {
  if (model !== MODEL_ID) throw new Error(`Unknown voice model id: ${model}`)
  return model
}

export const models = async (): Promise<readonly VoiceModelRow[]> => {
  // A model is installed only when every pinned file sits at its pinned size; the digest runs
  // once per prepare, never here (the settings and the composer both read this list).
  const directory = modelsDirectory()
  const present = await Promise.all(
    FILES.map((file) => stat(path.join(directory, file.name)).then((entry) => (entry.isFile() ? entry.size : -1), () => -1)),
  )
  const installed = FILES.every((file, index) => present[index] === file.bytes)

  return [
    {
      id: MODEL_ID,
      name: MODEL_NAME,
      installed,
      verified: installed,
      managed: true,
      downloadBytes: TOTAL_BYTES,
      languages: [...LANGUAGES],
      supportsLanguageDetection: false,
      source: null,
    },
  ]
}

// Inference and downloads stay one at a time: a serial queue keeps one decode from racing
// another, and a failed job never wedges the tail behind it.
let queueTail: Promise<unknown> = Promise.resolve()

const enqueue = <T>(job: () => Promise<T>): Promise<T> => {
  const run = queueTail.then(job, job)
  queueTail = run.catch(() => undefined)
  return run
}

// One download per model however many callers ask for it: the warm-up, the settings picker and a
// take that beats the warm-up all await the same job.
const inFlight = new Map<string, Promise<void>>()

const ensure = (model: string): Promise<void> => {
  const running = inFlight.get(model)
  if (running) return running

  const job = downloadAndLoad(model).finally(() => inFlight.delete(model))
  inFlight.set(model, job)
  return job
}

export const prepare = (model: string, language?: string): Promise<void> => {
  assertModel(model)
  // Parakeet v3 carries all 25 languages in one transducer with no language conditioning: the
  // parameter stays part of the surface (the picker and the takes hand the app's primary tag
  // along) while the model ignores it.
  void language
  return ensure(model)
}

export const transcribe = (audio: Uint8Array, model: string, language?: string): Promise<{ transcript: string; durationMs: number }> => {
  Wav.parse(audio)
  assertModel(model)
  void language

  return enqueue(async () => {
    // A take that beats the warm-up pays the download inside its own slot, so the queue can never
    // deadlock waiting on a prepare that sits behind it.
    await ensure(model)
    const recognizer = await load(model)
    const { samples, sampleRate } = Wav.decode(audio)

    let transcript = ""
    for (const chunk of chunksAtSilences(to16k(samples, sampleRate))) {
      const stream = recognizer.createStream()
      stream.acceptWaveform({ sampleRate: TARGET_RATE, samples: chunk })
      const result = await recognizer.decodeAsync(stream)
      const text = result.text.trim()
      if (text) transcript += (transcript ? " " : "") + text
    }

    return { transcript, durationMs: Math.round((samples.length / sampleRate) * 1_000) }
  })
}

// Transcription failures are the renderer's feedback: surface the verdict for i18n mapping.
export const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const downloadAndLoad = async (model: string): Promise<void> => {
  const directory = modelsDirectory()
  await mkdir(directory, { recursive: true })

  let lastAnnounce = 0
  const announce = (event: VoiceModelProgress) => {
    for (const win of BrowserWindow.getAllWindows()) emitIpcEvent(win.webContents, event)
  }
  // Downloads tick per chunk; announce near one per 150 ms so the settings row's percent moves
  // without a store write per TCP segment. Terminal stages announce once.
  const announceDownload = (received: number) => {
    const now = Date.now()
    if (now - lastAnnounce < 150) return
    lastAnnounce = now
    announce(new VoiceModelProgress({ model, stage: "downloading", downloadedBytes: received, totalBytes: TOTAL_BYTES }))
  }

  const missing = await Promise.all(
    FILES.map(async (file) => {
      const size = await stat(path.join(directory, file.name)).then((entry) => (entry.isFile() ? entry.size : -1), () => -1)
      return size === file.bytes ? undefined : file
    }),
  )
  const pending = missing.filter((file) => file !== undefined)
  let received = TOTAL_BYTES - pending.reduce((total, file) => total + file.bytes, 0)

  for (const file of pending) received = await download(model, file, directory, received, announceDownload)
  if (pending.length > 0) announceDownload(received)

  announce(new VoiceModelProgress({ model, stage: "verifying" }))
  for (const file of FILES) await verify(file, directory)

  announce(new VoiceModelProgress({ model, stage: "loading" }))
  await load(model)

  // The terminal stage: every listener — the composer's ring, a Settings row — clears its own
  // progress on it, so no surface's finish depends on another's promise.
  announce(new VoiceModelProgress({ model, stage: "ready" }))
}

// A silent stall (the download the user first saw: 193 MB left as `.partial`, no verdict ever)
// aborts through the watchdog and keeps the fetched bytes: the next attempt resumes by range.
const STALL_MS = 60_000
const WATCHDOG_TICK_MS = 5_000

const download = async (
  model: string,
  file: ModelFile,
  directory: string,
  received: number,
  announceDownload: (bytes: number) => void,
): Promise<number> => {
  const partial = path.join(directory, `${file.name}.partial`)
  const present = await stat(partial).then((entry) => (entry.isFile() ? entry.size : -1), () => -1)
  let from = present > 0 && present < file.bytes ? present : -1
  if (from < 0) {
    await rm(partial, { force: true })
    from = 0
  }

  const controller = new AbortController()
  let lastChunk = Date.now()
  const watchdog = setInterval(() => {
    if (Date.now() - lastChunk > STALL_MS) controller.abort(new Error(`The ${file.name} download stalled`))
  }, WATCHDOG_TICK_MS)

  try {
    const response = await fetch(`${RELEASE}/${file.name}`, {
      headers: from > 0 ? { range: `bytes=${from}-` } : {},
      redirect: "follow",
      signal: controller.signal,
    })
    // A server that ignores the range answers 200 with the whole file: start over from zero. The
    // resumed bytes were never counted (the write reopens with "w"), so nothing to subtract.
    if (from > 0 && response.status !== 206) {
      from = 0
    }
    if (response.status !== 200 && response.status !== 206) {
      throw new Error(`The ${file.name} download answered HTTP ${response.status}`)
    }
    if (!response.body) throw new Error(`The ${file.name} download answered no body`)

    received += from
    announceDownload(received)

    // Per-chunk counting rides a Transform so pipeline owns the backpressure and the teardown.
    const progress = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.byteLength
        lastChunk = Date.now()
        announceDownload(received)
        callback(null, chunk)
      },
    })
    // The DOM and stream/web ReadableStream declarations disagree on their BYOB signatures; the
    // runtime object is the same stream fromWeb adapts.
    await pipeline(Readable.fromWeb(response.body as unknown as ReadableStream), progress, createWriteStream(partial, { flags: from > 0 ? "a" : "w" }))

    const size = (await stat(partial)).size
    if (size !== file.bytes) throw new Error(`The ${file.name} download landed ${size} bytes, expected ${file.bytes}`)
    await rename(partial, path.join(directory, file.name))
  } catch (error) {
    log.warn(`The ${file.name} download failed: ${describeError(error)}`)
    throw new Error(PREPARE_FAILED, { cause: error })
  } finally {
    clearInterval(watchdog)
  }

  return received
}

// The digest verdicts cache on size: a same-size file hashes once per process, so a resumed
// prepare never re-hashes 650 MB that already passed.
const verdicts = new Map<string, { readonly size: number; readonly ok: boolean }>()

const verify = async (file: ModelFile, directory: string): Promise<void> => {
  const target = path.join(directory, file.name)
  const size = await stat(target).then((entry) => (entry.isFile() ? entry.size : -1), () => -1)
  if (size !== file.bytes) throw new Error(PREPARE_FAILED)

  const seen = verdicts.get(file.name)
  if (seen?.size === size) return

  const hasher = createHash("sha256")
  const stream = createReadStream(target)
  for await (const chunk of stream) hasher.update(chunk)
  const ok = hasher.digest("hex").toLowerCase() === file.sha256
  verdicts.set(file.name, { size, ok })

  if (!ok) {
    log.warn(`The downloaded ${file.name} does not match its pinned sha256; discarding it`)
    await rm(target, { force: true })
    throw new Error(PREPARE_FAILED)
  }
}

const recognizers = new Map<string, Promise<Recognizer>>()

const load = (model: string): Promise<Recognizer> => {
  const cached = recognizers.get(model)
  if (cached) return cached

  const created = (async () => {
    const addon = await ready()
    if (!addon) throw new Error(PREPARE_FAILED)
    const directory = modelsDirectory()

    // featureDim 128 and nemo_transducer are the v3 export's own constants (its encoder metadata
    // carries a TDT joiner that only loads through the nemo path); a wrong featureDim mis-feeds
    // the mel frontend.
    return addon.OfflineRecognizer.createAsync({
      featConfig: { sampleRate: TARGET_RATE, featureDim: 128 },
      modelConfig: {
        transducer: {
          encoder: path.join(directory, "encoder.int8.onnx"),
          decoder: path.join(directory, "decoder.int8.onnx"),
          joiner: path.join(directory, "joiner.int8.onnx"),
        },
        tokens: path.join(directory, "tokens.txt"),
        numThreads: 2,
        provider: "cpu",
        debug: 0,
        modelType: "nemo_transducer",
      },
      decodingMethod: "greedy_search",
    })
  })()
  recognizers.set(model, created)
  // A failed load must not poison the cache: the next prepare or take tries again.
  created.catch(() => recognizers.delete(model))
  return created
}

// Quitting frees the native model memory: dropping the last recognizer references lets the
// addon's finalizers reclaim the weights before the process tears down.
app.once("will-quit", () => recognizers.clear())

const TARGET_RATE = 16_000

// The recorder ships the microphone's native rate; the frontend wants 16 kHz. Linear
// interpolation is plenty for speech either way (8 kHz up, 192 kHz down).
const to16k = (samples: Float32Array, rate: number): Float32Array => {
  if (rate === TARGET_RATE) return samples

  const count = Math.round((samples.length / rate) * TARGET_RATE)
  const speech = new Float32Array(count)
  const last = samples.length - 1
  for (let index = 0; index < count; index++) {
    const source = Math.min(index * (rate / TARGET_RATE), last)
    const left = Math.min(Math.floor(source), last)
    const right = Math.min(left + 1, last)
    const blend = source - left
    speech[index] = samples[left] * (1 - blend) + samples[right] * blend
  }
  return speech
}

// Long audio must be split at silences: the model card's stress test decoded a whole 185 s clip
// at 66% WER and +1.6 GB RSS where 15 s pieces stayed at 15% and +142 MB. Cuts land at the
// quietest 10 ms frame in the window ahead, so a real pause keeps the model's context intact.
const MAX_CHUNK = 20 * TARGET_RATE
const SEARCH_WINDOW = 3 * TARGET_RATE
const FRAME = 160 // 10 ms at 16 kHz

const chunksAtSilences = (samples: Float32Array): Float32Array[] => {
  if (samples.length <= MAX_CHUNK) return [samples]

  const pieces: Float32Array[] = []
  let start = 0
  while (samples.length - start > MAX_CHUNK) {
    const ideal = start + MAX_CHUNK
    const from = Math.max(start + MAX_CHUNK / 2, ideal - SEARCH_WINDOW)
    const cut = quietest(samples, Math.round(from / FRAME) * FRAME, Math.round(ideal / FRAME) * FRAME)
    pieces.push(samples.subarray(start, cut))
    start = cut
  }
  pieces.push(samples.subarray(start))
  return pieces
}

const quietest = (samples: Float32Array, from: number, to: number): number => {
  let best = from
  let bestEnergy = Number.POSITIVE_INFINITY
  for (let cut = from; cut <= to && cut < samples.length; cut += FRAME) {
    let energy = 0
    for (let index = cut; index < cut + FRAME && index < samples.length; index++) energy += Math.abs(samples[index])
    if (energy < bestEnergy) {
      bestEnergy = energy
      best = cut
    }
  }
  return best
}
