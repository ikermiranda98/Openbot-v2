import { usePlatform } from "@/runtime/platform/platform"
import { useSettings } from "@/settings/model"
import { keyFromKeyboardEvent, matchKeybind, parseKeybind } from "@/shell/commands/keybind"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createContext, type JSX } from "solid-js"
import { MicRecorder } from "./dictation-recorder"
import { ParkedTake } from "./parked-take"

// A surface can host the dictation: when one does (a desk panel like the trading chat), the
// hold key answers wherever the focus sits on that surface — `reveal` brings the surface's
// editor forward first, e.g. opening a parked chat and focusing it before the take starts.
export type DictationHost = { reveal: () => void }

export const DictationHostContext = createContext<DictationHost>()

// Hand-off between a desk's own hold listener and the composer its reveal mounts: `take` is the
// parked recording the next hosted composer adopts, and `hosted` counts the composers live under
// a surface host — while one is, the composer handles the key itself.
type DictationMailbox = { take?: ParkedTake; hosted: number }

export const dictationMailbox: DictationMailbox = { hosted: 0 }

/** Whether a keyup lifts part of the hold combo: its key or one of its modifiers. The modifier
    usually leaves first (Ctrl before Space), so the last keyup no longer matches the whole combo;
    any other key let go mid-take (a stray Shift or a typed letter) leaves the hold running. */
export function liftsHold(config: string | undefined, event: KeyboardEvent) {
  const key = keyFromKeyboardEvent(event)

  return parseKeybind(config ?? "").some(
    (combo) =>
      combo.key === key ||
      (combo.ctrl && event.key === "Control") ||
      (combo.meta && event.key === "Meta") ||
      (combo.shift && event.key === "Shift") ||
      (combo.alt && event.key === "Alt"),
  )
}

/** Wrap a surface's content with this to make its dictation hold key focus-free. */
export function DictationSurfaceHost(props: { reveal: () => void; children: JSX.Element }) {
  return <DictationHostContext.Provider value={{ reveal: props.reveal }}>{props.children}</DictationHostContext.Provider>
}

/** Rendered once on the surfacing: takes the hold key wherever the focus sits while no
    composer of the surface is live to handle it, starting the recording right away and
    calling `reveal` so the surface brings its composer up to adopt the take. */
export function DictationHoldListener(props: { reveal: () => void }) {
  const settings = useSettings()
  const platform = usePlatform()

  makeEventListener(
    window,
    "keydown",
    (event) => {
      const config = settings.dictation.keybind()

      if (!config || !matchKeybind(parseKeybind(config), event)) return

      if (dictationMailbox.hosted > 0) return
      // The desk owns the key while it is down: every press — repeats included — is kept from
      // the page (a held Space drips characters or scrolls on the way), the surface reveals
      // itself once, and the take rides the mailbox into the composer the flight brings up.
      event.preventDefault()
      event.stopImmediatePropagation()

      if (event.repeat) return
      dictationMailbox.take?.discard()
      dictationMailbox.take = undefined

      if (platform.voiceDictation && settings.dictation.enabled())
        dictationMailbox.take = new ParkedTake(async () => {
          if (platform.requestMicrophone && !(await platform.requestMicrophone())) throw new Error("microphone")

          return MicRecorder.start()
        })

      props.reveal()
    },
    { capture: true },
  )

  makeEventListener(
    window,
    "keyup",
    (event) => {
      if (liftsHold(settings.dictation.keybind(), event)) dictationMailbox.take?.release()
    },
    { capture: true },
  )

  // A window that loses focus mid-hold never hears the keyup: the parked take counts as released,
  // or its microphone would stay open with no key held.
  makeEventListener(window, "blur", () => dictationMailbox.take?.release())

  return null
}
