import { describe, expect, test } from "bun:test"
import { Wav, header } from "./wav"

// Builds a header plus a PCM tail of the given shape; `values` cycles into the samples.
function pcm(sampleRate: number, channels: number, bits: number, frames: number, values: number[]): Uint8Array {
  const bytes = new Uint8Array(frames * channels * (bits / 8))
  const view = new DataView(bytes.buffer)
  for (let index = 0; index < frames * channels; index++) {
    view.setInt16(index * 2, values[index % values.length] ?? 0, true)
  }

  const head = header(sampleRate, channels, bits, bytes.byteLength)
  const all = new Uint8Array(head.byteLength + bytes.byteLength)
  all.set(head)
  all.set(bytes, head.byteLength)
  return all
}

describe("wav validation", () => {
  test.each([
    { name: "48k mono", rate: 48_000, channels: 1, bits: 16 },
    { name: "44.1k stereo", rate: 44_100, channels: 2, bits: 16 },
    { name: "8k mono", rate: 8_000, channels: 1, bits: 16 },
    { name: "192k stereo", rate: 192_000, channels: 2, bits: 16 },
  ])("$name parses", ({ rate, channels, bits }) => {
    expect(Wav.parse(pcm(rate, channels, bits, 64, [3, -3]))).toEqual({ sampleRate: rate, channels })
  })

  test("accepts chunks between fmt and data", () => {
    const audio = pcm(48_000, 1, 16, 4, [1])
    const extra = new Uint8Array(16)
    const view = new DataView(extra.buffer)
    view.setUint8(0, 76) // 'L'
    view.setUint8(1, 73) // 'I'
    view.setUint8(2, 83) // 'S'
    view.setUint8(3, 84) // 'T'
    view.setUint32(4, 8, true)
    // Splice the LIST chunk between the fmt fields (first 36 bytes) and the data header+payload.
    const head = audio.subarray(0, 36)
    const tail = audio.subarray(36)
    const all = new Uint8Array(head.byteLength + extra.byteLength + tail.byteLength)
    all.set(head)
    all.set(extra, head.byteLength)
    all.set(tail, head.byteLength + extra.byteLength)

    expect(Wav.parse(all)).toEqual({ sampleRate: 48_000, channels: 1 })
  })

  test("mono payloads with an odd frame count still parse", () => {
    // The alignment contract is whole frames of `channels * 2` bytes, not a stereo-derived `% 4`
    // that once rejected valid odd mono takes from other encoders.
    expect(Wav.parse(pcm(48_000, 1, 16, 63, [3, -3]))).toEqual({ sampleRate: 48_000, channels: 1 })
  })

  test("a multi-channel payload short on whole frames is rejected", () => {
    // Two stereo frames hold 8 bytes; a header claiming 6 cannot split into full channel frames.
    const audio = pcm(48_000, 2, 16, 2, [1])
    new DataView(audio.buffer).setUint32(40, 6, true)
    expect(() => Wav.parse(audio)).toThrow(Wav.WavError)
  })

  test.each([
    { name: "bad magic", bytes: (() => { const audio = pcm(48_000, 1, 16, 4, [1]); audio[0] = 88; return audio })() },
    { name: "too short", bytes: new Uint8Array(20) },
    {
      name: "not PCM",
      bytes: (() => {
        const audio = pcm(48_000, 1, 16, 4, [1])
        new DataView(audio.buffer).setUint16(20, 3, true)
        return audio
      })(),
    },
    {
      name: "not 16-bit",
      bytes: (() => {
        const head = header(48_000, 1, 24, 8)
        const all = new Uint8Array(head.byteLength + 8)
        all.set(head)
        return all
      })(),
    },
    { name: "too slow", bytes: pcm(4_000, 1, 16, 4, [1]) },
    { name: "too fast", bytes: pcm(200_000, 1, 16, 4, [1]) },
    { name: "nine channels", bytes: pcm(48_000, 9, 16, 4, [1]) },
    {
      name: "no data chunk",
      bytes: (() => {
        const audio = pcm(48_000, 1, 16, 4, [1])
        const view = new DataView(audio.buffer)
        view.setUint8(36, 70)
        view.setUint8(37, 65)
        view.setUint8(38, 73)
        view.setUint8(39, 76)
        return audio
      })(),
    },
    { name: "empty data", bytes: pcm(48_000, 1, 16, 0, [0]) },
  ])("$name is rejected", ({ bytes }) => {
    expect(() => Wav.parse(bytes)).toThrow(Wav.WavError)
  })

  test("oversize payloads are rejected without parsing", () => {
    expect(() => Wav.parse(new Uint8Array(Wav.MAX_BYTES + 8))).toThrow(Wav.WavError)
  })
})

describe("wav decode", () => {
  test("mono payloads decode one float per frame at the file's rate", () => {
    const audio = pcm(48_000, 1, 16, 4, [16_384, -16_384, 8_192, 0])
    expect(Wav.decode(audio)).toEqual({ samples: new Float32Array([0.5, -0.5, 0.25, 0]), sampleRate: 48_000 })
  })

  test("stereo payloads average into one mono float per frame", () => {
    // Two frames, both channels: (0.25 + -0.75) / 2 = -0.25, then (0.25 + 0.75) / 2 = 0.5.
    const audio = pcm(16_000, 2, 16, 2, [8_192, -24_576, 8_192, 24_576])
    expect(Wav.decode(audio)).toEqual({ samples: new Float32Array([-0.25, 0.5]), sampleRate: 16_000 })
  })

  test("decode rejects everything parse rejects", () => {
    expect(() => Wav.decode(new Uint8Array(20))).toThrow(Wav.WavError)
    expect(() => Wav.decode(pcm(4_000, 1, 16, 4, [1]))).toThrow(Wav.WavError)
  })
})
