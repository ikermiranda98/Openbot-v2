/** Encodes held mono samples as a whole-file WAV (PCM 16-bit) at the capture's native rate. */
export function encodeWav(samples: readonly Float32Array[], sampleRate: number): Uint8Array<ArrayBuffer> {
  const frames = samples.reduce((total, block) => total + block.length, 0)
  const buffer = new ArrayBuffer(44 + frames * 2)
  const view = new DataView(buffer)
  const four = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index++) view.setUint8(offset + index, text.charCodeAt(index))
  }

  four(0, "RIFF")
  view.setUint32(4, 36 + frames * 2, true)
  four(8, "WAVE")
  four(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  four(36, "data")
  view.setUint32(40, frames * 2, true)

  let offset = 44
  for (const block of samples) {
    for (let index = 0; index < block.length; index++) {
      const value = block[index]!
      view.setInt16(offset, Math.round(Math.max(-1, Math.min(1, value)) * (value < 0 ? 0x8000 : 0x7fff)), true)
      offset += 2
    }
  }

  return new Uint8Array(buffer)
}
