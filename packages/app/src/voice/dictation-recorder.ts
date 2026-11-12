import { encodeWav } from "./wav"

interface Captured {
  context: AudioContext
  stream: MediaStream
  source: MediaStreamAudioSourceNode
  processor: AudioWorkletNode
  sink: GainNode
  samples: Float32Array[]
  /** Windowed RMS of a one-pole low-pass (~300 Hz), 0..1 — the low band the waves ride. */
  bass: number
}

// The capture runs on the audio thread: the worklet hands every render quantum (128 frames) to the
// renderer as it arrives, so a release has the whole take at once. It ships inline as a module URL,
// with no extra asset to serve.
const CAPTURE = "opendash-mic-capture"

const CAPTURE_MODULE = `registerProcessor(${JSON.stringify(CAPTURE)}, class extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (channel) this.port.postMessage(channel.slice(0))
    return true
  }
})`

// The waves' level follows the same 4096-sample window the capture used to deliver in one block.
const BASS_WINDOW = 4096

/**
 * A held microphone capture. The renderer records at the device's native rate; release encodes
 * whole-file WAV (PCM 16-bit) the main process validates before handing it to the engine.
 */
export class MicRecorder {
  private constructor(private readonly captured: Captured) {}

  static async start(): Promise<MicRecorder> {
    // The call path tunes its stream for speech; dictation asks the same of the device.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    })

    let context: AudioContext | undefined

    // Once the device was held, a failed graph must not leave it held: anything throwing from
    // here gives the tracks back where the node wiring never reached its recorder.
    try {
      context = new AudioContext()
      await context.resume()

      const module = URL.createObjectURL(new Blob([CAPTURE_MODULE], { type: "text/javascript" }))

      try {
        await context.audioWorklet.addModule(module)
      } finally {
        URL.revokeObjectURL(module)
      }

      const source = context.createMediaStreamSource(stream)
      // One channel, mixed down from whatever the device offers, as the capture always recorded.
      const processor = new AudioWorkletNode(context, CAPTURE, { channelCount: 1, channelCountMode: "explicit" })
      const sink = context.createGain()
      source.connect(processor)
      processor.connect(sink)
      // The node stays pulled by the graph through a muted gain, so the capture never feeds back.
      sink.gain.value = 0
      sink.connect(context.destination)

      const samples: Float32Array[] = []
      const captured: Captured = { context, stream, source, processor, sink, samples, bass: 0 }
      // The same blocks the WAV keeps also feed a one-pole low-pass (~300 Hz); its RMS over each
      // window is the voice's low band. Measured here so the button needs no analyser graph of its
      // own: one filter pass per captured block, no extra Web Audio nodes besides the capture.
      const pole = Math.exp((-2 * Math.PI * 300) / context.sampleRate)
      const level = { follow: 0, energy: 0, counted: 0 }

      processor.port.onmessage = (event) => {
        const block = event.data

        if (!(block instanceof Float32Array)) return

        samples.push(block)

        for (const sample of block) {
          level.follow += pole * (sample - level.follow)
          level.energy += level.follow * level.follow
        }

        level.counted += block.length

        if (level.counted < BASS_WINDOW) return

        // AGC keeps speech well under full scale; the lift puts a normal voice into visible range.
        captured.bass = Math.min(1, 6 * Math.sqrt(level.energy / level.counted))
        level.energy = 0
        level.counted = 0
      }

      return new MicRecorder(captured)
    } catch (cause) {
      stream.getAudioTracks().forEach((track) => track.stop())

      if (context) void context.close().catch(() => undefined)
      throw cause
    }
  }

  /** The current low-band estimate; the wave reader polls it per frame, nobody subscribes. */
  bass(): number {
    return this.captured.bass
  }

  stop(): { audio: Uint8Array<ArrayBuffer>; sampleRate: number } {
    const { context, samples } = this.captured

    this.teardown()

    return { audio: encodeWav(samples, context.sampleRate), sampleRate: context.sampleRate }
  }

  /** Drops a capture without producing audio; the composer discards a hold too short to be a word. */
  cancel(): void {
    this.teardown()
  }

  private teardown() {
    const { context, stream, source, processor, sink } = this.captured

    stream.getAudioTracks().forEach((track) => track.stop())
    processor.port.onmessage = null
    processor.port.close()
    processor.disconnect()
    source.disconnect()
    sink.disconnect()
    void context.close().catch(() => undefined)
  }
}
