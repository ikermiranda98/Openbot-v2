export * as Wav from "./wav"

// The renderer records at the microphone's native rate and ships whole-file WAV (PCM 16-bit).
// Validation lives here in the process that owns the engine, so a renderer bug or a stale payload
// never reaches the recognizer.
export const MAX_BYTES = 64 * 1024 * 1024
export const MIN_SAMPLE_RATE = 8_000
export const MAX_SAMPLE_RATE = 192_000
export const MIN_CHANNELS = 1
export const MAX_CHANNELS = 8

export class WavError extends Error {}

export interface WavInfo {
  readonly sampleRate: number
  readonly channels: number
}

export function parse(bytes: Uint8Array): WavInfo {
  if (bytes.byteLength > MAX_BYTES) throw new WavError("WAV exceeds the 64 MiB service budget")
  if (bytes.byteLength < 44) throw new WavError("WAV is too short to hold a header")
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (offset: number) => tagAt(view, offset)

  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new WavError("WAV is missing the RIFF/WAVE markers")

  let info: { readonly format: number; readonly channels: number; readonly sampleRate: number; readonly bits: number } | undefined
  let data: { readonly length: number } | undefined
  let offset = 12

  while (offset + 8 <= bytes.byteLength) {
    const id = tag(offset)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8

    if (size > bytes.byteLength - body) throw new WavError(`Chunk ${id} claims more bytes than the file holds`)
    if (id === "fmt " && size >= 16) {
      info = {
        format: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      }
    }
    if (id === "data") {
      data = { length: size }
      break
    }
    offset = body + size + (size % 2)
  }

  if (!info) throw new WavError("WAV has no fmt chunk")
  if (info.format !== 1) throw new WavError("WAV is not PCM")
  if (info.bits !== 16) throw new WavError("WAV is not 16-bit PCM")
  if (info.channels < MIN_CHANNELS || info.channels > MAX_CHANNELS) {
    throw new WavError(`WAV has ${info.channels} channels; the service accepts 1–8`)
  }
  if (info.sampleRate < MIN_SAMPLE_RATE || info.sampleRate > MAX_SAMPLE_RATE) {
    throw new WavError(`WAV sample rate ${info.sampleRate} is outside 8–192 kHz`)
  }
  if (!data) throw new WavError("WAV has no data chunk")
  if (data.length === 0) throw new WavError("WAV holds no samples")
  if (data.length % (info.channels * 2) !== 0) throw new WavError("WAV data does not land on a whole frame")

  return { sampleRate: info.sampleRate, channels: info.channels }
}

// The header the renderer must write. Kept next to the parser so the two cannot disagree.
export function header(sampleRate: number, channels: number, bits: number, dataBytes: number): Uint8Array {
  const view = new DataView(new ArrayBuffer(44))
  const write = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index++) view.setUint8(offset + index, text.charCodeAt(index))
  }

  write(0, "RIFF")
  view.setUint32(4, 36 + dataBytes, true)
  write(8, "WAVE")
  write(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, (sampleRate * channels * bits) / 8, true)
  view.setUint16(32, (channels * bits) / 8, true)
  view.setUint16(34, bits, true)
  write(36, "data")
  view.setUint32(40, dataBytes, true)

  return new Uint8Array(view.buffer)
}

export interface WavAudio {
  readonly samples: Float32Array
  readonly sampleRate: number
}

/** The payload as mono floats for the recognizer: channels average, PCM 16 lands in [-1, 1). */
export function decode(bytes: Uint8Array): WavAudio {
  const info = parse(bytes)
  // A parsed file is well-formed; walk it again for the data chunk's location.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 12
  let location: { readonly offset: number; readonly length: number } | undefined

  while (offset + 8 <= bytes.byteLength) {
    const id = tagAt(view, offset)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8

    if (id === "data") {
      location = { offset: body, length: size }
      break
    }
    offset = body + size + (size % 2)
  }

  if (!location) throw new WavError("WAV has no data chunk")

  const frames = Math.floor(location.length / (info.channels * 2))
  const mono = new Float32Array(frames)
  for (let frame = 0; frame < frames; frame++) {
    let sum = 0
    for (let channel = 0; channel < info.channels; channel++) {
      sum += view.getInt16(location.offset + (frame * info.channels + channel) * 2, true)
    }
    mono[frame] = sum / (info.channels * 32_768)
  }

  return { samples: mono, sampleRate: info.sampleRate }
}

const tagAt = (view: DataView, offset: number): string =>
  String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3))

