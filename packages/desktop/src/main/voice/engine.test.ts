// The engine's border contracts: a model is installed only at its pinned sizes, a take that
// cannot happen (bad WAV, unknown model) fails at the boundary before the queue, and the
// binding's verdict clears on the release target. Electron never runs (a mutable app proxy), and
// the binding does run here on windows-x64, where the full pipeline is the release target.
import { describe, expect, mock, test } from "bun:test"
import { mkdir, mkdtemp, open, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Wav } from "./wav"

mock.module("electron", () => ({
  app: { getPath: (name: string) => (name === "userData" ? raiz : ""), once: () => {} },
  BrowserWindow: { getAllWindows: () => [] },
}))
mock.module("electron-log/main.js", () => ({ default: { warn: () => {}, info: () => {}, error: () => {} } }))

let raiz = ""

const HA = process.platform === "win32" && process.arch === "x64"
const prueba = test.skipIf(!HA)

// A 44-byte header plus 8 bytes of samples: everything Wav.parse demands of a submission.
const WAV = new Uint8Array([...Wav.header(16_000, 1, 16, 8), ...new Uint8Array(8)])

const sut = await import("./engine")

const montar = async () => {
  raiz = await mkdtemp(join(tmpdir(), "opencode-voice-engine-"))
  return async () => rm(raiz, { recursive: true, force: true })
}

// Sparse files cost nothing to write and satisfy the size sentinel exactly.
const asentar = async (name: string, bytes: number) => {
  await mkdir(join(raiz, "voice-models"), { recursive: true })
  const handle = await open(join(raiz, "voice-models", name), "w")
  await handle.truncate(bytes)
  await handle.close()
}

describe("the voice engine", () => {
  prueba("status clears on the windows-x64 release target", async () => {
    expect(await sut.status()).toEqual({ available: true, version: "2.0.1" })
  })

  test("the catalog names the pinned download while nothing is installed", async () => {
    const limpiar = await montar()
    const row = (await sut.models())[0]

    expect(row?.id).toBe("parakeet_v3")
    expect(row?.name).toBe("Parakeet v3")
    expect(row?.installed).toBe(false)
    expect(row?.verified).toBe(false)
    expect(row?.managed).toBe(true)
    expect(row?.downloadBytes).toBe(670_576_784)
    expect(row?.languages.length).toBe(25)
    expect(row?.languages).toEqual(expect.arrayContaining(["en", "es", "de", "fr"]))
    await limpiar()
  })

  test("a model is installed only at its pinned sizes", async () => {
    const limpiar = await montar()
    await asentar("encoder.int8.onnx", 652_282_294)
    await asentar("decoder.int8.onnx", 11_845_274)
    await asentar("joiner.int8.onnx", 6_355_277)
    // The tokens file is one byte short: the sentinel fails and the row stays downloadable.
    await asentar("tokens.txt", 93_938)
    expect((await sut.models())[0]?.installed).toBe(false)

    await asentar("tokens.txt", 93_939)
    expect((await sut.models())[0]?.installed).toBe(true)
    await limpiar()
  })

  prueba("a download streams the served bytes onto the partial before verification rejects them", async () => {
    const limpiar = await montar()

    // A stubbed release: 1 KiB served where the pinned encoder wants 652 MB, so the run must
    // fail on the size sentinel — but only after the write path actually landed the bytes.
    const payload = Buffer.alloc(1024, 7)
    const release = globalThis.fetch
    globalThis.fetch = (async () => new Response(new Uint8Array(payload), { status: 200 })) as typeof fetch

    try {
      await expect(sut.prepare("parakeet_v3")).rejects.toThrow()
      // The proof the write path ran: the partial holds what the body served, byte for byte.
      const partial = await stat(join(raiz, "voice-models", "encoder.int8.onnx.partial")).then(
        (entry) => entry.size,
        () => -1,
      )
      expect(partial).toBe(1024)
    } finally {
      globalThis.fetch = release
      await limpiar()
    }
  })

  prueba("a take that cannot happen fails at the boundary, before the queue", async () => {
    await montar()

    // Validation throws synchronously: a bad submission never becomes a queued job.
    expect(() => sut.transcribe(new Uint8Array(20), "parakeet_v3")).toThrow(Wav.WavError)
    expect(() => sut.transcribe(WAV, "otro-modelo")).toThrow("Unknown voice model id")
    expect(() => sut.prepare("otro-modelo")).toThrow("Unknown voice model id")
  })

  prueba("transcribe passes the language through its surface untouched", async () => {
    // The v3 engine conditions on no language; the parameter rides the call for surface
    // compatibility. No download here: this only proves the unresolvable model id surfaces the
    // same way with and without one.
    expect(() => sut.transcribe(WAV, "otro-modelo", "es")).toThrow("Unknown voice model id")
  })
})
