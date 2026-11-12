import type { MicRecorder } from "./dictation-recorder"

/** A take the desk's own listener records while no composer of its surface is live yet (the
    chat still booting, or its view still loading): the microphone opens on the press itself,
    so nothing said while the chat comes up is lost. Releasing the key stops the capture at once
    and keeps the audio until a composer mounts and adopts the take. */
export class ParkedTake {
  readonly at = Date.now()
  readonly recorder: Promise<MicRecorder | undefined>
  /** Set once the key is up: the captured audio, or undefined when the microphone never opened. */
  audio: Promise<Uint8Array<ArrayBuffer> | undefined> | undefined

  constructor(open: () => Promise<MicRecorder>) {
    this.recorder = open().catch(() => undefined)
  }

  release() {
    this.audio ??= this.recorder.then((recorder) => recorder?.stop().audio)
  }

  discard() {
    this.audio ??= this.recorder.then((recorder) => {
      recorder?.cancel()

      return undefined
    })
  }
}

// A parked take older than this is stale (the chat failed to come up and the user moved on):
// the next composer drops it instead of typing words from minutes ago.
export const PARKED_TAKE_TTL_MS = 60_000
