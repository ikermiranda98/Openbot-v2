import { describe, expect, test } from "bun:test"
import { encodeWav } from "./wav"

const tag = (bytes: Uint8Array, offset: number) =>
  String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!)

describe("dictation wav encode", () => {
  test("frames a single mono sample in a canonical header", () => {
    const audio = encodeWav([new Float32Array([0])], 48_000)
    const view = new DataView(audio.buffer)

    expect(tag(audio, 0)).toBe("RIFF")
    expect(view.getUint32(4, true)).toBe(38)
    expect(tag(audio, 8)).toBe("WAVE")
    expect(tag(audio, 12)).toBe("fmt ")
    expect(view.getUint32(16, true)).toBe(16)
    expect(view.getUint16(20, true)).toBe(1)
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(48_000)
    expect(view.getUint32(28, true)).toBe(96_000)
    expect(view.getUint16(32, true)).toBe(2)
    expect(view.getUint16(34, true)).toBe(16)
    expect(tag(audio, 36)).toBe("data")
    expect(view.getUint32(40, true)).toBe(2)
    expect(audio.byteLength).toBe(46)
  })

  test("carries the capture rate through", () => {
    const audio = encodeWav([new Float32Array([0])], 16_000)

    expect(new DataView(audio.buffer).getUint32(24, true)).toBe(16_000)
  })

  test("clamps and scales samples to 16-bit", () => {
    const audio = encodeWav([new Float32Array([-1.5, -1, 0, 1, 2])], 48_000)
    const view = new DataView(audio.buffer, 44)

    expect(view.getInt16(0, true)).toBe(-32_768)
    expect(view.getInt16(2, true)).toBe(-32_768)
    expect(view.getInt16(4, true)).toBe(0)
    expect(view.getInt16(6, true)).toBe(32_767)
    expect(view.getInt16(8, true)).toBe(32_767)
  })

  test("joins held blocks in order", () => {
    const audio = encodeWav([new Float32Array([0.5]), new Float32Array([0.25, 0])], 48_000)
    const view = new DataView(audio.buffer, 44)

    expect(audio.byteLength).toBe(50)
    expect(view.getInt16(0, true)).toBe(Math.round(0.5 * 32_767))
    expect(view.getInt16(2, true)).toBe(Math.round(0.25 * 32_767))
    expect(view.getInt16(4, true)).toBe(0)
  })
})
