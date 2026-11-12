import { IconButton } from "@opencode/ui/icon-button"
import { Keybind } from "@opencode/ui/keybind"
import { Tooltip } from "@opencode/ui/tooltip"
import { formatKeybindParts, matchKeybind, parseKeybind } from "@/shell/commands/command"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createContext, createResource, onCleanup, onMount, Show, useContext, type Accessor, type ParentProps } from "solid-js"
import { dictationMailbox, DictationHost, DictationHostContext, liftsHold } from "./dictation-host"
import { PARKED_TAKE_TTL_MS, type ParkedTake } from "./parked-take"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform, type VoiceDictationSurface, type VoiceModelPreparation } from "@/runtime/platform/platform"
import { useSettings } from "@/settings/model"
import { Ring } from "@/usage/ring"
import { MicRecorder } from "./dictation-recorder"
import "./voice.css"

type Phase = "idle" | "recording" | "downloading" | "transcribing"

// The model warm-up runs once per app session, a moment after the first composer settles so it
// never competes with the window's own start.
let warmed = false

const WARM_DELAY_MS = 1_500

// The main process hands a failed job across the bridge as a defect whose message carries the
// engine's verdict (`VoiceEngine.describeError`): codes with a fix the user can act on get their
// own copy, everything else the generic failure.
const RESOLVABLE_FAILURES: Record<string, "dictation.failure.modelLoad"> = {
  "model-prepare-failed": "dictation.failure.modelLoad",
}

const failureKey = (error: unknown) => {
  const verdict =
    error instanceof Error && error.cause instanceof Error ? error.cause.message : error instanceof Error ? error.message : undefined

  return (verdict ? RESOLVABLE_FAILURES[verdict] : undefined) ?? "dictation.failure"
}

// The composer provides these; the bar button renders wherever the composer places it.
type DictationControls = {
  /** Platform support, the enable switch and a ready engine status all hold. */
  visible: Accessor<boolean>
  /** Transient failure copy; lives only a few seconds for the tooltip to show. */
  failure: Accessor<string | undefined>
  /** The model preparation in flight, from the engine's own progress events; undefined when none.
   * The engine's terminal stage clears it, so no surface's ring waits on another's promise. */
  prepare: Accessor<VoiceModelPreparation | undefined>
  busy: Accessor<boolean>
  /** The take's own download wait, before the engine's first event arrives. */
  downloading: Accessor<boolean>
  recording: Accessor<boolean>
  press: (event: PointerEvent & { currentTarget: HTMLElement }) => void
  release: () => void
  /** Wires the wave element the hold animates; the live level writes a CSS var, never a signal. */
  bindWave: (element: SVGSVGElement) => void
  /** Tooltip key parts for the hold key; empty when no key is assigned. */
  keys: Accessor<string[]>
  /** The hold key speaks through these capture listeners while the composer scope has focus. */
  onKeyDown: (event: KeyboardEvent) => void
  onKeyUp: (event: KeyboardEvent) => void
  onBlur: () => void
}

const Dictation = createContext<DictationControls>()

// One press records the whole take; release hands the file to the local model and inserts the words.
// The same holds work for the configured keyboard shortcut while the composer has focus.
export function DictationComposer(props: ParentProps<{ insert: (text: string) => void; readOnly?: boolean }>) {
  let scope: HTMLDivElement | undefined
  const host = useContext(DictationHostContext)
  const controls = createDictationControls(props, () => scope, host)

  // The hold key owns the key while it is down: capture intercepts the editor's own handlers.
  makeEventListener(window, "keydown", controls.onKeyDown, { capture: true })
  makeEventListener(window, "keyup", controls.onKeyUp, { capture: true })
  makeEventListener(window, "blur", controls.onBlur)

  return (
    <div ref={(element) => (scope = element)}>
      <Dictation.Provider value={controls}>{props.children}</Dictation.Provider>
    </div>
  )
}

function createDictationControls(
  props: { insert: (text: string) => void; readOnly?: boolean },
  scope: () => HTMLElement | undefined,
  host?: DictationHost,
): DictationControls {
  const language = useLanguage()
  const platform = usePlatform()
  const settings = useSettings()

  const [status] = createResource(() => platform.voiceDictation, (dict) => dict?.available() ?? Promise.resolve(false))

  const [state, setState] = createStore({
    phase: "idle" as Phase,
    failure: undefined as string | undefined,
    prepare: undefined as VoiceModelPreparation | undefined,
  })

  let active: VoiceDictationSurface | undefined
  let held: MicRecorder | undefined
  let releaseQueued = false
  let keyboardHeld = false
  let failureTimer: ReturnType<typeof setTimeout> | undefined
  let wave: SVGSVGElement | undefined
  let riding = 0
  let level = 0
  let disposed = false

  onCleanup(() => {
    disposed = true
    clearTimeout(failureTimer)
    cancelAnimationFrame(riding)
    held?.cancel()
  })

  // The engine loads a model's weights on its first job (seconds on a cold start), so the first
  // composer with dictation on warms the model the takes will use, once per app session, in the
  // background: a chosen-but-missing model downloads here too, so Parakeet v3 is ready before the
  // first take needs it. A failed warm-up changes nothing; the take still prepares itself.
  onMount(() => {
    const dict = platform.voiceDictation

    // Progress rides every prepare the engine runs — the warm-up below, a take's own, one the
    // Settings page started — and the engine's terminal stage clears it: the button's ring
    // reads them all without waiting on another surface's promise.
    if (dict && settings.dictation.enabled()) {
      onCleanup(dict.onProgress((progress) => setState("prepare", progress.stage === "ready" ? undefined : progress)))
    }

    if (!dict || warmed || !settings.dictation.enabled()) return
    warmed = true

    const timer = setTimeout(() => {
      void dict
        .available()
        .then((available) => (available ? chooseModel(dict) : undefined))
        .then((choice) => (choice ? dict.prepare(choice.id, choice.language) : undefined))
        .catch(() => undefined)
    }, WARM_DELAY_MS)

    onCleanup(() => clearTimeout(timer))
  })

  // The engine transcribes installed rows only, but nothing installed is not a dead end: an
  // explicit pick (or, on Automatic, the catalog row covering the app's language) downloads right
  // then, so the first take or the warm-up brings Parakeet v3 down instead of failing with "no
  // model". An app language no catalog row covers keeps the old dead end: downloading hundreds of
  // megabytes to transcribe a language the model does not know serves nobody.
  const chooseModel = async (dict: VoiceDictationSurface) => {
    const rows = await dict.models()
    const code = language.locale().toLowerCase().split("-")[0]
    const chosen = settings.dictation.model()

    const row =
      (chosen ? rows.find((model) => model.id === chosen) : undefined) ??
      rows.find((model) => model.installed && model.languages.includes(code)) ??
      rows.find((model) => model.installed && model.languages.includes("*")) ??
      rows.find((model) => model.installed) ??
      rows.find((model) => model.languages.includes(code)) ??
      rows.find((model) => model.languages.includes("*"))

    return row
      ? { id: row.id, language: row.languages.includes(code) ? code : undefined, download: !row.installed }
      : undefined
  }

  // Under a surface host this composer handles the key itself while it lives; until it mounts,
  // the desk's own listener records the take (see ParkedTake) and this mount adopts it: still
  // held, the microphone keeps listening and the key's release ends the take here; already
  // released, the captured words transcribe straight into the editor the chat brought up.
  if (host) {
    dictationMailbox.hosted++
    onCleanup(() => dictationMailbox.hosted--)
  }

  onMount(() => {
    const take = dictationMailbox.take

    if (!host || !take) return
    dictationMailbox.take = undefined

    if (Date.now() - take.at > PARKED_TAKE_TTL_MS) return take.discard()
    adopt(take)
  })

  const adopt = (take: ParkedTake) => {
    const dict = platform.voiceDictation

    if (!dict || props.readOnly || state.phase !== "idle") return take.discard()
    // The reveal focused nothing when it ran (there was no editor yet): it focuses this one.
    host?.reveal()
    active = dict
    releaseQueued = false
    held = undefined
    setState({ phase: "recording", failure: undefined })
    startRide()

    if (take.audio) return void settleAudio(take.audio)
    keyboardHeld = true
    void take.recorder.then(started)
  }

  const fail = (message: string) => {
    endRide()
    setState({ phase: "idle", failure: message })
    clearTimeout(failureTimer)
    failureTimer = setTimeout(() => setState("failure", undefined), 4_000)
  }

  // While the take runs, a rAF loop eases the recorder's low-band estimate into a CSS var the wave
  // scales with — plain DOM writes, because a store update per frame would re-render what the user
  // never reads through Solid.
  const ride = () => {
    level += 0.35 * ((held?.bass() ?? 0) - level)
    wave?.style.setProperty("--voice-bass", level.toFixed(4))
    riding = requestAnimationFrame(ride)
  }

  const startRide = () => {
    if (riding) return
    level = 0
    riding = requestAnimationFrame(ride)
  }

  const endRide = () => {
    if (!riding) return
    cancelAnimationFrame(riding)
    riding = 0
    wave?.style.setProperty("--voice-bass", "0")
  }

  // Shared by the held button (pointer) and the hold key: recording starts here and ends with
  // `release`.
  const beginHold = () => {
    const dict = platform.voiceDictation

    if (!dict || props.readOnly || state.phase !== "idle") return
    active = dict
    releaseQueued = false
    held = undefined
    setState({ phase: "recording", failure: undefined })
    startRide()
    void arm()
  }

  const press = (event: PointerEvent & { currentTarget: HTMLElement }) => {
    if (!platform.voiceDictation || props.readOnly || state.phase !== "idle") return
    event.currentTarget.setPointerCapture(event.pointerId)
    beginHold()
  }

  const release = () => {
    if (state.phase !== "recording") return

    const recorder = held

    if (recorder) {
      held = undefined
      releaseQueued = false
      void settle(recorder)

      return
    }

    releaseQueued = true
  }

  const arm = async () => {
    const dict = active

    if (!dict) return

    const recorder = await (async () => {
      const granted = platform.requestMicrophone ? await platform.requestMicrophone() : true

      if (!granted) throw new Error("microphone")

      return MicRecorder.start()
    })().catch(() => undefined)

    started(recorder)
  }

  // A recorder arrived, for a take this composer started or one it adopted from the mailbox.
  const started = (recorder: MicRecorder | undefined) => {
    if (!recorder) return fail(language.t("dictation.failure.microphone"))

    // The composer may die while the permission sheet or the device open is pending: the
    // recorder that arrived trains on nobody, so hand the microphone back instead of parking
    // its stream on a component that can no longer release it.
    if (disposed) return recorder.cancel()

    if (releaseQueued) {
      releaseQueued = false

      return void settle(recorder)
    }

    held = recorder
  }

  const settle = async (recorder: MicRecorder) => {
    const dict = active

    active = undefined
    held = undefined
    releaseQueued = false
    endRide()

    if (!dict) return recorder.cancel()

    setState("phase", "transcribing")

    try {
      await transcribe(dict, recorder.stop().audio)
    } catch (error) {
      fail(language.t(failureKey(error)))
    }
  }

  // An adopted take released before this composer mounted: its audio is already captured.
  const settleAudio = async (pending: Promise<Uint8Array<ArrayBuffer> | undefined>) => {
    const dict = active

    active = undefined
    endRide()

    if (!dict) return

    setState("phase", "transcribing")

    try {
      const audio = await pending

      if (!audio) return fail(language.t("dictation.failure.microphone"))
      await transcribe(dict, audio)
    } catch (error) {
      fail(language.t(failureKey(error)))
    }
  }

  const transcribe = async (dict: VoiceDictationSurface, audio: Uint8Array<ArrayBuffer>) => {
    const choice = await chooseModel(dict)

    if (!choice) return fail(language.t("dictation.failure.model"))

    // A chosen-but-missing model downloads first: the take waits on the weights it needs, and the
    // tooltip names the wait instead of pretending to transcribe. A download the warm-up already
    // runs resolves the same job, so this never starts a second one.
    if (choice.download) {
      setState("phase", "downloading")
      await dict.prepare(choice.id, choice.language)
      setState("phase", "transcribing")
    }

    const { transcript } = await dict.transcribe(audio, choice.id, choice.language)
    const text = transcript.replace(/\r\n?/g, "\n")

    if (text) props.insert(text)
    setState({ phase: "idle", failure: undefined })
  }

  const focusedInsideScope = () => {
    const element = scope()

    return !!element && element.contains(document.activeElement)
  }

  return {
    visible: () =>
      !!platform.voiceDictation &&
      settings.dictation.enabled() &&
      (status.state === "ready" || status.state === "refreshing") &&
      !!status.latest,
    failure: () => state.failure,
    prepare: () => state.prepare,
    busy: () => state.phase === "transcribing" || state.phase === "downloading",
    downloading: () => state.phase === "downloading",
    recording: () => state.phase === "recording",
    press,
    release,
    bindWave: (element) => {
      wave = element
    },
    keys: () => formatKeybindParts(settings.dictation.keybind() ?? "", language.t),
    onKeyDown: (event: KeyboardEvent) => {
      const config = settings.dictation.keybind()

      if (!config || !matchKeybind(parseKeybind(config), event)) return
      const inside = focusedInsideScope()

      // Without a host the key stays the screen's when the composer can't take it; with one the
      // hold answers wherever the focus sits — the host reveals its editor first (a parked
      // trading chat opens and focuses before the take starts). Either way every press of the
      // combo while it is down belongs to the hold: repeats drip Space characters into the
      // editor otherwise, held or not.
      if (!inside && !host) return
      event.preventDefault()
      event.stopImmediatePropagation()

      if (event.repeat || props.readOnly || state.phase !== "idle") return

      if (!inside) host?.reveal()
      keyboardHeld = true
      beginHold()
    },
    onKeyUp: (event: KeyboardEvent) => {
      // Only lifting the combo itself ends the take (its key or a modifier, whichever leaves
      // first); another key let go mid-take leaves the microphone listening.
      if (!keyboardHeld || !liftsHold(settings.dictation.keybind(), event)) return
      keyboardHeld = false
      release()
    },
    onBlur: () => {
      if (!keyboardHeld) return
      keyboardHeld = false
      release()
    },
  } satisfies DictationControls
}

/** The hold-to-dictate button; renders nothing unless the surrounding composer provides dictation. */
export function DictationButton() {
  return (
    <Show when={useContext(Dictation)} keyed fallback={null}>
      {(controls) => <ControlButton controls={controls} />}
    </Show>
  )
}

function ControlButton(props: { controls: DictationControls }) {
  const language = useLanguage()

  // The model's own preparation drives the ring: the download's share fills the arc, the
  // verify/load stages hand the comet the loop, and the engine's terminal stage clears it.
  const prepare = () => props.controls.prepare()

  const percent = () => {
    const progress = prepare()

    return progress?.stage === "downloading" && progress.total && progress.received !== undefined
      ? Math.min(100, Math.round((progress.received / progress.total) * 100))
      : undefined
  }

  // The tooltip's line: the failure first, then the preparation's own share, then the take's
  // phases, then the hold's hint with its key.
  const tooltip = () => {
    if (props.controls.failure()) return <>{props.controls.failure()}</>

    const share = percent()

    if (share !== undefined || props.controls.downloading()) {
      return <>{language.t("dictation.downloading", { percent: share ?? 0 })}</>
    }

    if (prepare()) return <>{language.t("dictation.loading")}</>
    if (props.controls.busy()) return <>{language.t("dictation.transcribing")}</>
    if (props.controls.recording()) return <>{language.t("dictation.recording")}</>

    return (
      <>
        {language.t("dictation.hint")}
        <Show when={props.controls.keys().length}>
          <Keybind keys={props.controls.keys()} variant="neutral" />
        </Show>
      </>
    )
  }

  return (
    <Show when={props.controls.visible()} fallback={null}>
      {/* Icon-only in the composer's bar: the phases, failures and preparation live in the
          tooltip, the hold state on the pressed style, the name on the accessible label. */}
      <Tooltip placement="top" value={tooltip()}>
        <IconButton
          type="button"
          variant="ghost-muted"
          size="large"
          icon={
            <Show when={prepare()} fallback={<Wave bind={props.controls.bindWave} />}>
              {(progress) => <Ring progress={percent() ?? 100} color="var(--v2-state-fg-info)" comet={progress().stage !== "downloading"} />}
            </Show>
          }
          class="me-3 voice-dictation-action"
          disabled={props.controls.busy()}
          // Any running take wears the pressed look, the held key's as much as the pointer's: a
          // shortcut hold has no other sign on screen that the microphone is listening.
          state={props.controls.recording() ? "pressed" : undefined}
          aria-label={language.t("dictation.button")}
          aria-pressed={props.controls.recording()}
          // The hold starts on the pointer; the caret stays in the editor it will write into.
          onMouseDown={(event) => event.preventDefault()}
          onPointerDown={props.controls.press}
          onPointerUp={props.controls.release}
          onPointerCancel={props.controls.release}
        />
      </Tooltip>
    </Show>
  )
}

// The catalog waveform icon (M2 7V9M4.5 5V11M7 2.5V13.5M9.5 4.5V11.5M12 6V10M14.5 7.25V8.75,
// stroke 1.5, round caps — i.e. six 1.5-wide pills centered on those x's, each as tall as its
// segment plus the two caps), drawn as rects the live level animates through its geometry: the
// resting shape is the exact catalog icon, and the loudest voice lands the tiers at
// 7/12/15/13/10/6, every bar inside the 16px box.
const WAVE_BARS: Array<{ x: number; height: number; reach: number }> = [
  { x: 1.25, height: 3.5, reach: 1 },
  { x: 3.75, height: 7.5, reach: 0.6 },
  { x: 6.25, height: 12.5, reach: 0.2 },
  { x: 8.75, height: 8.5, reach: 0.53 },
  { x: 11.25, height: 5.5, reach: 0.82 },
  { x: 13.75, height: 3, reach: 1 },
]

function Wave(props: { bind: (element: SVGSVGElement) => void }) {
  return (
    <svg ref={props.bind} class="voice-dictation-wave" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      {WAVE_BARS.map((bar) => (
        <rect x={bar.x} rx="0.75" style={{ "--wave-base": `${bar.height}px`, "--wave-reach": `${bar.reach}` }} />
      ))}
    </svg>
  )
}
