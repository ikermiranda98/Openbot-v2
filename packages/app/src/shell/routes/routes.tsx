import { Navigate, Route, useParams } from "@solidjs/router"
import { createMemo, lazy, Show, type ParentProps } from "solid-js"
import { ServerProvider } from "@/runtime/server/current"
import { useGlobal } from "@/runtime/server/runtime"
import { ServerConnection, useServers } from "@/runtime/server/registry"
import { isServerUnauthorized } from "@/runtime/server/health-machine"
import { SessionPanelFrame } from "@/session/session-frame"
import { ServerSignedOutPanel } from "@/session/server-unavailable-panel"
import { LayoutProvider } from "@/shell/state/layout"
import { SettingsSurfaceProvider } from "@/settings/surface"
import Shell from "@/shell/shell"
import { requireServerKey } from "./session"
import { PluginAttachment } from "@/runtime/plugin/root"

export const File = lazy(() => import("@opencode/session-ui/file").then((module) => ({ default: module.File })))

const SettingsScreen = lazy(() => import("@/settings/shell").then((module) => ({ default: module.SettingsScreen })))

const ConnectServerScreen = lazy(() =>
  import("@/servers/connect/screen").then((module) => ({ default: module.ConnectServerScreen })),
)

const TradingRouter = lazy(() => import("@/trading/route").then((module) => ({ default: module.TradingRouter })))

const TradingWithSession = lazy(() => import("@/trading/route").then((module) => ({ default: module.TradingWithSession })))

export function preloadRoute(url: string) {
  const pathname = url.split(/[?#]/, 1)[0]

  if (pathname === "/settings") return SettingsScreen.preload().then(() => undefined)

  if (/^\/trading\/[^/]+\/[^/]+$/.test(pathname)) return TradingWithSession.preload().then(() => undefined)

  // Every other path lands on the desk.
  return TradingRouter.preload().then(() => undefined)
}

/** Openbot is the trading desk alone: every surface that is not the dashboard (Home, the
 * coding sessions, drafts) lands on the desk instead. Settings stays — the desk's chat needs
 * its model and provider configured there. */
const AlEscritorio = () => <Navigate href="/trading" />

export function AppRoutes() {
  return (
    <Route component={AppLayout}>
      <Route path="/" component={AlEscritorio} />
      {/* `/trading` redirects itself to `/trading/<server>/new`: the desk lands there, and the
          section creates no chat — the dedicated chat boots only when its pane opens. */}
      <Route path="/trading" component={TradingRouter} />
      <Route
        path="/trading/:serverKey/:id"
        component={() => (
          <TargetServerRoute>
            <TradingWithSession />
          </TargetServerRoute>
        )}
      />
      <Route path="/settings" component={SettingsScreen} />
      <Route path="/server/:serverKey/session/:id" component={AlEscritorio} />
      <Route path="/new-session" component={AlEscritorio} />
      <Route path="*" component={AlEscritorio} />
    </Route>
  )
}

function TargetServerRoute(props: ParentProps) {
  const params = useParams<{ serverKey: string }>()
  const global = useGlobal()

  const connection = createMemo(() =>
    global.servers.list().find((item) => ServerConnection.key(item) === requireServerKey(params.serverKey)),
  )

  return (
    <Show when={connection()} keyed>
      {(connection) => (
        <ServerProvider
          conn={connection}
          signedOut={
            <div class="flex min-h-0 flex-1 px-[var(--shell-inline-inset,8px)] pb-[var(--shell-bottom-inset,8px)] pt-[var(--shell-top-inset,8px)]">
              <SessionPanelFrame raised>
                <ServerSignedOutPanel conn={connection} />
              </SessionPanelFrame>
            </div>
          }
        >
          {props.children}
        </ServerProvider>
      )}
    </Show>
  )
}

function AppLayout(props: ParentProps) {
  const servers = useServers()
  const global = useGlobal()

  // A lone server that rejects our credentials (e.g. the web app before pairing) has nothing else to show.
  const signedOut = () => {
    const only = servers.list.length === 1 ? servers.list[0] : undefined

    if (only?.type !== "http") return

    return isServerUnauthorized(global.servers.health[ServerConnection.key(only)]) ? only : undefined
  }

  return (
    <Show when={servers.list.length > 0 && !signedOut()} fallback={<ConnectServerScreen url={signedOut()?.http.url} />}>
      <LayoutProvider>
        <SettingsSurfaceProvider>
          <PluginAttachment>
            <Shell>{props.children}</Shell>
          </PluginAttachment>
        </SettingsSurfaceProvider>
      </LayoutProvider>
    </Show>
  )
}
