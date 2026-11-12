import { Component, Show, createMemo, createResource, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { makeEventListener } from "@solid-primitives/event-listener"
import { Button } from "@opencode/ui/button"
import { Loader } from "@opencode/ui/loader"
import { Select } from "@opencode/ui/select"
import { Switch } from "@opencode/ui/switch"
import { formatKeybind } from "@/shell/commands/command"
import { recordKeybind } from "@/settings/keybinds/keybinds"
import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform, type VoiceDictationModel, type VoiceDictationSurface } from "@/runtime/platform/platform"
import { useSettings } from "@/settings/model"
import { SettingsList } from "@/settings/list"
import { SettingsRow } from "@/settings/row"

// Rows in the shared settings schema; the section only renders where the platform offers dictation.
type ModelOption = { id: string; label: string; group: string }

const megabytes = (bytes: number) => Math.max(1, Math.round(bytes / 1_000_000))

const EnableRow: Component = () => {
  const language = useLanguage()
  const settings = useSettings()

  return (
    <SettingsRow
      title={language.t("settings.dictation.enable.title")}
      description={language.t("settings.dictation.enable.description")}
    >
      <div data-action="settings-dictation-enable">
        <Switch checked={settings.dictation.enabled()} onChange={(checked) => settings.dictation.setEnabled(checked)} />
      </div>
    </SettingsRow>
  )
}

const ModelRow: Component<{ dict: VoiceDictationSurface }> = (props) => {
  const language = useLanguage()
  const settings = useSettings()

  const [models, { refetch }] = createResource(() => props.dict, (dict) => dict.models())
  const loaded = () => models.state === "ready" || models.state === "refreshing"

  const [prepare, setPrepare] = createStore({
    active: undefined as string | undefined,
    stage: "downloading" as "downloading" | "verifying" | "loading" | "ready",
    received: 0,
    total: 0,
  })

  onCleanup(props.dict.onProgress((progress) => setPrepare(progress)))

  const options = createMemo((): ModelOption[] => {
    const rows: readonly VoiceDictationModel[] | undefined = loaded() ? models.latest : undefined
    if (!rows) return []

    const ready = language.t("settings.dictation.model.group.ready")
    const downloadable = language.t("settings.dictation.model.group.download")

    return [
      { id: "auto", label: language.t("settings.dictation.model.automatic"), group: ready },
      ...rows.map((row) => ({
        id: row.id,
        label: row.name,
        group: row.installed ? ready : downloadable,
      })),
    ]
  })

  const selected = createMemo(() => {
    const id = settings.dictation.model()

    return options().find((option) => option.id === id) ?? options()[0]
  })

  const choose = (option: ModelOption | null) => {
    if (!option) return

    settings.dictation.setModel(option.id === "auto" ? undefined : option.id)

    const row = models.latest?.find((model) => model.id === option.id)
    if (!row || row.installed) return

    // Choosing a missing model is the request to download and load it; progress streams under the row.
    setPrepare({ active: option.id, stage: "downloading", received: 0, total: 0 })

    // Preparing shares the helper with transcription: the language defaults there to English too,
    // so hand over the app's primary tag only when the row actually names it.
    const code = language.locale().toLowerCase().split("-")[0]

    void props.dict
      .prepare(option.id, row.languages.includes(code) ? code : undefined)
      .then(() => {
        setPrepare("active", undefined)
        void refetch()
      })
      .catch(() => {
        setPrepare("active", undefined)
        void refetch()
      })
  }

  const progress = () => {
    if (prepare.stage !== "downloading") return language.t("settings.dictation.progress.loading")

    const percent = prepare.total > 0 ? Math.min(100, Math.round((prepare.received / prepare.total) * 100)) : undefined

    if (percent === undefined) return language.t("settings.dictation.progress.loading")

    return language.t("settings.dictation.progress.downloading", {
      percent,
      received: megabytes(prepare.received),
      total: megabytes(prepare.total),
    })
  }

  return (
    <>
      <SettingsRow
        title={language.t("settings.dictation.model.title")}
        description={language.t("settings.dictation.model.description")}
      >
        <Select
          data-action="settings-dictation-model"
          options={options()}
          current={selected()}
          value={(option) => option.id}
          label={(option) => option.label}
          groupBy={(option) => option.group}
          placement="bottom-end"
          gutter={6}
          onSelect={choose}
        />
      </SettingsRow>
      <Show when={prepare.active}>
        <SettingsRow title={language.t("settings.dictation.progress.title")} description={progress()}>
          <Loader />
        </SettingsRow>
      </Show>
    </>
  )
}

const ShortcutRow: Component = () => {
  const language = useLanguage()
  const settings = useSettings()
  const [store, setStore] = createStore({ recording: false })

  const stop = () => setStore("recording", false)

  const handle = (event: KeyboardEvent) => {
    if (!store.recording) return
    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()

    if (event.key === "Escape") return stop()

    if (event.key === "Backspace" || event.key === "Delete") {
      // Cleared through the established "none" value: the default fallback would resurrect Control+Space.
      settings.dictation.setKeybind("none")
      return stop()
    }

    const next = recordKeybind(event)
    if (!next) return
    settings.dictation.setKeybind(next)
    stop()
  }

  makeEventListener(document, "keydown", handle, { capture: true })

  const label = () => {
    if (store.recording) return language.t("settings.shortcuts.pressKeys")

    const keybind = settings.dictation.keybind()

    return keybind && keybind !== "none" ? formatKeybind(keybind, language.t) : language.t("settings.shortcuts.unassigned")
  }

  return (
    <SettingsRow
      title={language.t("settings.dictation.shortcut.title")}
      description={language.t("settings.dictation.shortcut.description")}
    >
      <Button
        type="button"
        size="small"
        variant={store.recording ? "ghost-danger" : "ghost"}
        data-action="settings-dictation-shortcut"
        onClick={() => (store.recording ? stop() : setStore("recording", true))}
      >
        {label()}
      </Button>
    </SettingsRow>
  )
}

/** The dictation section; it exists only where the platform bundles the local transcription helper. */
export const VoiceDictationSetting: Component = () => {
  const platform = usePlatform()
  const language = useLanguage()

  return (
    <Show when={platform.voiceDictation} keyed fallback={null}>
      {(dict) => (
        <section class="settings-section" aria-label={language.t("settings.dictation.title")}>
          <h3 class="settings-section-title">{language.t("settings.dictation.title")}</h3>
          <SettingsList>
            <EnableRow />
            <ModelRow dict={dict} />
            <ShortcutRow />
          </SettingsList>
        </section>
      )}
    </Show>
  )
}
