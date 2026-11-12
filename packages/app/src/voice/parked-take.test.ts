import { expect, test } from "bun:test"
import { ParkedTake } from "./parked-take"
import type { MicRecorder } from "./dictation-recorder"

// A stand-in for the microphone: it records whether the device was handed back and how.
function fakeRecorder() {
  const audio = new Uint8Array([1, 2, 3])
  const calls: string[] = []

  // SAFETY: ParkedTake only calls stop() and cancel(), the two members this stand-in carries.
  const recorder = {
    stop: () => {
      calls.push("stop")

      return { audio, sampleRate: 16_000 }
    },
    cancel: () => calls.push("cancel"),
  } as unknown as MicRecorder

  return { recorder, audio, calls }
}

test("a take released before any composer mounts keeps its audio and frees the microphone", async () => {
  const mic = fakeRecorder()
  const take = new ParkedTake(async () => mic.recorder)

  expect(take.audio).toBeUndefined()
  take.release()
  expect(await take.audio).toBe(mic.audio)
  expect(mic.calls).toEqual(["stop"])
})

test("a release that lands before the microphone opens still stops it once it does", async () => {
  const mic = fakeRecorder()
  let open: (recorder: MicRecorder) => void = () => undefined
  const take = new ParkedTake(() => new Promise((resolve) => (open = resolve)))

  take.release()
  expect(mic.calls).toEqual([])
  open(mic.recorder)
  expect(await take.audio).toBe(mic.audio)
  expect(mic.calls).toEqual(["stop"])
})

test("only the first ending counts: a later discard or release changes nothing", async () => {
  const mic = fakeRecorder()
  const take = new ParkedTake(async () => mic.recorder)

  take.release()
  take.discard()
  take.release()
  expect(await take.audio).toBe(mic.audio)
  expect(mic.calls).toEqual(["stop"])
})

test("a discarded take hands the microphone back without audio", async () => {
  const mic = fakeRecorder()
  const take = new ParkedTake(async () => mic.recorder)

  take.discard()
  expect(await take.audio).toBeUndefined()
  expect(mic.calls).toEqual(["cancel"])
})

test("a microphone that never opens ends the take without audio instead of failing", async () => {
  const take = new ParkedTake(() => Promise.reject(new Error("microphone")))

  expect(await take.recorder).toBeUndefined()
  take.release()
  expect(await take.audio).toBeUndefined()
})
