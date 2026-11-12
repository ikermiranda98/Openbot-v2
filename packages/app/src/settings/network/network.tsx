import { Component, createEffect, createMemo, For, onCleanup, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { GhostRun, GhostStatus } from "@opencode/client/promise"
import { Button } from "@opencode/ui/button"
import { Switch } from "@opencode/ui/switch"
import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform } from "@/runtime/platform/platform"
import { useGlobal } from "@/runtime/server/runtime"
import { ServerConnection, useServers } from "@/runtime/server/registry"
import { useCommand } from "@/shell/commands/command"
import { ROTATE_COMMAND } from "@/usage/rotation"
import { useSettings } from "@/settings/model"
import { SettingsList } from "@/settings/list"
import { SettingsRow } from "@/settings/row"
import "@/settings/settings.css"

// The page reads the engine only while it is open.
const REFRESH_MS = 2_000

const WARP_DOWNLOAD = "https://one.one.one.one/"

const WARP_LABEL = {
  connected: "settings.network.warp.connected",
  disconnected: "settings.network.warp.disconnected",
  unavailable: "settings.network.warp.unavailable",
  missing: "settings.network.warp.missing",
} as const

const ORIGIN_LABEL = {
  manual: "settings.network.origin.manual",
  auto: "settings.network.origin.auto",
  limit: "settings.network.origin.limit",
} as const

/** IPv6 and WARP: the ring's rotation settings, WARP's state, and the day's rotations. */
export const SettingsNetwork: Component<{ active: boolean }> = (props) => {
  const language = useLanguage()
  const settings = useSettings()
  const platform = usePlatform()
  const servers = useServers()
  const global = useGlobal()
  const command = useCommand()
  const [state, setState] = createStore<{ status?: GhostStatus; runs?: GhostRun[] }>({})

  // This machine's engine lives on the app's own server.
  const engine = () => {
    const conn = servers.visible.find(ServerConnection.builtin) ?? servers.visible[0]

    return conn ? global.serverCtx(ServerConnection.key(conn))?.sdk.api.experimental.ghost : undefined
  }

  const refresh = async () => {
    const api = engine()

    if (!api) return

    const [status, runs] = await Promise.all([api.status().catch(() => undefined), api.history().catch(() => undefined)])

    // The engine keeps every run, oldest first; the page lists today's, newest first. Reconciled by
    // the run's time so the rows already shown stay mounted across polls instead of redrawing.
    const desde = new Date().setHours(0, 0, 0, 0)
    const hoy = runs?.filter((run) => run.at >= desde).toReversed()

    setState("status", status)
    setState("runs", reconcile(hoy, { key: "at" }))
  }

  createEffect(() => {
    if (!props.active) return

    void refresh()
    const timer = setInterval(() => void refresh(), REFRESH_MS)
    onCleanup(() => clearInterval(timer))
  })

  const hora = createMemo(
    () => new Intl.DateTimeFormat(language.intl(), { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
  )

  const segundos = createMemo(() =>
    new Intl.NumberFormat(language.intl(), { style: "unit", unit: "second", maximumFractionDigits: 0 }),
  )

  const warpState = () => state.status?.warp

  return (
    <>
      <div class="settings-tab-header">
        <div class="settings-tab-header-row">
          <div class="flex flex-col gap-1">
            <h2 class="settings-tab-title">{language.t("settings.tab.network")}</h2>
            <span class="text-11-regular text-v2-text-text-muted">{language.t("settings.network.description")}</span>
          </div>
        </div>
      </div>

      <div class="settings-tab-body settings-tab-body--sectioned">
        <div class="settings-section">
          <h3 class="settings-section-title">{language.t("settings.network.section.rotation")}</h3>
          <SettingsList>
            <SettingsRow
              title={language.t("settings.network.auto.title")}
              description={language.t("settings.network.auto.description")}
            >
              <div data-action="settings-network-auto">
                <Switch checked={settings.rotation.auto()} onChange={(checked) => settings.rotation.setAuto(checked)} />
              </div>
            </SettingsRow>

            <SettingsRow
              title={language.t("settings.network.notify.title")}
              description={language.t("settings.network.notify.description")}
            >
              <div data-action="settings-network-notify">
                <Switch checked={settings.rotation.notify()} onChange={(checked) => settings.rotation.setNotify(checked)} />
              </div>
            </SettingsRow>
          </SettingsList>
        </div>

        <div class="settings-section">
          <h3 class="settings-section-title">{language.t("settings.network.section.today")}</h3>
          <SettingsList>
            <SettingsRow
              title={language.t("settings.network.warp.title")}
              description={warpState() ? language.t(WARP_LABEL[warpState()!]) : "…"}
            >
              <div data-action="settings-network-warp">
                <Show
                  when={warpState() === "missing"}
                  fallback={
                    <Button
                      size="small"
                      variant="neutral"
                      disabled={!state.status || state.status.rotating}
                      onClick={() => command.trigger(ROTATE_COMMAND.id)}
                    >
                      {state.status?.rotating
                        ? language.t("settings.network.rotating", {
                            attempt: String(state.status.attempt ?? 1),
                            attempts: String(state.status.attempts),
                          })
                        : language.t("settings.network.rotate")}
                    </Button>
                  }
                >
                  <Button size="small" variant="neutral" onClick={() => platform.openExternal(WARP_DOWNLOAD)}>
                    {language.t("settings.network.warp.install")}
                  </Button>
                </Show>
              </div>
            </SettingsRow>

            <SettingsRow
              title={language.t("settings.network.rotations.title")}
              description={
                state.status?.current
                  ? language.t("settings.network.rotations.current", { bucket: state.status.current })
                  : language.t("settings.network.rotations.none")
              }
            >
              <span data-action="settings-network-rotations" class="text-13-medium tabular-nums text-v2-text-text-base">
                {state.status?.rotations ?? "—"}
              </span>
            </SettingsRow>
          </SettingsList>
        </div>

        <div class="settings-section">
          <h3 class="settings-section-title">{language.t("settings.network.section.history")}</h3>
          <SettingsList>
            <Show
              when={state.runs && state.runs.length > 0}
              fallback={
                <SettingsRow title={language.t("settings.network.history.empty")} description="">
                  {null}
                </SettingsRow>
              }
            >
              <For each={state.runs}>
                {(run) => (
                  <SettingsRow
                    title={`${hora().format(run.at)} · ${language.t(ORIGIN_LABEL[run.origin])}`}
                    description={[
                      run.ok
                        ? language.t("settings.network.history.moved", { from: run.from ?? "—", to: run.to ?? "—" })
                        : language.t("settings.network.history.failed"),
                      language.t("settings.network.history.attempts", { count: String(run.attempts) }),
                      segundos().format(run.durationMs / 1000),
                    ].join(" · ")}
                  >
                    <span
                      class="text-13-medium"
                      classList={{
                        "text-v2-state-fg-success": run.ok,
                        "text-v2-state-fg-danger": !run.ok,
                      }}
                    >
                      {language.t(run.ok ? "settings.network.history.ok" : "settings.network.history.error")}
                    </span>
                  </SettingsRow>
                )}
              </For>
            </Show>
          </SettingsList>
        </div>
      </div>
    </>
  )
}
