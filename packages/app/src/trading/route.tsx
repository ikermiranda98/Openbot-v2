// The trading dashboard: a fullscreen app view (like Home) fed by the Engine's
// local HTTP snapshot, falling back to sample data until the Engine answers,
// sitting side by side with a dedicated chat pane the user opens themselves. Trading
// is separate from the chats: opening the section (or toggling between sections) creates
// nothing — no session, no chat entry anywhere. The pane's first open in this app run
// boots the ephemeral desk chat: it sweeps past runs' marked sessions off the server,
// creates a fresh marked one and seeds its standing instructions. A restart never
// resumes one; the next pane open starts empty again. The session's metadata mark
// keeps it out of every chat surface (Home's sidebar, the command palette, session
// search and the composer's session references), so the chats and the desk never mix.
// Theme via the app's v2 tokens only; copy via i18n keys.

import { For, Show, Suspense, createEffect, createMemo, createSignal, lazy, on, onCleanup, onMount, type Accessor, type JSX } from "solid-js"
import { Title } from "@solidjs/meta"
import { useNavigate, useParams } from "@solidjs/router"
import { Schema } from "effect"
import { createStore, reconcile } from "solid-js/store"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createMediaQuery } from "@solid-primitives/media"
import { ServerConnection, useServers } from "@/runtime/server/registry"
import { useData, useServer } from "@/runtime/server/current"
import { useServerSDK } from "@/runtime/server/client"
import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform } from "@/runtime/platform/platform"
import { useLayout, sessionPanelWidthDefault } from "@/shell/state/layout"
import { createPanelMotion, guardClosingFocus, holdLandingWidth, panelOpacity } from "@/shell/panel-motion"
import { Persistence } from "@/runtime/persistence/schema"
import { Persist, persisted } from "@/runtime/persistence/storage"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Button } from "@opencode/ui/button"
import { TextInput } from "@opencode/ui/text-input"
import { Textarea } from "@opencode/ui/textarea"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { useDialog } from "@opencode/ui/context/dialog"
import { Loader } from "@opencode/ui/loader"
import { ResizeHandle } from "@opencode/ui/resize-handle"
import { Switch } from "@opencode/ui/switch"
import { Tooltip } from "@opencode/ui/tooltip"
import { fijarNavArbol, type FilaRegistroNav } from "./nav-estado"
import { claimRowReserve } from "@/shell/row-reserve"
import { ListaRegistro, textoVeredicto } from "./registro"
import { useFormatos } from "./formatos"
import { requireServerKey, tradingHref, tradingNewHref } from "@/shell/routes/session"
import { showToast } from "@/shell/notifications/toast"
import { errorMessage } from "@/shell/layout/helpers"
import { SessionPanelFrame } from "@/session/session-frame"
import { DictationHoldListener, DictationSurfaceHost } from "@/voice/dictation-host"
import { useSettingsCommand } from "@/settings/command"
import {
  PANE_GAP,
  TRADING_CHAT_WIDTH_FLOOR,
  TRADING_CHAT_WIDTH_MIN,
  TRADING_DASH_WIDTH_MIN,
  TRADING_ROW_WIDTH_MIN,
} from "@/session/session-panel-width"

// The session route itself stays out of the trading module graph: the dashboard's first open
// must not pay for the chat chunk (which also drags the File viewer). It loads on its own,
// behind a Suspense boundary, only once this run's dedicated chat resolves and takes the pane.
const TargetSessionRouteContent = lazy(() =>
  import("@/session/route").then((module) => ({ default: module.TargetSessionRouteContent })),
)

import { isTradingSession, scanTradingSessions, TRADING_DESK_CONTEXT, TRADING_METADATA_MARK, TRADING_SESSION_WINDOW } from "./session"
import { uuid } from "@opencode/util/uuid"
import { Trading } from "@opencode/schema/trading"
import "./trading.css"
import { DEMO, REFRESCO_MS, añadirEnlace, detectarPuertosIbkr, elegirCarpetaSistemas, arrancarSistema, cerrarPosicion, cerrarTotal, conectarCuenta, desconectarCuenta, panicoTotal, pararSistema, pedirSnapshot, programarTarea, quitarEnlace, seleccionarCuenta, type BotInfo, type CurvaInfo, type RegistroInfo, type SnapshotMotor, type TradeInfo } from "./motor"
import { nombreLegible, TradingNavStrip } from "./nav"

/** The trading panel's Intl formatter set lives in `./formatos` now — the nav's light
 * modules read it beside the route. */

/** `-0.16%`-style signed percentage, or a dash when the engine received no value. */
const formatoPct = (valor: number | null) => (valor === null || !Number.isFinite(valor) ? "—" : `${Number(valor.toFixed(2))}%`)

/** Day-aware stamp allowing nulls: null and broken timestamps read as "—" (the engine sent no time yet). */
function momentoNulo(ts: number | null | undefined, formato: (ts: number) => string) {
  return ts === null || ts === undefined ? "—" : formato(ts)
}

const LINEA = { "line-height": "var(--line-height-compact)" } as const

/** The empty chat's starter questions: read-only ones, so a click never heads toward a write. */
const SUGERENCIAS_CHAT = [
  "trading.chat.suggest.day",
  "trading.chat.suggest.systems",
  "trading.chat.suggest.trades",
  "trading.chat.suggest.positions",
] as const

const ChatLayout = Persistence.struct({
  chatWidth: Persistence.optional(Schema.Finite),
})

// Whether the chat pane is open. It lives for this app run only, like the dedicated chat
// itself: every launch opens the desk with the chat hidden, and the chat's session only
// boots when the user opens the pane (or dictation holds it open) — never on entering
// the section. Switching to another section and back within the run keeps the choice.
const [chatAbierto, fijarChatAbierto] = createSignal(false)

// The URL id of the dedicated chat before it is resolved.
const PENDING = "new"

function tonoPnl(valor: number | null) {
  if (valor === null) return "text-v2-text-text-muted"

  if (valor > 0) return "text-v2-state-fg-success"

  if (valor < 0) return "text-v2-state-fg-danger"

  return "text-v2-text-text-base"
}

/** A KPI tile's direction glyph: ▲ on profit, ▼ on loss, blank on flat or unknown. The
 * trailing space separates it from the value it rides in front of. */
function flechaPnl(valor: number | null) {
  if (valor === null || valor === 0) return ""

  return valor > 0 ? "▲ " : "▼ "
}

const NÚMERO = "text-[13px] tabular-nums"

/** The positions table's column grid, shared by its caption row and every position row:
 * symbol, side, size, entry, current, P/L, %, system, the close button's slot. Under 640px of
 * table (the chat open beside a narrow desk) the entry and system columns step out, so the
 * figures that decide — current, P/L, % — never clip. */
const COLUMNAS_POSICIÓN =
  "grid grid-cols-[minmax(56px,1fr)_40px_32px_minmax(80px,1fr)_minmax(64px,1fr)_48px_28px] items-center gap-x-2.5 @min-[640px]:grid-cols-[minmax(72px,1fr)_48px_40px_minmax(88px,1fr)_minmax(88px,1fr)_minmax(80px,1fr)_56px_minmax(0,1.4fr)_28px] @min-[640px]:gap-x-3"

/** The table cells that only show once the table is wide enough (see COLUMNAS_POSICIÓN). */
const COLUMNA_ANCHA = "hidden @min-[640px]:block"

function MetaCuenta(props: { etiqueta: string; children: JSX.Element; mono?: boolean; tono?: string }) {
  return (
    <div class="flex min-h-6 items-center justify-between gap-6">
      <dt class="shrink-0 text-[13px] text-v2-text-text-muted" style={LINEA}>
        {props.etiqueta}
      </dt>
      <dd
        class={`min-w-0 truncate text-[13px] text-v2-text-text-base ${props.mono ? "font-mono" : ""} ${props.tono ?? ""} tabular-nums`}
        style={LINEA}
      >
        {props.children}
      </dd>
    </div>
  )
}

/** One headline figure of the KPI band: the caption over the number, the tone (P/L sign,
 * running systems) on the number alone. In a phone-narrow band (two columns under 360px) the
 * figure steps down a size so a seven-digit net worth still fits whole; anything that still
 * cannot fit keeps its full text in the tooltip. */
function CifraKpi(props: { etiqueta: string; valor: string; tono?: string }) {
  return (
    <div class="min-w-0">
      <p class="truncate text-[11px] tracking-[0.08em] text-v2-text-text-muted uppercase" style={LINEA} title={props.etiqueta}>
        {props.etiqueta}
      </p>
      <p
        class={`mt-1 truncate text-[16px] tabular-nums @min-[360px]:text-[20px] ${props.tono ?? "text-v2-text-text-base"}`}
        title={props.valor}
      >
        {props.valor}
      </p>
    </div>
  )
}

/** `/trading` with no routed chat yet: it redirects to its dedicated chat's start on Home's
 * server. With no visible server there is nothing to redirect to, so the route states its
 * own empty state instead of a blank pane. */
export function TradingRouter() {
  const layout = useLayout()
  const servers = useServers()
  const navigate = useNavigate()
  const language = useLanguage()

  createEffect(() => {
    // Home's own server choice: the remembered connection while it is visible, else the first visible one.
    const connection =
      servers.visible.find((item) => ServerConnection.key(item) === layout.home.selection().server) ??
      servers.visible[0]

    if (!connection) return

    navigate(tradingNewHref(ServerConnection.key(connection)), { replace: true })
  })

  // Route side only: while the redirect settles nothing shows but an empty frame; with no
  // visible server the redirect has nowhere to go and the pane states its own empty state.
  return (
    <Show
      when={servers.visible.length > 0}
      fallback={
        <div class="flex h-full items-center justify-center px-6">
          <p class="max-w-[420px] text-center text-[13px] text-v2-text-text-muted" style={LINEA}>
            {language.t("trading.servers.empty")}
          </p>
        </div>
      }
    >
      <div class="flex h-full items-center justify-center">
        <Loader />
      </div>
    </Show>
  )
}

// Dedicated chats already resolved in this app run, per server. Re-entry inside the run
// (switching back to the section, another trading tab) must resolve to the same chat
// again; the map resets on app restart and nothing else points at a dedicated chat —
// the chat is ephemeral (see ChatBoot), so every restart starts an empty one.
// Reactive on purpose: writing the pointer is what resolves the route's boot gate, and an
// adoption often navigates to the URL the route already carries (a restored tab), so the
// resolved `<Show>` would otherwise re-evaluate for nothing and the boot screen would sit
// there forever even though the chat came up.
const [vivos, setVivos] = createStore<Record<string, string>>({})

// The system prompt of the trading chat: the standing instructions entry (`trading.desk`).
// It survives app restarts in the server-global store, and every boot adoption also
// re-writes it — an idempotent overwrite that keeps the entry in step with the user's
// edits without touching the chat itself.
const PromptoSchema = Persistence.struct({
  value: Persistence.optional(Schema.String),
})

export function TradingWithSession() {
  // Settings open from the desk like from every other screen: Ctrl+, and the command palette. The
  // routes register the command themselves, and the desk had not, so neither reached settings here.
  useSettingsCommand()

  const params = useParams<{ serverKey: string; id: string }>()
  const language = useLanguage()
  const sdk = useServerSDK()
  // The route owns this persisted store on its own so the chat width never desyncs between
  // instances over the same window target.
  const [layout, setLayout, , layoutReady] = persisted(Persist.window("trading.chat"), ChatLayout, {})

  const [prompto, setPrompto, , promptoReady] = persisted(
    Persist.serverGlobal(sdk.scope, "trading.system-prompt"),
    PromptoSchema,
    {},
  )

  const serverKey = () => requireServerKey(params.serverKey)

  // Resolved means this run's own chat. Anything else (pending or a session id from a previous
  // run — a restored tab) is a chat that has not come up: opening the section, a restored tab
  // or a parked pane boots nothing, and the pane's own open boots it below.
  const resuelto = () => params.id !== PENDING && vivos[serverKey()] === params.id

  // The boot runs with the pane's open state, never with the section: entering Trading (even
  // a restored tab's route) creates nothing at all — no session, no server scan, nothing in
  // the chats lists. The pane's first open in the run boots the ephemeral chat (and holding
  // the dictation key opens the pane, so it boots the same way), and the store gate waits for
  // hydration: desktop reads persist through async IPC (and the prompt reads back from the
  // server), so booting before both are ready would seed the default instead of the stored
  // prompt.
  const arranque = createChatBoot({
    semilla: () => prompto.value ?? TRADING_DESK_CONTEXT,
    listo: () => layoutReady() && promptoReady(),
    resuelto,
    chato: chatAbierto,
  })

  // The session route's chunk loads once the chat resolved, ahead of the pane: the dashboard's
  // first paint never waits for it, and the chat opens without fetching it then.
  createEffect(() => {
    if (resuelto()) void TargetSessionRouteContent.preload()
  })

  // Hydration gate: desktop reads persist through an async IPC, so the first render can outrun
  // the stored value. Every layout write waits for that read: a setter that lands first marks
  // the store touched and skips hydrating exactly what the storage held (width, open state).
  const escribirLayout = (escribe: () => void) => {
    if (layoutReady()) escribe()
    else void layoutReady.promise?.then(escribe)
  }

  // The welcome note is purely informational: it shows while the resolved chat holds neither
  // delivered messages nor pending prompts, and both turn it off the instant they exist —
  // prompt admission is optimistic at Enter, so the note leaves on the send itself. During
  // boot it stays hidden: the boot states render their own centered content.
  const data = useData()

  const sinMensajes = createMemo(() => {
    const id = params.id

    if (id === PENDING || vivos[serverKey()] !== id) return false

    return data.session.message.list(id).length === 0 && data.session.pending.list(id).length === 0
  })

  // The data layer may not have synced this chat yet when it resolves; seed it so the memo
  // reads real contents instead of an empty store.
  createEffect(
    on(
      () => params.id,
      (id) => {
        if (id === PENDING || vivos[serverKey()] !== id) return
        void Promise.all([data.session.message.sync(id), data.session.pending.sync(id)]).catch(() => undefined)
      },
    ),
  )


  // Save an edited prompt: written to the server-global store first (it survives every restart),
  // then synced into the current chat's instructions entry so the running conversation picks it up.
  // A chat that has not resolved yet only gets the store; its boot reads it when it seeds. The
  // verdict returns to the caller: only a saved prompt closes the editor — a failed one leaves
  // the text on screen with its error toast, so the user retries instead of losing it.
  const guardarPrompto = async (valor: string): Promise<boolean> => {
    try {
      await promptoReady.promise
      setPrompto({ value: valor })

      if (params.id !== PENDING) {
        await sdk.api.experimental.session.instructions.entry
          .put({ sessionID: params.id, key: "trading.desk", value: valor })
      }

      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("trading.prompt.saved"),
      })

      return true
    } catch {
      showToast({
        variant: "error",
        title: language.t("trading.prompt.failed"),
      })

      return false
    }
  }

  return (
    <>
      {/* The window title switches with the product, the same composition the session route
          drives (`<name> · Openbot`), so switching to Trading does not trail it 1–2 s. */}
      <Title>{`${language.t("trading.title")} · Openbot`}</Title>
      <TradingShell
        // Read verbatim like the native session's: the stored width stands (or the default
        // the session layout owns while unset). No floor here: the shell's split owns it.
        // A double-click on the divider forgets the stored width, back to that default.
        anchuraChat={() => layout.chatWidth ?? sessionPanelWidthDefault}
        fijarAnchura={(anchura) => escribirLayout(() => setLayout("chatWidth", anchura))}
        restablecerAnchura={() => escribirLayout(() => setLayout("chatWidth", undefined))}
        // Hidden on every launch (see chatAbierto); the toggle holds for the rest of the run.
        abierto={chatAbierto}
        fijarAbierto={fijarChatAbierto}
        prompto={() => prompto.value}
        guardarPrompto={guardarPrompto}
        sinMensajes={() => sinMensajes()}
        chat={
        <Show
          when={resuelto()}
          fallback={
            // Boot state only: every state of the resolved session route brings its own panel
            // frame, so it renders bare like the session route and a second frame never stacks.
            <div class="flex min-h-0 flex-1 px-[var(--shell-inline-inset,8px)] pb-[var(--shell-bottom-inset,8px)] pt-[var(--shell-top-inset,8px)]">
              <SessionPanelFrame raised>
                <ChatBootView arranque={arranque} />
              </SessionPanelFrame>
            </div>
          }
        >
          <Suspense
            // Purposeful suspension: the session route lands as a late chunk after the chat
            // resolves; the empty frame pins the chat pane's geometry until it arrives, the
            // same shape routes.tsx holds the session route behind.
            fallback={
              <div class="flex min-h-0 flex-1 px-[var(--shell-inline-inset,8px)] pb-[var(--shell-bottom-inset,8px)] pt-[var(--shell-top-inset,8px)]">
                <SessionPanelFrame raised />
              </div>
            }
          >
            <TargetSessionRouteContent />
          </Suspense>
        </Show>
      }
    />
    </>
  )
}

/**
 * Boots the trading section's dedicated chat. Trading stays apart from the chats: opening
 * the section (or a restored tab) boots nothing — the boot drives off the chat pane's open
 * state with the run's stores ready, and the chat lives only for this app run (switching
 * back to the section or another trading tab re-resolves the same chat; a restart never
 * resumes one). Every boot first reuses this run's own pointer (verified live), and
 * otherwise sweeps the marked trading sessions it can claim off the server best effort —
 * this window's own session, a previous run's leftovers, any boot race's duplicates —
 * while another window's live chat stays (its metadata names a different window: U-04).
 * It then creates a fresh session with the marks. The seed text comes from the stored
 * prompt when the user edited it, or the default desk context otherwise.
 */
function createChatBoot(props: { semilla: () => string; listo: () => boolean; chato: () => boolean; resuelto: () => boolean }) {
  const language = useLanguage()
  const data = useData()
  const platform = usePlatform()
  const server = useServer()
  const sdk = useServerSDK()
  const navigate = useNavigate()
  const [estado, setEstado] = createStore<{ tipo: "iniciando" | "fallo" }>({ tipo: "iniciando" })
  // The boot's own fetch channel: the route's unmount aborts an in-flight pointer check or
  // scan instead of letting it finish into a dead closure.
  const canal = new AbortController()
  let vigente = true

  onCleanup(() => {
    canal.abort()
    vigente = false
  })

  // One boot at a time: an open pane re-boots whenever the chat stands unresolved with its
  // stores ready (the pane's first open in the run, a retry after a failure), and a retry
  // joins nothing already running.
  let enCurso = false

  const arrancar = () => {
    if (enCurso) return
    enCurso = true
    setEstado("tipo", "iniciando")

    void arrancarDedicado()
      .catch(() => {
        if (vigente) setEstado("tipo", "fallo")
      })
      .finally(() => {
        enCurso = false
      })
  }

  createEffect(
    on(
      () => props.listo() && props.chato() && !props.resuelto(),
      (pendiente) => {
        if (pendiente) arrancar()
      },
    ),
  )

  // One shared adoption for every path: it re-points this run, routes to the chat and
  // re-seeds the desk instructions. The re-seed is an idempotent overwrite (see the
  // PromptoSchema note) that keeps the entry in step with the user's prompt edits — a
  // fresh chat seeds before the route switches (A-8: the first prompt must not escape
  // without context), adoptions re-put after the switch, both best effort: a server
  // without the experimental endpoint still started the chat; a later boot retries the
  // seeding.
  const adoptar = (id: string, sembrar = true) => {
    // One per-session context entry keeps the chat on-topic for every step (see
    // TRADING_DESK_CONTEXT). The user-editable prompt (stored server-side) replaces the
    // default when present.
    setVivos(server.key, id)
    navigate(tradingHref(server.key, id), { replace: true })

    if (sembrar)
      void sdk.api.experimental.session.instructions.entry
        .put({ sessionID: id, key: "trading.desk", value: props.semilla() })
        .catch(() => undefined)
  }

  // A pointer only counts when the session is still there and really is a trading chat:
  // the mark is the only thing this route trusts, and the fetch rides the boot's channel,
  // aborted when the route unmounts.
  const prioridad = async (id: string) => {
    const conocida = await sdk.api.session.get({ sessionID: id }, { signal: canal.signal }).catch(() => undefined)

    if (!vigente) return undefined

    return conocida && isTradingSession(conocida) ? id : undefined
  }

  const arrancarDedicado = async () => {
    // The window's own lease id: the desktop's stable per-window identity (web reads
    // "browser" — one browser context, one desk). Every session this window creates
    // carries it, so the sweep below can tell this window's chats apart from another
    // window's live one.
    const ventanaLocal = platform.platform === "desktop" ? platform.windowID : "browser"

    // (1) Re-entry inside this run (coming back to the section, another trading tab):
    // the chat this run created resolves again, verified live before reuse — it never
    // falls through to the sweep below, so re-entry cannot wipe the run's own chat.
    const viva = vivos[server.key]

    if (viva) {
      const adoptada = await prioridad(viva)

      if (!vigente) return

      if (adoptada) return adoptar(adoptada)
    }

    // (2) Nothing of this run owns a chat: the sweep. The dedicated chat is ephemeral —
    // conversations survive nowhere (this window used to keep a pointer; the pointer went
    // out with it) — and the sweep is this window's, not the desk's: sessions whose
    // metadata names a different window leave (the U-04 rule — a second window's chat
    // must outlive that window's sweep), sessions with no window mark predate the tag
    // (unowned leftovers) and this window's own marked ones sweep as before. Best effort:
    // a removal that fails only leaves a sweep for the next launch.
    const marcadas = [...(await scanTradingSessions((input, options) => sdk.api.session.list(input, { ...options, signal: canal.signal }), { signal: canal.signal }))]

    if (!vigente) return

    const ajenas = new Set(
      marcadas.flatMap((session) => {
        const ventana = session.metadata?.[TRADING_SESSION_WINDOW]

        return typeof ventana === "string" && ventana !== ventanaLocal ? [session.id] : []
      }),
    )

    void Promise.allSettled(
      marcadas.flatMap((session) => (ajenas.has(session.id) ? [] : [sdk.api.session.remove({ sessionID: session.id }).catch(() => undefined)])),
    )

    // (3) A fresh dedicated chat every launch. Its standing instructions land before the
    // route switches, so the composer never opens by a round-trip in which a first prompt
    // could escape without context (A-8).
    const info = await sdk.api.session.create({
      title: language.t("trading.title"),
      metadata: { [TRADING_METADATA_MARK]: true, [TRADING_SESSION_WINDOW]: ventanaLocal },
    })

    data.session.remember(info)

    if (!vigente) return

    // The PUT answers 204 with no body, so its value is undefined either way: success is the
    // promise settling, and only a failed seed is retried on adoption.
    const sembrado = await sdk.api.experimental.session.instructions.entry
      .put({ sessionID: info.id, key: "trading.desk", value: props.semilla() })
      .then(() => true)
      .catch(() => false)

    if (!vigente) return

    adoptar(info.id, !sembrado)
  }

  return { estado, arrancar }
}

/** The boot's face in the chat pane: the spinner while the chat comes up, the retry after a
 * failed boot. */
function ChatBootView(props: { arranque: ReturnType<typeof createChatBoot> }) {
  const language = useLanguage()

  return (
    <Show
      when={props.arranque.estado.tipo === "iniciando"}
      fallback={
        <div class="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
          <p class="max-w-[420px] text-[13px] text-v2-text-text-muted" style={LINEA}>
            {language.t("trading.chat.failed")}
          </p>
          {/* The app's own outline button: the shared control carries the native focus ring
              and pressed states the raw element above lacked. */}
          <Button type="button" variant="outline" size="normal" onClick={props.arranque.arrancar}>
            {language.t("trading.chat.retry")}
          </Button>
        </div>
      }
    >
      <div class="flex h-full flex-col items-center justify-center gap-3 p-6">
        <Loader />
        <p class="text-[13px] text-v2-text-text-muted" style={LINEA}>
          {language.t("trading.chat.starting")}
        </p>
      </div>
    </Show>
  )
}

/** The two-pane row: dashboard, then the routed dedicated chat (or its boot state). */
// Where the user gets a program the engine needs and could not find on this computer.
const DESCARGA_TWS = "https://www.interactivebrokers.com/en/trading/tws.php"
const DESCARGA_MT5 = "https://www.metatrader5.com/en/download"
// How long TWS may sit open without taking the app (the user signing in) before the API hint shows.
const AVISO_API_MS = 60_000

function TradingShell(props: {
  anchuraChat: Accessor<number>
  fijarAnchura: (anchura: number) => void
  /** Forget the stored width: the chat returns to its default. */
  restablecerAnchura: () => void
  abierto: Accessor<boolean>
  fijarAbierto: (abierto: boolean) => void
  /** The stored chat prompt (the default desk context when the user has never edited it). */
  prompto: Accessor<string | undefined>
  guardarPrompto: (valor: string) => Promise<boolean>
  /** True while the resolved chat holds no messages: the welcome note shows (informational). */
  sinMensajes: Accessor<boolean>
  chat: JSX.Element
}) {
  const { formatoUSD, formatoPrecio, formatoMomento } = useFormatos()
  const language = useLanguage()
  const dialog = useDialog()
  const sdk = useServerSDK()
  const platform = usePlatform()
  const [snapshot, setSnapshot] = createStore<SnapshotMotor>(structuredClone(DEMO))
  // One system write at a time: while a toggle's or batch's round-trip runs, the pool's
  // controls ignore further clicks, so a rapid re-click cannot race its own flag.
  const [escrituras, fijarEscrituras] = createSignal(false)
  // One lost snapshot answer outlives the poll: the panel keeps the last real values it
  // got (the "stale" read below) and locks the writes until an answer lands again.
  const [caducado, fijarCaducado] = createSignal(false)
  // "Active" reads the union of the command flag and the running mirror: the flag leads
  // (a fresh flip lands before the poll's own mirror catches up) and the mirror can
  // outlive the flag (a bot process running through a flag edit) — either way the user
  // must see a running system and be able to stop it.
  const activos = () => snapshot.bots.filter((bot) => bot.activo || bot.enMarcha).length

  // One record, no per-system tabs: log lines and closed trades merge into a single
  // chronological list whose close rows ARE the trades (each close already logs itself,
  // so the trades carry the P/L and the log's own close rows drop out) — nothing repeats.
  const registroUnido = createMemo(() => reunirRegistro(snapshot.registros, snapshot.trades))

  // The manual-close permission lives for this window's run only: the switch arms the
  // close actions (per-position and close-all) from the OFF default each start, so no
  // stale opt-in can stand in for orders the user never asked for — the shared global
  // store never holds the flag at all, and the confirmation dialog still guards both
  // close paths.
  const [cierreManual, fijarCierreManual] = createSignal(false)
  const cierrePermitido = cierreManual

  // The chat pane flies on the app's shared panel motion — the same system the session's side
  // panel uses, with the roles mirrored: the dashboard plays the session chat's own pane, and
  // the flight paints the dashboard's width, so the chat's presence takes the row's leftover
  // and follows its edge every frame without painting a width of its own. Only the dashboard
  // paints, and the chat's interior never shrinks its layout mid-flight: the landing hold
  // pins its contents to the width they arrive at while the flight runs.
  let chatPresencia: HTMLDivElement | undefined
  let chatContenido: HTMLDivElement | undefined
  let panelDashboard: HTMLDivElement | undefined

  const [filaSize, setFilaSize] = createStore<{ width?: number }>({})
  let filaPaneles: HTMLDivElement | undefined
  createResizeObserver(
    () => filaPaneles,
    ({ width }) => setFilaSize({ width }),
  )

  // The row sits on whole device pixels. At a fractional scale (Windows at 150%) its edges can land
  // on half pixels, which the dashboard's frame and the chat's face round apart: the chat painted a
  // pixel lower than the dashboard. Nudging the row's top and bottom by under half a device pixel
  // puts both edges on the grid, so the two frames start and end on the same row by construction.
  // It re-reads the natural edges first, so every pass is the same; the row's own size is not
  // watched, since the nudge itself changes it.
  const encajarFila = () => {
    const fila = filaPaneles

    if (!fila) return

    fila.style.marginTop = ""
    fila.style.marginBottom = ""

    const escala = devicePixelRatio
    const caja = fila.getBoundingClientRect()
    const arriba = caja.top * escala
    const abajo = caja.bottom * escala

    fila.style.marginTop = `${(Math.round(arriba) - arriba) / escala}px`
    fila.style.marginBottom = `${(abajo - Math.round(abajo)) / escala}px`
  }

  onMount(() => {
    encajarFila()
    makeEventListener(window, "resize", encajarFila)

    // A new scale (another monitor, a changed Windows setting) moves the grid under the row. The
    // query names the current scale, so each change re-arms it for the next one.
    const consultar = () => matchMedia(`(resolution: ${devicePixelRatio}dppx)`)
    const escala = { consulta: consultar() }

    const cambio = () => {
      escala.consulta.removeEventListener("change", cambio)
      encajarFila()
      escala.consulta = consultar()
      escala.consulta.addEventListener("change", cambio)
    }

    escala.consulta.addEventListener("change", cambio)
    onCleanup(() => escala.consulta.removeEventListener("change", cambio))
  })

  const escritorio = createMediaQuery("(min-width: 768px)")

  // The welcome lives in the free space above the composer. The dock grows with a long draft
  // and the window can be short, so its top edge is measured instead of assumed: the welcome
  // ends where the dock begins, and its suggestions step aside whenever the space left cannot
  // hold them, so nothing ever lands on the composer.
  let panelChat: HTMLDivElement | undefined
  let bienvenida: HTMLDivElement | undefined
  let bienvenidaNota: HTMLParagraphElement | undefined
  let bienvenidaOpciones: HTMLDivElement | undefined
  const [hueco, setHueco] = createStore({ abajo: 112, opciones: true })

  createEffect(() => {
    // The panel mounts with the chat pane itself, so the watch restarts each time it opens.
    if (!chatVisto() || !props.sinMensajes() || !panelChat) return

    const panel = panelChat

    const DOCK = '[data-component="session-composer-dock"]'

    const medir = () => {
      const dock = panel.querySelector(DOCK)

      if (dock) setHueco("abajo", Math.max(0, panel.getBoundingClientRect().bottom - dock.getBoundingClientRect().top))

      if (!bienvenida || !bienvenidaNota || !bienvenidaOpciones) return

      // 12px is the welcome's own gap-3 between the note and the suggestions.
      setHueco("opciones", bienvenida.clientHeight >= bienvenidaNota.offsetHeight + 12 + bienvenidaOpciones.offsetHeight)
    }

    // The measure moves the welcome's own box, so it lands on the next frame instead of inside
    // the observer's delivery — writing there would loop the observer.
    let cuadro = 0

    const programar = () => {
      cancelAnimationFrame(cuadro)
      cuadro = requestAnimationFrame(medir)
    }

    const tamaños = new ResizeObserver(programar)
    const observados = new Set<Element>()

    const seguir = (element: Element | null | undefined) => {
      if (!element || observados.has(element)) return
      observados.add(element)
      tamaños.observe(element)
    }

    // The dock mounts with the chat's lazy route, after the welcome: the panel's subtree is
    // watched until it shows up, and every element the measure reads is observed for size.
    const llegadas = new MutationObserver(() => {
      seguir(panel.querySelector(DOCK))
      programar()
    })

    seguir(panel)
    seguir(panel.querySelector(DOCK))
    seguir(bienvenida)
    seguir(bienvenidaOpciones)
    llegadas.observe(panel, { childList: true, subtree: true })
    programar()

    onCleanup(() => {
      cancelAnimationFrame(cuadro)
      tamaños.disconnect()
      llegadas.disconnect()
    })
  })

  // The nav strip rides in the dashboard's header on every layout — a horizontal tab strip,
  // the stacked windows, the phone, and the side-tabs app alike, whose shell sidebar keeps
  // the app's own tabs (the product has no sidebar of its own anywhere). The desk's one page
  // and the strip's docked panels — accounts, systems, and the pinned log — carry the whole
  // nav: the center never changes, and the nav never opens another page, on every layout.
  // The account's dossier rides behind a disclosure, closed at rest so the sheet leads with
  // the action (curve, positions); opening it resolves per session, nothing persists it.
  const [detalles, fijarDetalles] = createSignal(false)

  // The exact derivation the session's own layout uses (`screen-layout.ts`): the row less
  // its panel gap, undefined until the row first measures — width consumers keep the stored
  // value untouched until then so nothing snaps on the first frame.
  const disponible = createMemo<number | undefined>(() => {
    const width = filaSize.width

    if (width === undefined) return undefined

    return width - PANE_GAP
  })

  // The chat panel obeys the persisted toggle alone, like the native session panel: it never
  // hides because the row no longer fits. The split below decides who gives way instead.
  const chatVisible = () => props.abierto() && escritorio()
  const chatVisto = () => (escritorio() ? chatMotion.present() || chatMontada() : props.abierto())

  // The desk's split, the same at rest, in CSS and under the handle: the dashboard holds its
  // floor first. The chat keeps its own minimum while the row has room for both, and when
  // it does not the chat gives way, down to its emergency floor — the desk never crushes.
  // The cap is what the row leaves beside the dashboard's floor (undefined until measured).
  const chatTope = () => {
    const width = disponible()

    return width === undefined ? undefined : width - TRADING_DASH_WIDTH_MIN
  }

  // The chat's floor right now: its own minimum with room to spare, the cap in a tight row,
  // never under the emergency floor.
  const chatSuelo = () => {
    const tope = chatTope()

    return tope === undefined ? TRADING_CHAT_WIDTH_MIN : Math.min(TRADING_CHAT_WIDTH_MIN, Math.max(TRADING_CHAT_WIDTH_FLOOR, tope))
  }

  // The chat's present-tense width: the stored width (raised to the chat's own minimum) held
  // under the cap, never under the emergency floor. An unmeasured row renders the stored
  // width untouched, so nothing snaps off the first frame.
  const chatAnchoVivo = createMemo(() => {
    const ancho = Math.max(TRADING_CHAT_WIDTH_MIN, props.anchuraChat())
    const tope = chatTope()

    return tope === undefined ? ancho : Math.max(TRADING_CHAT_WIDTH_FLOOR, Math.min(ancho, tope))
  })

  // The chat's open width, kept through a close as the far end of its travel — the sticky
  // width the session side panel hands its content. It follows the live clamp only while the
  // chat shows on a measured row; before that, the content renders at its natural
  // full-presence width with no first-frame snap.
  const chatAncho = createMemo<number | undefined>((previous) => {
    return chatVisible() && disponible() !== undefined ? chatAnchoVivo() : previous
  })

  // The content box's width at rest: the chat's full span before the row measures, the
  // landed width on every desktop flight after, and 100% again stacked — the pane spans
  // the row there and holds no travel of its own, so a crossing between layouts never
  // pins a desktop width onto the full-width stacked chat.
  const chatAnchoContenido = createMemo<string>((previous) => {
    if (!escritorio()) return "100%"

    const width = chatAncho()

    return width === undefined ? previous : `${width}px`
  }, "100%")

  // The same split in CSS against the row (100%), so the chat follows the row on the frame it
  // resizes rather than after a ResizeObserver callback; it builds the dashboard's open width.
  const chatWidthCss = createMemo(
    () =>
      `max(${TRADING_CHAT_WIDTH_FLOOR}px, min(${Math.max(TRADING_CHAT_WIDTH_MIN, props.anchuraChat())}px, 100% - ${TRADING_DASH_WIDTH_MIN + PANE_GAP}px))`,
  )

  // The shell's sidebar caps itself against what this row needs: the dashboard's floor alone,
  // or with the chat open, the chat's emergency floor and the gap beside it too.
  claimRowReserve(() => (chatVisible() ? TRADING_ROW_WIDTH_MIN : TRADING_DASH_WIDTH_MIN))

  // The dashboard keeps its open width as the far end of a close's travel — the native
  // flight's sticky open width, mirrored one seam over: the row less the panel gap and the
  // chat's resting width, what that split leaves the dashboard.
  const dashAbierta = createMemo<string>((previous) => (chatVisible() ? `calc(100% - ${PANE_GAP}px - ${chatWidthCss()})` : previous), "100%")

  // Once opened, the pane stays mounted whatever the collapse state does, so a flight reuses
  // the content and its layout instead of remounting the whole chat mid-air, and a close
  // settles into a parked state instead of an unmount.
  const [chatMontada, fijarChatMontada] = createSignal(false)

  // The content keeps the width it lands at through every flight, so the transcript never
  // rewraps per frame while its box moves, and centred blocks keep their place. The property
  // doesn't inherit, so setting and clearing it restyles only the card.
  holdLandingWidth(
    () => chatContenido,
    "blocks",
    () => chatContenido?.querySelector<HTMLElement>('[data-slot="trading-chat-panel"]'),
  )

  const chatMotion = createPanelMotion({
    open: chatVisible,
    paint: (cerrado) => {
      // Dims the contents as they leave and fades them in as they arrive — desktop only:
      // on the stacked layout the chat is shown by the persisted toggle at full width and
      // no flight owns a fade there (the mirrored native never shows the side panel
      // inline on the narrow layout either).
      if (escritorio() && chatContenido) {
        chatContenido.style.opacity = panelOpacity(cerrado)
        // A compositing layer only mid-flight, where the fade needs it. At rest the chat paints
        // with the dashboard beside it: a standing layer snaps to the device pixel grid on its
        // own, and at a fractional scale (Windows at 150%) that left the chat's edges a pixel
        // off the dashboard's.
        chatContenido.style.willChange = cerrado > 0 && cerrado < 1 ? "opacity" : ""
      }

      if (!panelDashboard) return

      // The dashboard's width paints every state the way the native flight paints its
      // carrier: closed, the whole row, so the parked chat sits on nothing; open, the row
      // less the gap and the chat's resting width; between, the two ends interpolated on a
      // live `100%` — no measured pixels, so a flight's ends always agree with the formulas
      // they land at and the dashboard rides window and sidebar resizes mid-air.
      const abierta = dashAbierta()

      if (cerrado === 1) {
        panelDashboard.style.width = "100%"

        return
      }

      panelDashboard.style.width = cerrado === 0 ? abierta : `calc(${abierta} + (100% - ${abierta}) * ${cerrado})`
    },
    element: () => chatPresencia,
    distance: () => chatAncho(),
  })

  // The panel counts as mounted once it has shown in either layout. Stacked must mark it
  // too: on the narrow layout the persisted toggle shows the pane without flights and the
  // marker would otherwise stay false, so crossing up to desktop (present() still false
  // for the flight's first frames) would drop the Show for one frame and remount the
  // whole chat — the composer draft and the transcript scroll would land states late.
  createEffect(() => {
    if (chatVisible() || (!escritorio() && props.abierto())) fijarChatMontada(true)
  })

  // Close flight guard, the native side panel's own: focus inside the pane moves to the
  // control that reopens it the moment the close starts (the parked ChatShell's inert
  // only settles after the flight), and every later focusin while closed is evicted the
  // same way.
  guardClosingFocus({
    root: () => chatPresencia,
    closing: () => !chatVisible() && chatMotion.present(),
    target: () =>
      panelDashboard?.querySelector<HTMLElement>('[data-slot="trading-chat-toggle"] button') ?? undefined,
  })

  // A desktop flight that settles parked leaves the contents dimmed to nothing; when the
  // window crosses to the stacked layout the chat shows again by the persisted toggle, at
  // full width and with no flight of its own. Clear the stale dim once the layout flips,
  // so the presentation never rides a flight that never ran.
  createEffect(
    on(
      () => escritorio(),
      () => {
        if (!escritorio() && chatContenido) chatContenido.style.opacity = ""
      },
    ),
  )

  // One control for the chat, like the app's own panel toggles: it sits at the window's
  // top-right corner in both states, because that corner belongs to the dashboard when
  // the chat is hidden and to the chat when it is open. The control, the header's corner
  // reserve and the edit button read the persisted toggle — the native panel's own flag.
  const etiquetaChat = () => language.t(props.abierto() ? "trading.chat.hide" : "trading.chat.show")

  // The dictation host: the hold key answers wherever the focus sits on the desk, revealing
  // the chat first if it is parked. The editor focus waits two frames so a first-ever open
  // has rendered its composition before the take starts talking into it.
  const revelarChat = () => {
    if (!props.abierto()) props.fijarAbierto(true)
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        chatContenido
          ?.querySelector<HTMLDivElement>('[data-slot="trading-chat-panel"] [contenteditable="true"]')
          ?.focus(),
      ),
    )
  }

  // A welcome suggestion lands in the chat's composer the way a paste does (the editor's own
  // insertText path, so the draft saves as typed): focus first, then the words at the cursor.
  const sugerir = (texto: string) => {
    const editor = chatContenido?.querySelector<HTMLDivElement>('[data-slot="trading-chat-panel"] [data-component="composer-editor"]')

    if (!editor?.isContentEditable) return

    editor.focus()
    document.execCommand("insertText", false, texto)
  }

  // The chat's effective visibility, the state `aria-expanded` must report: desktop owns
  // the parked state (a parked chat renders but is not visible), stacked rides the persisted
  // toggle alone. The control also targets the panel only while it exists in the DOM.
  const chatAbiertaActual = () => (escritorio() ? chatMotion.present() : props.abierto())

  const botónChat = () => (
    <Tooltip class="shrink-0" placement="bottom" value={etiquetaChat()}>
      <IconButton
        type="button"
        variant="ghost-muted"
        size="large"
        class="shrink-0"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => props.fijarAbierto(!props.abierto())}
        aria-label={etiquetaChat()}
        aria-expanded={chatAbiertaActual()}
        aria-controls={chatAbiertaActual() ? "trading-chat-panel" : undefined}
        icon={<Icon name={props.abierto() ? "layout-right-full" : "layout-right"} />}
      />
    </Tooltip>
  )

  const abrirPrompto = () => dialog.show(() => <DialogPrompto contenido={props.prompto() ?? TRADING_DESK_CONTEXT} guardar={props.guardarPrompto} />)

  // The system's dossier: the same registry rows the LOG card shows, filtered to this one
  // bot, plus the snapshot store's live flags (state, process, P/L) that each 3 s poll touches.
  const abrirFicha = (bot: BotInfo) => {
    dialog.show(() => (
      <DialogFicha
        bot={() => snapshot.bots.find((candidato) => candidato.id === bot.id)}
        registros={() => registroUnido().filter((entrada) => entrada.bot === bot.nombre)}
        programar={(entrada) => programarSistema(bot.id, entrada)}
        alternar={() => {
          const actual = snapshot.bots.find((candidato) => candidato.id === bot.id)
          if (actual) void fijarSistema(actual)
        }}
        ocupado={() => snapshot.demo || escrituras()}
      />
    ))
  }

  // The handle drags between the split's own floor and cap, so it can never write a width
  // the resting split would re-cap differently. Unmeasured rows keep the session's 1000.
  const chatWidthMax = () => Math.max(chatSuelo(), chatTope() ?? 1000)

  // Polls and user refreshes share one writer: every call takes the next generation slot
  // and only the newest applying answer lands, so a slow poll can never write over what a
  // fresher refresh already wrote. A call that gets no answer marks the snapshot stale —
  // unless a newer call already answered — and freezes the panel on its last real values.
  let generación = 0

  const refrescar = async () => {
    const propia = ++generación
    const real = await pedirSnapshot(sdk.api)

    // A newer call owns the snapshot now (the poll, a user refresh, a follow-up after an
    // action): this answer writes nothing.
    if (propia !== generación) return

    if (real === undefined) {
      setSnapshot("enlace", false)
      fijarCaducado(true)

      return
    }

    fijarCaducado(false)
    // reconcile instead of a wholesale replace: the poll rewrites the same values every
    // 3 s, and a fresh object identity would remount every row's DOM (and its focus) at
    // each tick — the diff keeps unchanged leaves (and their nodes) in place.
    setSnapshot(reconcile({ ...real, demo: false }))
  }

  // The start/stop toggle talks to the engine: activate/pause there flips the system's
  // running flag and spawns or stops that system's bot (whose own orders reach TWS once
  // the socket is up). The demo pool reuses real ids, so a sample row's click never
  // reaches the engine (a read-only showcase); one write at a time keeps a click storm
  // from interleaving its own flag; a no-answer meets its toast instead of dying silent.
  const fijarSistema = async (bot: { readonly id: string; readonly activo: boolean; readonly enMarcha: boolean }) => {
    if (snapshot.demo || escrituras()) return

    fijarEscrituras(true)
    const respuesta = await (bot.activo || bot.enMarcha ? pararSistema(sdk.api, bot.id) : arrancarSistema(sdk.api, bot.id))
    fijarEscrituras(false)

    if (respuesta === undefined) showToast({ variant: "error", title: language.t("trading.systems.failed") })

    await refrescar()
  }

  // Batch toggles write every system's flag in one go and refresh once — the engine takes
  // the writes in parallel, so the pool costs one refresh instead of one per system. A
  // write the engine never answered fails the batch as one (a single toast, not one per
  // row); demo rows hold live ids, so the batch never runs on them either.
  const lotearSistemas = async (operaciones: Array<Promise<unknown>>) => {
    if (snapshot.demo || escrituras()) return

    fijarEscrituras(true)
    const respuestas = await Promise.all(operaciones)
    fijarEscrituras(false)

    if (respuestas.some((respuesta) => respuesta === undefined))
      showToast({ variant: "error", title: language.t("trading.systems.failed") })

    await refrescar()
  }

  const arrancarTodos = () =>
    lotearSistemas(
      snapshot.bots
        .filter((bot) => !(bot.activo || bot.enMarcha))
        .map((bot) => arrancarSistema(sdk.api, bot.id)),
    )

  const pararTodos = () =>
    lotearSistemas(snapshot.bots.filter((bot) => bot.activo || bot.enMarcha).map((bot) => pararSistema(sdk.api, bot.id)))

  // Scheduling from a system's dossier: the scope is fixed by the card itself, so only the
  // action and the moment are picked. The same toast feedback as the dashboard writes.
  // Sample rows carry fake ids, so their schedule write never reaches the engine.
  const programarSistema = async (systemID: string, entrada: { kind: "start-systems" | "stop-systems"; delayMinutes?: number; atTime?: string }) => {
    if (snapshot.demo) return

    const resultado = await programarTarea(sdk.api, {
      kind: entrada.kind,
      systemIDs: [systemID],
      delayMinutes: entrada.delayMinutes,
      atTime: entrada.atTime,
    })

    // The toast names the moment the engine set, so a scheduled start is never a guess.
    if (resultado === undefined) {
      showToast({ variant: "error", title: language.t("trading.tasks.failed") })
    } else {
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("trading.tasks.saved"),
        description: language.t(entrada.kind === "start-systems" ? "trading.tasks.saved.start" : "trading.tasks.saved.stop", {
          time: formatoMomento(resultado.run_at),
        }),
      })
    }

    await refrescar()
  }

  // Stopping everything leaves open positions alone — they are not auto-closed — so the
  // dialog states that plainly before the flags flip.
  const abrirPararTodos = () =>
    dialog.show(() => (
      <DialogCierre
        avisa={false}
        confirmar={pararTodos}
        título={language.t("trading.systems.stopAll.title")}
        cuerpo={language.t("trading.systems.stopAll.body")}
        advertencia=""
        confirmarTexto={language.t("trading.systems.stopAll")}
      />
    ))

  // Starting everything arms every idle flag in one motion (the engine begins to trade):
  // a push this wide states what it does in its own confirmation, the same way the
  // close-all and the stop-all live behind. Its confirm reads as a primary action, not
  // a danger one.
  const abrirArrancarTodos = () =>
    dialog.show(() => (
      <DialogCierre
        avisa={false}
        tono="submit"
        confirmar={arrancarTodos}
        título={language.t("trading.systems.startAll.title")}
        cuerpo={language.t("trading.systems.startAll.body")}
        advertencia=""
        confirmarTexto={language.t("trading.systems.startAll")}
      />
    ))

  // Close semantics: real orders, so the confirmation is a dialog that states the full cycle
  // and warns when a running system trades the same contract family (it would reopen the
  // position). The engine's verdict comes back in the toast (its own message in the
  // description). Orders need the engine's TWS socket, so both the write and its door
  // (the buttons below) hold on `enlace`, and a sample account would close nothing.
  // Contract families carry alias nicknames across CME's reports (micro M2K under RTY, 6J
  // under JPY): an alias pair covers both spellings, so a running system warns its family's
  // close either way.
  const FAMILIAS: ReadonlyArray<readonly [string, string]> = [
    ["RTY", "M2K"],
    ["6J", "JPY"],
    // The pool names its yen systems USDJPY; IBKR's position reads "USD.JPY".
    ["USDJPY", "JPY"],
    ["USDJPY", "6J"],
  ]

  const mismaFamilia = (papel: string, base: string) =>
    papel.includes(base) ||
    FAMILIAS.some(([una, otra]) => (base === una || base === otra) && (papel.includes(una) || papel.includes(otra)))

  const sistemasSobreSímbolo = (símbolo: string) =>
    snapshot.bots.filter((bot) => (bot.activo || bot.enMarcha) && mismaFamilia(símbolo, bot.simbolo))

  const ejecutarCierre = async (símbolo: string) => {
    if (snapshot.demo || !puedeOrdenar()) return

    // A repeat of the same submission (a double-enter, a stale click) must not race the
    // first cycle into new orders: the request id lets the engine replay its earlier
    // verdict for this submission instead of ordering again.
    const solicitud = uuid()

    try {
      const respuesta = await cerrarPosicion(sdk.api, símbolo, solicitud)

      if (respuesta === undefined) throw new Error("sin respuesta")
      const resultado = respuesta

      if (resultado.ok) {
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("trading.position.dialog.sent"),
          description: textoVeredicto(resultado, language),
        })
      } else {
        showToast({
          variant: "error",
          title: language.t("trading.position.dialog.failed"),
          description: textoVeredicto(resultado, language),
        })
      }
    } catch {
      showToast({
        variant: "error",
        title: language.t("trading.position.dialog.failed"),
      })
    }

    void refrescar()
  }

  // The emergency close-all: same semantics as the single close, but the engine runs the
  // full cycle over every open position and reports per-symbol verdicts in one message.
  const ejecutarCierreTotal = async () => {
    if (snapshot.demo || !snapshot.enlace) return

    // Same idempotency guard as the single close: one submission, one verdict it can be
    // re-read from, never a second cycle racing the first.
    const solicitud = uuid()

    try {
      const resultado = await cerrarTotal(sdk.api, solicitud)

      if (resultado === undefined) throw new Error("sin respuesta")

      if (resultado.ok) {
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("trading.position.closeAll.sent"),
          description: textoVeredicto(resultado, language),
        })
      } else {
        showToast({
          variant: "error",
          title: language.t("trading.position.closeAll.failed"),
          description: textoVeredicto(resultado, language),
        })
      }
    } catch {
      showToast({
        variant: "error",
        title: language.t("trading.position.closeAll.failed"),
      })
    }

    void refrescar()
  }

  const abrirCierre = (posición: SnapshotMotor["posiciones"][number]) => {
    dialog.show(() => (
      <DialogCierre
        avisa={sistemasSobreSímbolo(posición.simbolo).length > 0}
        confirmar={() => ejecutarCierre(posición.simbolo)}
        título={language.t("trading.position.dialog.title")}
        cuerpo={language.t(cuentaMT5() ? "trading.position.dialog.body.mt5" : "trading.position.dialog.body")}
        advertencia={language.t("trading.position.dialog.warning")}
        confirmarTexto={language.t("trading.position.dialog.confirm")}
      />
    ))
  }

  // Any running system could reopen its position right after the close-all, so the warning
  // shows whenever the pool has an active flag.
  const abrirCierreTotal = () => {
    dialog.show(() => (
      <DialogCierre
        avisa={snapshot.bots.some((bot) => bot.activo || bot.enMarcha)}
        confirmar={ejecutarCierreTotal}
        título={language.t("trading.position.closeAll.title")}
        cuerpo={language.t("trading.position.closeAll.body")}
        advertencia={language.t("trading.position.closeAll.warning")}
        confirmarTexto={language.t("trading.position.closeAll.confirm")}
      />
    ))
  }

  // The engine raises its own socket at boot but opens no program on its own; the socket's
  // controls stand in the header, right beside the emergency. Connect opens a closed TWS and
  // dials it (the engine then retries every 5 s until TWS accepts); disconnect drops the socket
  // and stops the chase, running bots riding through untouched. The state dot answers "did
  // it settle", so a landed call needs no toast — a call the engine never answered gets one.
  const ejecutarEnlace = async (hacia: "conectar" | "desconectar") => {
    if (snapshot.demo || escrituras()) return

    fijarEscrituras(true)
    const respuesta = await (hacia === "conectar" ? conectarCuenta(sdk.api) : desconectarCuenta(sdk.api))
    fijarEscrituras(false)

    if (respuesta === undefined)
      showToast({ variant: "error", title: language.t(hacia === "conectar" ? "trading.engine.connect.failed" : "trading.engine.disconnect.failed") })

    // The engine chases an accepted connect every 5 s but its snapshot only says "not
    // connected" meanwhile, so this window remembers it asked: the tree and the welcome
    // read "connecting" instead of "offline" until TWS accepts or the user stops it.
    fijarConectando(hacia === "conectar" && respuesta !== undefined)

    await refrescar()
  }

  const [conectando, fijarConectando] = createSignal(false)

  createEffect(() => {
    if (snapshot.enlace) fijarConectando(false)
  })

  // The first-run welcome: the engine answers, it carries links, none of them is up and it
  // remembers no account yet — nothing has ever been connected from this desk. A returning
  // user (remembered accounts) gets the tree and the header's own connect instead.
  const primerArranque = () => {
    const enlaces = snapshot.enlaces ?? []

    return !snapshot.demo && !caducado() && enlaces.length > 0 && !enlaces.some((enlace) => enlace.conectado) && (snapshot.cuentas ?? []).length === 0
  }

  // While the welcome shows, the engine knocks on the primary link's port every 5 s (TCP only,
  // nothing connects), so the page can say whether TWS already answers there — the step the
  // user is most likely stuck on. undefined until the first knock lands.
  const [puertoPrincipal, fijarPuertoPrincipal] = createSignal<boolean | undefined>()

  createEffect(() => {
    if (!primerArranque()) return

    const enlace = (snapshot.enlaces ?? [])[0]

    if (enlace?.port === null || enlace?.port === undefined) return

    const tocar = () =>
      void detectarPuertosIbkr(sdk.api, { host: enlace.host ?? undefined, port: enlace.port ?? undefined }).then((filas) => fijarPuertoPrincipal(filas?.[0]?.open))

    tocar()
    const temporizador = setInterval(tocar, 5_000)
    onCleanup(() => clearInterval(temporizador))
  })

  // The panic: every running system stops, its scheduled tasks stand down and the emergency
  // close-all sweeps the open positions (P-6). A misfire costs the user's own pool, so the
  // write sits behind the two-step dialog and the verdict rides the engine's own message.
  const ejecutarPánico = async () => {
    if (snapshot.demo || escrituras()) return

    fijarEscrituras(true)
    const respuesta = await panicoTotal(sdk.api)
    fijarEscrituras(false)

    if (respuesta === undefined) showToast({ variant: "error", title: language.t("trading.engine.panic.failed") })
    else if (respuesta.close.ok)
      showToast({ variant: "success", icon: "circle-check", title: language.t("trading.engine.panic.sent"), description: textoVeredicto(respuesta, language) })
    else showToast({ variant: "error", title: language.t("trading.engine.panic.failed"), description: textoVeredicto(respuesta, language) })

    await refrescar()
  }

  // The summary reads the beat's own snapshot: what this panic stops and what its close-all
  // actually closes, named, so the reader confirms against facts the desk actually holds.
  // The close-all sweeps the connection's own exposure — the engine's closable read, not
  // every open position the whole login sees — so a multi-account login no longer has the
  // dialog promising rows the panic leaves standing (P-1): those it does not close are
  // named apart. An engine without the closable read keeps the plain exposure as the list;
  // one without any exposure read keeps the shown view.
  const noCerrablesPánico = () => {
    const abiertas = snapshot.exposicion
    const cerrables = snapshot.exposicionCerrable

    if (abiertas === null || cerrables === null) return []

    // The rows carry no account, so positions match by symbol: each closable row covers one open
    // row of its symbol, and a symbol whose open rows outrun its closable ones still leaves
    // positions standing, so it names in the line too.
    const porCerrar = new Map<string, number>()
    for (const posición of cerrables) porCerrar.set(posición.simbolo, (porCerrar.get(posición.simbolo) ?? 0) + 1)

    const sobrantes = new Set<string>()
    for (const posición of abiertas) {
      const quedan = porCerrar.get(posición.simbolo) ?? 0
      if (quedan > 0) porCerrar.set(posición.simbolo, quedan - 1)
      else sobrantes.add(posición.simbolo)
    }
    return [...sobrantes]
  }

  const abrirPánico = () =>
    dialog.show(() => (
      <DialogPánico
        confirmar={ejecutarPánico}
        sistemas={snapshot.bots.filter((bot) => bot.activo || bot.enMarcha).map((bot) => bot.nombre)}
        posiciones={(snapshot.exposicionCerrable ?? snapshot.exposicion ?? snapshot.posiciones).map((posición) => posición.simbolo)}
        noCerrables={noCerrablesPánico()}
        mt5={(snapshot.enlaces ?? []).some((enlace) => enlace.broker === "mt5" && enlace.conectado)}
      />
    ))

  // Switching the account is a read-side move (the engine serves every field of the selected
  // account): a settled switch needs no toast — the sidebar tree's pressed mark answers; a
  // failed one reports itself. Sample data never writes (its ids are the sample's).
  const ejecutarCambioCuenta = async (accountID: string) => {
    if (snapshot.demo) return

    const respuesta = await seleccionarCuenta(sdk.api, accountID)

    if (respuesta === undefined) showToast({ variant: "error", title: language.t("trading.accounts.select.failed") })
    await refrescar()
  }

  // Registering a link starts a balance watch: the wizard's step carries the form (the MT5
  // step arrives with its account list from this computer's search), the confirm runs the
  // registration, and the verdict comes back in the toast. A refusal keeps the dialog on
  // its step, its description carrying the message that came back — the engine's honest
  // refusal where a platform still has no read bridge (NT), the transport's for a server
  // that is down; an unexplained rejection stays title-only.
  const ejecutarEnlaceNuevo = async (entrada: { broker: "ibkr" | "mt5"; host?: string; port?: number; label?: string; live?: boolean; mt5Login?: number; mt5Server?: string }) => {
    const respuesta = await añadirEnlace(sdk.api, entrada).catch((causa: unknown) => errorMessage(causa, language.t("trading.accounts.add.failed")))

    if (typeof respuesta === "string") {
      const falla = language.t("trading.accounts.add.failed")

      showToast({ variant: "error", title: falla, description: respuesta === falla ? undefined : respuesta })

      return false
    }

    showToast({ variant: "success", icon: "circle-check", title: language.t("trading.accounts.add.sent") })
    await refrescar()

    return true
  }

  // The systems folder pick: the desktop's own folder picker, then the engine checks the folder
  // holds systems and reloads the pool from it. Its refusal reads as the toast's description.
  const ejecutarCarpeta = async () => {
    if (platform.platform !== "desktop") return

    const elegida = await platform.openDirectoryPickerDialog({ title: language.t("trading.systems.folder.pick") })
    const dir = Array.isArray(elegida) ? elegida[0] : elegida

    if (!dir) return

    const respuesta = await elegirCarpetaSistemas(sdk.api, dir).catch((causa: unknown) => errorMessage(causa, language.t("trading.systems.folder.failed")))

    if (typeof respuesta === "string") {
      const falla = language.t("trading.systems.folder.failed")

      showToast({ variant: "error", title: falla, description: respuesta === falla ? undefined : respuesta })

      return
    }

    showToast({ variant: "success", icon: "circle-check", title: language.plural("trading.systems.folder.loaded", respuesta.systems) })
    await refrescar()
  }

  // The wizard's search asks the engine once per invocation: the scan of this computer's
  // terminal folders plus the live terminal's own reading (undefined when the server did
  // not answer — its own "try again" line, not a throw).
  // The MT5 search the wizard rides (M-04): disk-only by default — with nothing opened —
  // and the wizard's own button picks the probe, which may open a closed terminal.
  const buscarCuentasMT5 = (probe: boolean) => sdk.api.experimental.trading.mt5.detect(probe ? { probe: true } : undefined).catch(() => undefined)

  const abrirEnlaceNuevo = () =>
    dialog.show(() => (
      <DialogCuentaNueva
        registrar={ejecutarEnlaceNuevo}
        buscar={buscarCuentasMT5}
        detectar={(entrada) => detectarPuertosIbkr(sdk.api, entrada)}
        enlaces={() => (snapshot.enlaces ?? []).map((enlace) => enlace.id)}
      />
    ))

  const ejecutarEnlaceFuera = async (linkID: string) => {
    const respuesta = await quitarEnlace(sdk.api, linkID)

    if (respuesta === undefined) {
      showToast({ variant: "error", title: language.t("trading.accounts.link.remove.failed") })
      await refrescar()

      return
    }

    showToast({ variant: "success", icon: "circle-check", title: language.t("trading.accounts.link.removed") })
    await refrescar()
  }

  // The confirmation's body names the link that leaves, label included; registered links
  // only — the primary sits above the remove rows by construction.
  const abrirEnlaceFuera = (id: string, etiqueta: string | null) => {
    dialog.show(() => (
      <DialogCierre
        avisa={false}
        confirmar={() => ejecutarEnlaceFuera(id)}
        título={language.t("trading.accounts.link.remove.title")}
        cuerpo={`${id}${etiqueta === null ? "" : ` · ${etiqueta}`}`}
        advertencia=""
        confirmarTexto={language.t("trading.accounts.link.remove.confirm")}
      />
    ))
  }

  // The sidebar tree bridge (nav-estado): the callbacks register once — their closures read
  // this live snapshot at each call, so the tree always acts on the engine's current row —
  // while the fields follow every snapshot refresh through the effect below.
  fijarNavArbol((previa) => ({
    ...previa,
    cambiarCuenta: (accountID) => void ejecutarCambioCuenta(accountID),
    conmutarSistema: (systemID) => {
      const bot = snapshot.bots.find((candidato) => candidato.id === systemID)

      if (bot) void fijarSistema(bot)
    },
    fichaSistema: (systemID) => {
      const bot = snapshot.bots.find((candidato) => candidato.id === systemID)

      if (bot) abrirFicha(bot)
    },
    arrancarSistemas: abrirArrancarTodos,
    pararSistemas: abrirPararTodos,
    quitarEnlace: (enlaceID) => {
      const enlace = (snapshot.enlaces ?? []).find((candidato) => candidato.id === enlaceID)
      abrirEnlaceFuera(enlaceID, enlace?.etiqueta ?? null)
    },
    registrarEnlace: abrirEnlaceNuevo,
    elegirCarpeta: () => void ejecutarCarpeta(),
    conectarPrincipal: () => void ejecutarEnlace("conectar"),
  }))

  // One projection per tree array, memoized: a poll that only ticks a P/L figure remaps
  // just that array, and each branch below reconciles only when its own input moved.
  const navSistemas = createMemo(() =>
    snapshot.bots.map((bot) => ({
      id: bot.id,
      nombre: bot.nombre || bot.id,
      enMarcha: !!(bot.activo || bot.enMarcha),
      pnl_dia: bot.pnl_dia,
      simbolo: bot.simbolo,
      temporalidad: bot.temporalidad,
      actividad: bot.actividad,
    })),
  )

  const navCuentas = createMemo(() => (snapshot.cuentas ?? []).map((cuenta) => ({ id: cuenta.id, pnl_dia: cuenta.pnl_dia, enlace: cuenta.enlace, demo: cuenta.demo })))

  const navEnlaces = createMemo(() => (snapshot.enlaces ?? []).map((enlace) => ({ id: enlace.id, etiqueta: enlace.etiqueta, broker: enlace.broker, conectado: enlace.conectado })))

  // The desk's log panel rides the same bridge: the merged record (ring + trades), the
  // newest rows the sidebar's panel shows reversed — one computation shared by both readers.
  const navRegistros = registroUnido

  // The scalar gates are cheap reads (no mapping) and must land whether or not an array
  // changed; they mirror the section page's own mass buttons — the tree header's
  // start/stop pair shares them.
  createEffect(() => {
    fijarNavArbol("sincronizado", true)
    fijarNavArbol("activa", snapshot.cuenta.id)
    const libre = !snapshot.demo && !escrituras() && !caducado()
    fijarNavArbol("puedeArrancar", libre && activos() < snapshot.bots.length)
    fijarNavArbol("puedeParar", libre && activos() > 0)
    fijarNavArbol("puedeConectar", libre)
    fijarNavArbol("conectando", conectando())
    fijarNavArbol("carpeta", snapshot.carpetaSistemas)
    fijarNavArbol("puedeElegirCarpeta", platform.platform === "desktop" && libre && activos() === 0)
  })
  createEffect(on(navSistemas, (v) => fijarNavArbol("sistemas", reconcile(v))))
  createEffect(on(navCuentas, (v) => fijarNavArbol("cuentas", reconcile(v))))
  createEffect(on(navEnlaces, (v) => fijarNavArbol("enlaces", reconcile(v))))
  createEffect(on(navRegistros, (v) => fijarNavArbol("registros", reconcile(v))))

  onMount(() => {
    void refrescar()

    const temporizador = setInterval(() => {
      void refrescar()
    }, REFRESCO_MS)

    onCleanup(() => clearInterval(temporizador))
  })

  // Unlinked, the label says why from TWS's own state: nothing opens on its own, so TWS reads
  // "closed" until the user's own Conectar click opens it and its sign-in is awaited.
  // The header speaks of the account on screen: an MT5 account's terminal, or TWS for an
  // IBKR one (either opens only behind the user's own connect or account search).
  const enlaceMT5Vivo = () =>
    (snapshot.enlaces ?? []).some((enlace) => enlace.id === snapshot.cuenta.enlace && enlace.broker === "mt5" && enlace.conectado)

  const etiquetaMotor = () => {
    if (snapshot.demo) return language.t("trading.engine.demo")

    if (cuentaMT5()) {
      if (enlaceMT5Vivo()) return language.t("trading.programs.mt5.linked")

      const mt5 = snapshot.programas?.mt5

      if (mt5 === "opening") return language.t("trading.programs.mt5.opening")
      if (mt5 === "missing") return language.t("trading.programs.mt5.missing")
      if (mt5 === "closed") return language.t("trading.programs.mt5.closed")

      return language.t("trading.programs.mt5.waiting")
    }

    if (snapshot.enlace) return language.t("trading.engine.linked")

    if (snapshot.clienteOcupado !== null) return language.t("trading.programs.tws.clientInUse.label")

    const tws = snapshot.programas?.tws

    if (tws === "opening") return language.t("trading.programs.tws.opening")
    if (tws === "running") return language.t("trading.programs.tws.waiting")
    if (tws === "missing") return language.t("trading.programs.tws.missing")
    if (tws === "closed") return language.t("trading.programs.tws.closed")

    return language.t("trading.engine.offline")
  }

  // The program notices: each only on the account it concerns (TWS's on an IBKR account,
  // MetaTrader 5's on an MT5 one), and any of them can be put away for this window's run.
  // The API hint waits: signing in to TWS takes a while, so it shows only once TWS has been
  // open a minute without taking the app.
  const [avisos, fijarAvisos] = createStore({ apiVisible: false, ocultos: [] as string[] })

  createEffect(() => {
    if (snapshot.programas?.tws !== "running" || snapshot.enlace) return fijarAvisos("apiVisible", false)

    const temporizador = setTimeout(() => fijarAvisos("apiVisible", true), AVISO_API_MS)
    onCleanup(() => clearTimeout(temporizador))
  })

  const avisosProgramas = createMemo(() => {
    const programas = snapshot.programas

    if (snapshot.demo || !programas) return []

    const puerto = (snapshot.enlaces ?? [])[0]?.port ?? 7497
    const lista: { clave: string; texto: string; descarga?: { url: string; etiqueta: string } }[] = []

    if (cuentaMT5()) {
      if (programas.mt5 === "missing")
        lista.push({
          clave: "mt5",
          texto: language.t("trading.programs.mt5.missing.body"),
          descarga: { url: DESCARGA_MT5, etiqueta: language.t("trading.programs.download.mt5") },
        })
    } else if (programas.tws === "missing")
      lista.push({
        clave: "tws",
        texto: language.t("trading.programs.tws.missing.body"),
        descarga: { url: DESCARGA_TWS, etiqueta: language.t("trading.programs.download.tws") },
      })
    // A taken client id is TWS answering and refusing, not an API switch left off: say that instead.
    else if (snapshot.clienteOcupado !== null)
      lista.push({ clave: "cliente", texto: language.t("trading.programs.tws.clientInUse", { id: String(snapshot.clienteOcupado) }) })
    else if (avisos.apiVisible)
      lista.push({ clave: "api", texto: language.t("trading.programs.tws.api", { port: String(puerto) }) })

    return lista.filter((aviso) => !avisos.ocultos.includes(aviso.clave))
  })

  const puntoMotor = () => ((cuentaMT5() ? enlaceMT5Vivo() : snapshot.enlace) ? "bg-v2-state-fg-success" : "bg-v2-state-fg-danger")

  // The account view's gate follows the READING, not the panel's own link: a registered
  // link can serve the selected account while the panel's (demo) link is away. Old
  // engines carry no link on their account, so the panel's connection stays their gate.
  const leyendoConectado = createMemo(() => {
    if (snapshot.enlace) return true
    const enlaceCuenta = snapshot.cuenta.enlace

    return enlaceCuenta !== null && enlaceCuenta !== "" && (snapshot.enlaces ?? []).some((enlace) => enlace.id === enlaceCuenta && enlace.conectado)
  })

  // The account the close buttons' orders settle on (the engine's own rule): the active
  // account while it lives on the primary link, otherwise the primary link's first one.
  // Named beside the buttons so the numbers on the card and the orders never lead
  // different accounts tacitly.
  const órdenes = () => {
    // An MT5 account takes its own orders, in its own terminal.
    if (cuentaMT5()) return snapshot.cuenta.id

    const primario = (snapshot.enlaces ?? [])[0]

    if (!primario) return null

    if (snapshot.cuenta.enlace === primario.id) return snapshot.cuenta.id

    return (snapshot.cuentas ?? []).find((cuenta) => cuenta.enlace === primario.id)?.id ?? null
  }

  // The header's account identity: the reading account, its broker, demo or real money
  // (MT5 names it, IBKR keeps the DU-prefix rule) and its role — the desk's orders settle on
  // it or it is only watched. Engines without links leave the role unnamed.
  const identidad = () => {
    const cuenta = snapshot.cuenta

    if (cuenta.id === "") return undefined

    const enlace = (snapshot.enlaces ?? []).find((candidato) => candidato.id === cuenta.enlace)

    return {
      id: cuenta.id,
      broker: enlace?.broker ?? "ibkr",
      demo: cuenta.demo ?? cuenta.id.startsWith("DU"),
      rol: snapshot.enlaces === null ? undefined : órdenes() === cuenta.id ? ("opera" as const) : ("vigila" as const),
    }
  }

  // The shown account lives on an MT5 link: its orders and closes go to its own terminal.
  const cuentaMT5 = () =>
    (snapshot.enlaces ?? []).some((enlace) => enlace.id === snapshot.cuenta.enlace && enlace.broker === "mt5")

  // Whether the shown account can take orders right now: an MT5 account while its bridge
  // reads the terminal, an IBKR one while the engine's TWS socket is up.
  const puedeOrdenar = () =>
    cuentaMT5()
      ? (snapshot.enlaces ?? []).some((enlace) => enlace.id === snapshot.cuenta.enlace && enlace.conectado)
      : snapshot.enlace

  // Whether the account on screen is the one the desk's orders reach: a watched account (MT5,
  // a read-only link) shows its positions without any close control. Engines without links
  // name no role and keep the controls, as before.
  const operaVista = () => identidad()?.rol !== "vigila"

  // Leaving the trading account disarms the manual-close switch, so coming back never finds
  // it armed from a view whose rows it could not act on.
  createEffect(() => {
    if (!operaVista()) fijarCierreManual(false)
  })

  // The open P/L: the positions' own figures summed; unknown until one of them carries a
  // number, zero with the read live and nothing open.
  const pnlAbierto = createMemo(() => {
    const valores = snapshot.posiciones.flatMap((posición) => (posición.pnl === null ? [] : [posición.pnl]))

    if (valores.length === 0) return snapshot.posiciones.length === 0 ? 0 : null

    return valores.reduce((suma, valor) => suma + valor, 0)
  })

  return (
    <div class="flex-1 min-h-0 flex flex-col gap-2 px-[var(--shell-inline-inset,8px)] pb-[var(--shell-bottom-inset,8px)] pt-[var(--shell-top-inset,8px)]">
      {/* The desk's dictation hold lives on the shell itself so it answers wherever the focus
          sits even when the chat has no composer yet: the recording starts on the press, the
          reveal opens the chat and the take rides the mailbox into the composer it brings up. */}
      <DictationHoldListener reveal={revelarChat} />
      <div ref={filaPaneles} data-slot="trading-panes" class="relative flex-1 min-h-0 flex flex-col md:flex-row gap-2">
        {/* The session's native screen wraps its row in a root wrapper that reaches the shell's
            bands (inline padding plus bottom/top insets) and rows its panes behind a single 8px
            gap. Trading mirrors both verbatim: on desktop that gap is the only seam between the
            dashboard's frame and the chat's face, and the resize handle floats its pill in the
            gap (class plus edge="start"), the way the session's handles float theirs with
            "-end-1" and "-start-1". */}
        <div ref={panelDashboard} data-slot="trading-panel" class="relative z-10 min-w-0 shrink-0 flex flex-col min-h-0 h-full flex-1 md:flex-none">
          {/* The dashboard's own raised frame, drawn the way the session panel draws its card;
              the header and scroller inside are the dashboard's alone. */}
          <SessionPanelFrame raised>
            <header
              class="@container flex shrink-0 items-center gap-3 border-b border-v2-border-border-muted ps-6 py-3"
              // The chat toggle sits at the row's top-right corner in every state: over the
              // chat's own sticky bar with the chat open on desktop (the header keeps normal
              // padding there), over this corner otherwise — stacked, the chat is a row
              // below this header, so the corner is always the dashboard's and reserves
              // the toggle's width in both of its states.
              classList={{
                "pe-[44px]": !props.abierto() || !escritorio(),
                "pe-6": props.abierto() && escritorio(),
              }}
            >
              <div class="flex min-w-0 flex-1 items-center gap-2">
                <h1 class="shrink-0 text-[15px] text-v2-text-text-base font-medium" style={{ "line-height": "var(--line-height-base)" }}>
                  {/* The dashboard has one page — the desk — on every layout: the heading is the
                      desk's own name, and nothing in the strip ever pages the center. */}
                  {language.t("trading.positions")}
                </h1>
                {/* The engine state beside the title it belongs to: the dot and its words.
                    The words fold away first when the header narrows. */}
                <span
                  class={`size-1.5 shrink-0 rounded-full ${puntoMotor()}`}
                  title={etiquetaMotor()}
                  role="img"
                  aria-label={etiquetaMotor()}
                />
                <span class="hidden min-w-0 shrink truncate text-[13px] text-v2-text-text-muted @min-[760px]:inline" style={LINEA} aria-hidden="true">
                  {etiquetaMotor()}
                </span>
                {/* The account the sheet reads, named where the eye starts: its id, the
                    broker it lives on, demo or real money, and whether the desk's orders go
                    to it or it is only watched. */}
                <Show when={identidad()}>
                  {(cuenta) => (
                    <div data-slot="trading-account-identity" class="hidden min-w-0 shrink items-center @min-[400px]:flex gap-1.5 overflow-hidden border-s border-v2-border-border-muted ps-2">
                      <span class="min-w-0 truncate font-mono text-[13px] text-v2-text-text-base" style={LINEA}>
                        {cuenta().id}
                      </span>
                      <span class="hidden shrink-0 text-[11px] text-v2-text-text-muted @min-[600px]:inline" style={LINEA}>
                        {language.t(`trading.accounts.broker.${cuenta().broker}`)}
                      </span>
                      <span
                        class={`shrink-0 rounded-full border px-1.5 text-[11px] ${cuenta().demo ? "border-v2-border-border-muted text-v2-state-fg-info" : "border-v2-state-border-warning text-v2-state-fg-warning"}`}
                        style={LINEA}
                      >
                        {language.t(cuenta().demo ? "trading.accounts.mode.demo.short" : "trading.accounts.mode.live.short")}
                      </span>
                      <Show when={cuenta().rol}>
                        {(rol) => (
                          <span class="hidden shrink-0 text-[11px] text-v2-text-text-muted @min-[680px]:inline" style={LINEA}>
                            {language.t(rol() === "opera" ? "trading.accounts.link.role.trades" : "trading.accounts.link.role.watch")}
                          </span>
                        )}
                      </Show>
                    </div>
                  )}
                </Show>
              </div>
              {/* The link's controls and the emergency ride the header's own row, so they stay
                  findable with the link down too (the wound the audit cut). A sample pool has
                  nothing real to write (the demo stays read-only) and a snapshot the engine
                  stopped answering offers nothing it could not reach; while a write runs the
                  group stands down, one engine write at a time like every other control. */}
              <Show when={!snapshot.demo && !caducado()}>
                <div class="shrink-0 flex items-center gap-1">
                  <Show
                    when={snapshot.enlace}
                    fallback={
                      <Button type="button" variant="ghost-muted" size="small" icon="globe" disabled={escrituras()} onClick={() => ejecutarEnlace("conectar")}>
                        {language.t("trading.engine.connect")}
                      </Button>
                    }
                  >
                    <Button type="button" variant="ghost-muted" size="small" icon="close" disabled={escrituras()} onClick={() => ejecutarEnlace("desconectar")}>
                      {language.t("trading.engine.disconnect")}
                    </Button>
                  </Show>
                  {/* The emergency stands apart from the link's own controls. */}
                  <span class="mx-1 h-4 w-px shrink-0 bg-v2-border-border-muted" aria-hidden="true" />
                  <Button type="button" variant="ghost-danger" size="small" icon="outline-hexagonal-warning" disabled={escrituras()} onClick={abrirPánico}>
                    {language.t("trading.engine.panic")}
                  </Button>
                </div>
              </Show>
            </header>
            {/* The strip hosts the dashboard's nav on every layout: the docked panels and the
                pinned log under the titlebar's center line (see the comment beside the
                route's nav rule). */}
            <div class="flex shrink-0 items-center border-b border-v2-border-border-muted px-4 py-2">
              <TradingNavStrip />
            </div>
            {/* The KPI band sits pinned under the header, outside the scroll: the desk's
                headline numbers stay readable wherever the body scrolls, and the connect note
                takes its own line below them. Without a live read the slots read dashes —
                the band holds its shape until the engine answers again, on every layout: the
                desk is one page, and nothing in the strip ever pages the center. */}
            <div class="@container flex shrink-0 flex-col gap-2 border-b border-v2-border-border-muted px-6 py-3">
              {/* Money first (net worth, the day, what is still open, what is banked),
                  then the desk's own load (systems running, margin in use): one row of six
                  when the band is wide, two balanced rows of three, or three rows of two. */}
              <div class="grid min-w-0 grid-cols-2 gap-x-4 gap-y-3 @min-[360px]:gap-x-8 @min-[520px]:grid-cols-3 @min-[1000px]:grid-cols-6">
                <CifraKpi etiqueta={language.t("trading.account.netWorth")} valor={formatoUSD(leyendoConectado() ? snapshot.cuenta.patrimonio : null)} />
                <CifraKpi
                  etiqueta={language.t("trading.account.pnlToday")}
                  valor={`${flechaPnl(leyendoConectado() ? snapshot.cuenta.pnl_dia : null)}${formatoUSD(leyendoConectado() ? snapshot.cuenta.pnl_dia : null)}`}
                  tono={tonoPnl(leyendoConectado() ? snapshot.cuenta.pnl_dia : null)}
                />
                <CifraKpi
                  etiqueta={language.t("trading.account.pnlOpen")}
                  valor={`${flechaPnl(leyendoConectado() ? pnlAbierto() : null)}${formatoUSD(leyendoConectado() ? pnlAbierto() : null)}`}
                  tono={tonoPnl(leyendoConectado() ? pnlAbierto() : null)}
                />
                <CifraKpi
                  etiqueta={language.t("trading.account.pnlRealized")}
                  valor={`${flechaPnl(leyendoConectado() ? snapshot.cuenta.pnl_realizado : null)}${formatoUSD(leyendoConectado() ? snapshot.cuenta.pnl_realizado : null)}`}
                  tono={tonoPnl(leyendoConectado() ? snapshot.cuenta.pnl_realizado : null)}
                />
                <CifraKpi
                  etiqueta={language.t("trading.account.systemsRunning")}
                  valor={snapshot.bots.length === 0 ? "—" : `${activos()} / ${snapshot.bots.length}`}
                  tono={activos() > 0 ? "text-v2-state-fg-success" : undefined}
                />
                <CifraKpi etiqueta={language.t("trading.account.margin")} valor={formatoUSD(leyendoConectado() ? snapshot.cuenta.margenUsado : null)} />
              </div>
              <Show when={!leyendoConectado() && !primerArranque()}>
                <p class="min-w-0 truncate text-[13px] text-v2-text-text-muted" style={LINEA}>
                  {language.t("trading.account.offline")}
                </p>
              </Show>
            </div>

            {/* Plain wheel/drag scrolling: the shared bar would paint as a stray pill hugging the
                panel's edge — detached from the rows by their trailing cushion — and flash on and
                off while the window narrows, the way the app's own tab rail hides its scrollbar. */}
            <div data-scrollable class="min-h-0 flex-1 overflow-x-auto overflow-y-auto no-scrollbar">
              <For each={avisosProgramas()}>
                {(aviso) => (
                  <div
                    data-slot="trading-program-notice"
                    class="mx-4 mt-4 flex items-center gap-3 rounded-[8px] border border-v2-state-border-warning bg-v2-state-bg-warning px-3 py-2"
                  >
                    <p class="min-w-0 flex-1 text-[13px] text-v2-state-fg-warning" style={LINEA}>
                      {aviso.texto}
                    </p>
                    <Show when={aviso.descarga}>
                      {(descarga) => (
                        <Button type="button" variant="neutral" size="small" onClick={() => platform.openExternal(descarga().url)}>
                          {descarga().etiqueta}
                        </Button>
                      )}
                    </Show>
                    <IconButton
                      type="button"
                      variant="ghost-muted"
                      size="small"
                      aria-label={language.t("trading.programs.dismiss")}
                      icon={<Icon name="close" />}
                      onClick={() => fijarAvisos("ocultos", (ocultos) => [...ocultos, aviso.clave])}
                    />
                  </div>
                )}
              </For>
              <Show
                // A lost engine answer with real values on screen: the sections below stand
                // still on the last values the engine sent, so the line says so — sample
                // data already says its own story in the dot.
                when={caducado() && !snapshot.demo}
              >
                <p
                  class="mx-4 mt-4 rounded-[8px] border border-v2-state-border-warning bg-v2-state-bg-warning px-3 py-2 text-[13px] text-v2-state-fg-warning"
                  style={LINEA}
                >
                  {language.t("trading.engine.stale")}
                </p>
              </Show>
              {/* The connect welcome sits on the desk body: while the engine link is still
                  first coming up, the welcome carries the API hint instead of empty numbers. */}
              <Show when={primerArranque()}>
                <BienvenidaConexión
                  puerto={(snapshot.enlaces ?? [])[0]?.port ?? null}
                  dirección={(snapshot.enlaces ?? [])[0]?.id ?? ""}
                  conectando={conectando()}
                  responde={puertoPrincipal()}
                  ocupado={escrituras()}
                  conectar={() => void ejecutarEnlace("conectar")}
                  detener={() => void ejecutarEnlace("desconectar")}
                  añadir={abrirEnlaceNuevo}
                />
              </Show>
              <Show when={!primerArranque()}>
                <div class="flex w-full flex-col gap-4 px-6 py-4">
                  {/* The curve opens the body: the day P/L series drawn wide, or a reserved
                      row of dashes when the read is not live — the body's height holds until
                      the engine answers again. */}
                  <CurvaDia curva={snapshot.curva} caída={!leyendoConectado()} />
                  {/* The account's own dossier rides behind a disclosure: closed at rest so
                      the sheet leads with the action; opening it lays every account fact —
                      the admin lines (id, type) and the wallet figures alike — whatever the
                      read's state, dashes included. */}
                  <div class="flex flex-col">
                    <button
                      type="button"
                      class="flex h-7 items-center gap-1.5 self-start rounded-[6px] px-1 text-[13px] text-v2-text-text-muted hover:text-v2-text-text-base"
                      style={{ "line-height": "var(--line-height-compact)" }}
                      onClick={() => fijarDetalles(!detalles())}
                      aria-expanded={detalles()}
                    >
                      <Icon name={detalles() ? "chevron-down" : "chevron-right"} class="shrink-0" />
                      <span class="min-w-0 truncate">{language.t("trading.account.details")}</span>
                    </button>
                    <Show when={detalles()}>
                      <dl class="grid gap-x-10 pt-2 md:grid-cols-2">
                        <MetaCuenta etiqueta={language.t("trading.account.id")} mono>
                          {snapshot.cuenta.id || "—"}
                        </MetaCuenta>
                        {/* The demo's own label ("Demo (paper) · IBKR") lives in the dictionaries, like the engine's
                            row keys; the snapshot's value stays the data it was, only rendered when real. */}
                        <MetaCuenta etiqueta={language.t("trading.account.type")}>{snapshot.demo ? language.t("trading.demo.account.type") : snapshot.cuenta.tipo || "—"}</MetaCuenta>
                        <MetaCuenta etiqueta={language.t("trading.account.cash")}>{formatoUSD(snapshot.cuenta.efectivo)}</MetaCuenta>
                        <MetaCuenta etiqueta={language.t("trading.account.available")}>{formatoUSD(snapshot.cuenta.disponible)}</MetaCuenta>
                        <MetaCuenta etiqueta={language.t("trading.account.buyingPower")}>{formatoUSD(snapshot.cuenta.compraPoder)}</MetaCuenta>
                        <MetaCuenta etiqueta={language.t("trading.account.margin")}>{formatoUSD(snapshot.cuenta.margenUsado)}</MetaCuenta>
                        <MetaCuenta etiqueta={language.t("trading.account.excess")}>{formatoUSD(snapshot.cuenta.liquidezExtra)}</MetaCuenta>
                        <MetaCuenta etiqueta={language.t("trading.account.updated")}>{momentoNulo(snapshot.cuenta.actualizada, formatoMomento)}</MetaCuenta>
                      </dl>
                    </Show>
                  </div>
                  {/* The positions block rides the sheet: the manual-close opt-in plus the row
                      per open position, everything the section owned before the merge. */}
                  <div class="flex flex-col gap-2">
                    <div class="flex items-center justify-end gap-2">
                      <Show when={órdenes()}>
                        <p class="me-auto min-w-0 truncate text-[11px] text-v2-text-text-muted" style={LINEA}>
                          {language.t("trading.positions.orders", { account: órdenes() ?? "" })}
                        </p>
                      </Show>
                      {/* A watched account (an MT5 terminal, a read-only link) shows its own
                          positions, but the desk's orders only ever reach the trading
                          connection's account: its close controls stay away entirely. */}
                      <Show
                        when={operaVista()}
                        fallback={
                          <p class="shrink-0 text-[11px] text-v2-text-text-muted" style={LINEA}>
                            {language.t("trading.positions.readOnly")}
                          </p>
                        }
                      >
                        <Switch appearance="compact" checked={cierrePermitido()} onChange={fijarCierreManual}>
                          {language.t("trading.positions.closing")}
                        </Switch>
                      </Show>
                      {/* The emergency close-all runs on the IBKR link; an MT5 account closes row by row. */}
                      <Show when={cierrePermitido() && operaVista() && !cuentaMT5()}>
                        <Tooltip class="shrink-0" placement="bottom" value={language.t("trading.positions.closeAll")}>
                          <IconButton
                            type="button"
                            variant="ghost-muted"
                            size="small"
                            // Orders go through the engine's TWS socket: no write without it, and
                            // not until the engine answers again (the stale read above).
                            disabled={snapshot.posiciones.length === 0 || !snapshot.enlace || caducado()}
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={abrirCierreTotal}
                            aria-label={language.t("trading.positions.closeAll")}
                            icon={<Icon name="close" />}
                          />
                        </Tooltip>
                      </Show>
                    </div>
                    <Show when={snapshot.posiciones.length > 0} fallback={<p class="px-1 text-[13px] text-v2-text-text-muted">{language.t("trading.positions.empty")}</p>}>
                      {/* One table: a caption row, then a row per position on the same column
                          grid, numbers right-aligned so the figures stack. The system column
                          names the running systems on the contract's family (the ones that could
                          reopen it after a close). */}
                      <div class="@container flex flex-col" role="table" aria-label={language.t("trading.positions")}>
                        <div role="row" class={`${COLUMNAS_POSICIÓN} border-b border-v2-border-border-muted pb-1 text-[11px] tracking-[0.08em] text-v2-text-text-muted uppercase`} style={LINEA}>
                          <span role="columnheader">{language.t("trading.positions.col.symbol")}</span>
                          <span role="columnheader">{language.t("trading.positions.col.side")}</span>
                          <span role="columnheader" class="text-end">{language.t("trading.positions.col.size")}</span>
                          <span role="columnheader" class={`text-end ${COLUMNA_ANCHA}`}>{language.t("trading.positions.col.entry")}</span>
                          <span role="columnheader" class="text-end">{language.t("trading.positions.col.current")}</span>
                          <span role="columnheader" class="text-end">{language.t("trading.positions.col.pnl")}</span>
                          <span role="columnheader" class="text-end">%</span>
                          <span role="columnheader" class={`truncate ${COLUMNA_ANCHA}`}>{language.t("trading.positions.col.system")}</span>
                          <span role="columnheader" />
                        </div>
                        <For each={snapshot.posiciones}>
                          {(posición) => (
                            <div role="row" class={`${COLUMNAS_POSICIÓN} min-h-8 border-b border-v2-border-border-muted last:border-b-0`}>
                              <span role="cell" class="min-w-0 truncate font-mono text-[13px] text-v2-text-text-base">{posición.simbolo}</span>
                              <span
                                role="cell"
                                class={`text-[11px] ${posición.lado === "corto" ? "text-v2-state-fg-danger" : "text-v2-state-fg-success"}`}
                                style={LINEA}
                              >
                                {language.t(posición.lado === "corto" ? "trading.position.side.short" : "trading.position.side.long")}
                              </span>
                              <span role="cell" class={`text-end text-v2-text-text-base ${NÚMERO}`} style={LINEA}>
                                {posición.tamano}
                              </span>
                              <span role="cell" class={`min-w-0 truncate text-end text-v2-text-text-muted ${NÚMERO} ${COLUMNA_ANCHA}`} style={LINEA}>
                                {formatoPrecio(posición.simbolo, posición.entrada)}
                              </span>
                              <span role="cell" class={`min-w-0 truncate text-end text-v2-text-text-muted ${NÚMERO}`} style={LINEA}>
                                {formatoPrecio(posición.simbolo, posición.actual)}
                              </span>
                              <span role="cell" class={`min-w-0 truncate text-end ${NÚMERO} ${tonoPnl(posición.pnl)}`} style={LINEA}>
                                {formatoUSD(posición.pnl)}
                              </span>
                              <span role="cell" class={`text-end text-[11px] tabular-nums ${tonoPnl(posición.pnl_pct)}`} style={LINEA}>
                                {formatoPct(posición.pnl_pct)}
                              </span>
                              {/* Who holds the position: the running systems on its family, by their
                                  readable names. On the account the engine trades, a position no
                                  running system covers is flagged — a manual trade or an orphan a
                                  stopped bot left behind; a watched account has no bots to ask. */}
                              <span
                                role="cell"
                                class={`min-w-0 truncate text-[12px] ${COLUMNA_ANCHA}`}
                                classList={{
                                  "text-v2-text-text-muted": sistemasSobreSímbolo(posición.simbolo).length > 0 || !operaVista(),
                                  "text-v2-state-fg-warning": sistemasSobreSímbolo(posición.simbolo).length === 0 && operaVista(),
                                }}
                                style={LINEA}
                                title={
                                  sistemasSobreSímbolo(posición.simbolo).map((bot) => bot.nombre).join(", ") ||
                                  (operaVista() ? language.t("trading.position.noSystem.title") : undefined)
                                }
                              >
                                {sistemasSobreSímbolo(posición.simbolo)
                                  .map((bot) => nombreLegible(bot.nombre))
                                  .join(", ") || (operaVista() ? language.t("trading.position.noSystem") : "—")}
                              </span>
                              <span role="cell" class="flex justify-end">
                                <Show when={cierrePermitido() && operaVista()}>
                                  <Tooltip class="shrink-0" placement="bottom" value={language.t("trading.position.close")}>
                                    <IconButton
                                      type="button"
                                      variant="ghost-muted"
                                      size="small"
                                      // Orders need the engine's TWS socket (see close-all).
                                      disabled={!puedeOrdenar() || caducado()}
                                      onMouseDown={(event) => event.preventDefault()}
                                      onClick={() => abrirCierre(posición)}
                                      aria-label={language.t("trading.position.close")}
                                      icon={<Icon name="close" />}
                                    />
                                  </Tooltip>
                                </Show>
                              </span>
                            </div>
                          )}
                        </For>
                      </div>
                    </Show>
                  </div>
                  <OperacionesHoy trades={snapshot.trades} />
                </div>
              </Show>

            </div>
            <p class="shrink-0 px-6 py-2 text-[11px] text-v2-text-text-muted">
              {language.t("trading.disclaimer")}
            </p>
          </SessionPanelFrame>
        </div>

        <Show when={chatVisto()}>
          {/* The chat's header is the session's native sticky title bar, emptied to the same
              bare row the side panel's tabs bar shows: trading.css keeps the bar (opaque bg,
              fade, and the corner spacer for the floating buttons) and hides only its inner
              content — project location, title/menu, cost chip and header icon. The pane
              travels on the app's shared panel motion: the presence stays mounted through
              every flight while the dashboard's painted width carries it, then parks at the
              row's end with its contents skipped, and the content box holds its landing width
              so the chat never rewraps mid-flight (the session side panel's own trick). */}
          <div
            ref={chatPresencia}
            inert={(!chatMotion.present() && escritorio()) || undefined}
            class={
              escritorio() && !chatMotion.present()
                ? // Out of the row, so a closed panel takes no space.
                  "absolute inset-y-0 end-0 w-0 [content-visibility:hidden]"
                : "relative min-h-0 min-w-0 flex-1 flex flex-col"
            }
          >
            <div
              ref={chatContenido}
              data-slot="trading-chat-panel-content"
              class="absolute inset-y-0 start-0 size-full [contain:layout_style]"
              style={{ "--trading-side-content-width": chatAnchoContenido() }}
            >
              {/* The chat's face: the same frame the native side panels draw — base bg, radius
                  and raised shadow — and like them it fills its presence and clips: the held
                  contents pinned at their landing width overflow past the row mid-flight and
                  the face cuts them off, so the shell's band beside the row stays clear while
                  the chat travels. The shell's bands live on the trading root wrapper in both
                  layouts, so trading.css zeroes the shell inset variables the chat's screen
                  reads its padding from — that second round would otherwise stack inside the
                  face (1px stacked, 8px desktop). */}
              <div
                data-slot="trading-chat-face"
                class="absolute top-0 bottom-0 start-0 end-0 flex overflow-hidden rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]"
              >
                <div
                  ref={panelChat}
                  data-slot="trading-chat-panel"
                  id="trading-chat-panel"
                  class="relative h-full min-w-0 flex shrink-0 contain-strict flex-col"
                  style={{ width: "var(--panel-hold-width, var(--trading-side-content-width, 100%))" }}
                >
                  {/* Informational welcome, centered in the timeline's free space (between the emptied
                      native row and the composer's measured top edge, clipped to it). It shows only
                      while the chat is empty — TradingWithSession polls and hides it after the first
                      prompt — and is pointer-events-none. */}
                  {/* The overlay itself stays click-through (the timeline below keeps its
                      gestures); only the suggestion buttons take the pointer. A suggestion
                      writes its question into the composer — the user still sends it. */}
                  <Show when={props.sinMensajes()}>
                    <div
                      ref={bienvenida}
                      data-slot="trading-chat-welcome"
                      class="pointer-events-none absolute inset-x-0 top-[48px] z-20 flex flex-col items-center justify-center gap-3 overflow-hidden px-6"
                      style={{ bottom: `${hueco.abajo}px` }}
                    >
                      <p ref={bienvenidaNota} class="text-center text-[13px] leading-5 text-v2-text-text-muted">
                        {language.t("trading.chat.welcome")}
                      </p>
                      {/* Out of the flow while they do not fit, so they keep a measurable size
                          and come back the moment the space does. */}
                      <div
                        ref={bienvenidaOpciones}
                        class="flex max-w-[420px] flex-wrap justify-center gap-1.5"
                        classList={{ "invisible absolute": !hueco.opciones }}
                        aria-hidden={!hueco.opciones || undefined}
                      >
                        <For each={SUGERENCIAS_CHAT}>
                          {(clave) => (
                            <button
                              type="button"
                              class="pointer-events-auto rounded-full border border-v2-border-border-muted px-2.5 py-1 text-[12px] text-v2-text-text-muted hover:bg-v2-background-bg-layer-02 hover:text-v2-text-text-base"
                              style={LINEA}
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={() => sugerir(language.t(clave))}
                            >
                              {language.t(clave)}
                            </button>
                          )}
                        </For>
                      </div>
                    </div>
                  </Show>
                  <DictationSurfaceHost reveal={revelarChat}>{props.chat}</DictationSurfaceHost>
                </div>
              </div>
            </div>
            {/* The resize handle rides outside the face — the face clips, and the session's
                own handle lives on its carrier outside the raised frame for the same
                reason. Desktop only: on the stacked layout the pane is full width with
                nothing to resize. */}
            <div classList={{ hidden: !escritorio() }} data-slot="trading-chat-resizer">
              <ResizeHandle
                class="-start-1"
                direction="horizontal"
                edge="start"
                // The handle starts from the width the panel renders, never a raw stored one,
                // so a first move cannot jump.
                size={chatAnchoVivo()}
                min={chatSuelo()}
                max={chatWidthMax()}
                onResize={(anchura) => props.fijarAnchura(anchura)}
                onReset={props.restablecerAnchura}
              />
            </div>
          </div>
        </Show>

        {/* Toggle at the row's top-right corner, always in the same pixels: over the chat when
            it is open, over the reserved dashboard-header slot when it is closed. The prompt
            editor is a chat control, so it stays with the open chat (and never covers the
            dashboard's engine pill). With the chat open the session's native sticky title bar
            (message-timeline, not hidden here) hosts the corner: these buttons land on it the
            same way the app's own review toggle does over regular sessions. */}
        <div class="absolute end-3 top-0 z-30 h-12 flex items-center gap-1" data-slot="trading-chat-toggle">
          <Show when={props.abierto()}>
            <Tooltip placement="bottom" value={language.t("trading.prompt.edit")}>
              <IconButton
                type="button"
                variant="ghost-muted"
                size="large"
                onMouseDown={(event) => event.preventDefault()}
                onClick={abrirPrompto}
                aria-label={language.t("trading.prompt.edit")}
                aria-haspopup="dialog"
                icon={<Icon name="edit" />}
              />
            </Tooltip>
          </Show>
          {botónChat()}
        </div>
      </div>
    </div>
  )
}

/**
 * The close confirmation, shared by the single close and the emergency close-all: it states
 * that the cycle sends real orders and, when a running system trades the same contract
 * family, warns that it may reopen a position. Nothing is written until the confirm button —
 * the engine's close cycle only runs behind this dialog.
 */
function DialogCierre(props: {
  avisa: boolean
  /** Danger (stop/close semantics) by default; a benign wide action reads as primary. */
  tono?: "danger" | "submit"
  confirmar: () => Promise<void>
  título: string
  cuerpo: string
  advertencia: string
  confirmarTexto: string
}) {
  const language = useLanguage()
  const dialog = useDialog()
  const [ejecutando, setEjecutando] = createSignal(false)

  // The parent's run shows its own success/failure toast and resolves either way, so closing
  // behind it is always right. While the write runs its two dismiss paths step aside: the
  // corner button leaves the header and the confirm button loses its click.
  const confirmar = async () => {
    if (ejecutando()) return

    setEjecutando(true)
    await props.confirmar()
    dialog.close()
  }

  return (
    // A confirmation's body is one paragraph (plus its warning line): the normal dialog
    // size — a 640px-wide editor crate would underline a close order.
    <Dialog preventBackdropDismiss>
      <DialogHeader hideClose={ejecutando()}>
        <DialogTitleGroup title={props.título} description={props.cuerpo} />
      </DialogHeader>
      <DialogBody class="px-4 pb-2 -mt-2">
        <Show when={props.avisa}>
          <p class="flex items-start gap-2 text-[13px] text-v2-state-fg-warning" style={LINEA}>
            <Icon name="circle-exclamation" class="mt-0.5 size-3.5 shrink-0" />
            {props.advertencia}
          </p>
        </Show>
        {/* The verdict to read: the submission runs in the engine; dropping this dialog never
            stops it. The cancel quietly stands down so the truth is the only path. */}
        <Show when={ejecutando()}>
          <p class="flex items-start gap-2 text-[13px] text-v2-text-text-muted" style={LINEA}>
            <Loader class="mt-0.5 size-3.5 shrink-0" />
            {language.t("trading.position.dialog.pending")}
          </p>
        </Show>
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="ghost-muted" disabled={ejecutando()} onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </Button>
        <Button type="button" variant={props.tono ?? "danger"} disabled={ejecutando()} onClick={confirmar}>
          {props.confirmarTexto}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}

/**
 * The panic stop's two-step confirmation: the first screen reads the summary against this
 * beat's snapshot — what stops, what the close-all sweeps — and only after that screen the
 * danger button does it. Nothing runs until then; while the write runs, the dismiss paths
 * step aside the way the other confirmations' do, and the honest note stays: the engine owns
 * the running panic, this dialog never could stop it.
 */
function DialogPánico(props: {
  confirmar: () => Promise<void>
  /** The systems the summary's beat shows running; the panic stops every one of them. */
  sistemas: readonly string[]
  /** The open positions the panic's close-all sweeps: the engine's closable exposure — what
   * the connection actually closes — with the plain exposure standing in on engines that
   * predate the closable read, the shown view on ones without any exposure read. */
  posiciones: readonly string[]
  /** Open positions the close-all leaves standing (accounts the login holds that the
   * connection does not close); absent or empty on engines that cannot tell the lists apart. */
  noCerrables?: readonly string[]
  /** A linked MetaTrader 5 account reads live: the panic closes its positions too. */
  mt5: boolean
}) {
  const language = useLanguage()
  const dialog = useDialog()
  const [paso, fijarPaso] = createSignal(0)
  const [ejecutando, setEjecutando] = createSignal(false)

  const confirmar = async () => {
    if (ejecutando()) return

    setEjecutando(true)
    await props.confirmar()
    dialog.close()
  }

  return (
    <Dialog preventBackdropDismiss>
      <DialogHeader hideClose={ejecutando()}>
        <DialogTitleGroup title={language.t("trading.engine.panic.title")} description={language.t("trading.engine.panic.body")} />
      </DialogHeader>
      <DialogBody class="px-4 pb-2 -mt-2">
        <Show
          when={paso() > 0}
          fallback={
            <ul class="flex flex-col gap-1.5 px-1">
              <li class="text-[13px] text-v2-text-text-base" style={LINEA}>
                {language.plural("trading.engine.panic.summary.systems", props.sistemas.length, { systems: props.sistemas.join(", ") })}
              </li>
              <li class="text-[13px] text-v2-text-text-base" style={LINEA}>
                {language.plural("trading.engine.panic.summary.positions", props.posiciones.length, { symbols: props.posiciones.join(", ") })}
              </li>
              <Show when={props.noCerrables?.length}>
                <li class="text-[13px] text-v2-text-text-base" style={LINEA}>
                  {language.t("trading.engine.panic.summary.unclosed", {
                    symbols: props.noCerrables?.join(", ") ?? "",
                  })}
                </li>
              </Show>
              <Show when={props.mt5}>
                <li class="text-[13px] text-v2-text-text-base" style={LINEA}>
                  {language.t("trading.engine.panic.summary.mt5")}
                </li>
              </Show>
              <li class="text-[13px] text-v2-text-text-muted" style={LINEA}>
                {language.t("trading.engine.panic.summary.tasks")}
              </li>
            </ul>
          }
        >
          <Show
            when={ejecutando()}
            fallback={
              <p class="flex items-start gap-2 text-[13px] text-v2-state-fg-warning" style={LINEA}>
                <Icon name="circle-exclamation" class="mt-0.5 size-3.5 shrink-0" />
                {language.t("trading.engine.panic.warning")}
              </p>
            }
          >
            <p class="flex items-start gap-2 text-[13px] text-v2-text-text-muted" style={LINEA}>
              <Loader class="mt-0.5 size-3.5 shrink-0" />
              {language.t("trading.position.dialog.pending")}
            </p>
          </Show>
        </Show>
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="ghost-muted" disabled={ejecutando()} onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </Button>
        <Show
          when={paso() > 0}
          fallback={
            <Button type="button" variant="submit" onClick={() => fijarPaso(1)}>
              {language.t("trading.engine.panic.continue")}
            </Button>
          }
        >
          <Button type="button" variant="danger" disabled={ejecutando()} onClick={confirmar}>
            {language.t("trading.engine.panic.confirm")}
          </Button>
        </Show>
      </DialogFooter>
    </Dialog>
  )
}

/**
 * The system's dossier: its live engine flags, the facts its own files state (config.py's
 * client id, close hour and the activity its record shows; reglas.json's idea and rules),
 * and the tail of its own record, the same rows the record card draws filtered to this one
 * system, live-updating with the dashboard's 3s poll.
 */
function DialogFicha(props: {
  bot: Accessor<BotInfo | undefined>
  registros: Accessor<FilaRegistroNav[]>
  programar: (entrada: { kind: "start-systems" | "stop-systems"; delayMinutes?: number; atTime?: string }) => Promise<unknown>
  /** Starts a stopped system now, or stops a running one: the sidebar row's own toggle. */
  alternar: () => void
  ocupado: Accessor<boolean>
}) {
  const { formatoUSD, formatoMomento } = useFormatos()
  const language = useLanguage()
  const dialog = useDialog()

  // Each field reads the snapshot store once and decides its fallback itself, so the JSX
  // never needs narrowing across separate accessor calls and keeps updating with each poll.
  // The dossier keeps the last row it opened on: a poll that finds the system removed (it
  // left the engine's pool mid-dialog) must not blank the title and flip the state row to
  // Stopped — it stays on the last known identity, with the missing fields reading "—".
  const vista = createMemo<BotInfo | undefined>((anterior) => props.bot() ?? anterior, undefined)

  const pidFicha = () => {
    const valor = vista()?.pid

    return valor === null || valor === undefined ? "—" : `PID ${valor}`
  }

  const arranqueFicha = () => {
    // Day-aware (today reads a bare clock, older days carry their date — see formatoMomento).
    const valor = vista()?.arrancada

    return valor === null || valor === undefined ? "—" : formatoMomento(valor)
  }

  const enMarchaFicha = () => vista()?.enMarcha === true || vista()?.activo === true
  const pnlFicha = () => vista()?.pnl_dia ?? null

  const instrumentoFicha = () => {
    const valor = vista()

    return valor === undefined ? "—" : `${valor.simbolo} · ${valor.temporalidad}`
  }

  const clienteFicha = () => {
    const valor = vista()?.cliente

    return valor === null || valor === undefined ? "—" : String(valor)
  }

  const cierreFicha = () => vista()?.horaCierre ?? "—"

  const actividadFicha = () => {
    // Day-aware like the started row (see formatoMomento).
    const valor = vista()?.actividad

    return valor === null || valor === undefined ? "—" : formatoMomento(valor)
  }

  const marchaFicha = () => {
    // A bare clock keeps it language-neutral: H:MM:SS since the engine (re)attached, re-ticking
    // on every poll the way the other fields do, never claiming precision beyond its beat.
    const valor = vista()?.arrancada

    if (!enMarchaFicha() || valor === null || valor === undefined) return "—"
    const segundos = Math.max(0, Math.floor((Date.now() - valor) / 1000))

    return `${Math.floor(segundos / 3600)}:${String(Math.floor((segundos % 3600) / 60)).padStart(2, "0")}:${String(segundos % 60).padStart(2, "0")}`
  }

  const descripcionFicha = () => vista()?.descripcion ?? null
  const reglasFicha = () => vista()?.reglas ?? null

  return (
    <Dialog size="large" preventBackdropDismiss>
      <DialogHeader>
        <DialogTitleGroup title={nombreLegible(vista()?.nombre ?? "")} description={language.t("trading.ficha.description")} />
      </DialogHeader>
      <DialogBody class="flex min-h-0 flex-1 flex-col gap-3 px-4 pt-1">
        <dl class="grid gap-x-8 md:grid-cols-2 px-1">
          <MetaCuenta etiqueta={language.t("trading.ficha.state")}>
            <span
              class={`me-1.5 inline-block size-1.5 rounded-full ${enMarchaFicha() ? "bg-v2-state-fg-success" : "bg-v2-border-border-muted"}`}
              aria-hidden="true"
            />
            {language.t(enMarchaFicha() ? "trading.ficha.state.running" : "trading.ficha.state.stopped")}
          </MetaCuenta>
          <MetaCuenta etiqueta={language.t("trading.ficha.process")} mono>
            {pidFicha()}
          </MetaCuenta>
          <MetaCuenta etiqueta={language.t("trading.ficha.started")} mono>
            {arranqueFicha()}
          </MetaCuenta>
          <MetaCuenta etiqueta={language.t("trading.ficha.uptime")} mono>
            {marchaFicha()}
          </MetaCuenta>
          <MetaCuenta etiqueta={language.t("trading.ficha.instrument")}>
            {instrumentoFicha()}
          </MetaCuenta>
          <MetaCuenta etiqueta={language.t("trading.account.pnlToday")} tono={tonoPnl(pnlFicha())}>
            {formatoUSD(pnlFicha())}
          </MetaCuenta>
          <MetaCuenta etiqueta={language.t("trading.ficha.client")} mono>
            {clienteFicha()}
          </MetaCuenta>
          <MetaCuenta etiqueta={language.t("trading.ficha.schedule")} mono>
            {cierreFicha()}
          </MetaCuenta>
          <MetaCuenta etiqueta={language.t("trading.ficha.activity")} mono>
            {actividadFicha()}
          </MetaCuenta>
        </dl>
        <Show when={descripcionFicha() !== null || reglasFicha() !== null}>
          <section class="rounded-[8px] border border-v2-border-border-muted bg-v2-background-bg-deep p-3">
            <h3 class="mb-2 px-1 text-[11px] tracking-[0.08em] text-v2-text-text-muted uppercase" style={LINEA}>
              {language.t("trading.ficha.about")}
            </h3>
            <Show when={descripcionFicha() !== null}>
              <p class="mb-2 px-1 text-[13px] text-v2-text-text-muted" style={LINEA}>
                {descripcionFicha()}
              </p>
            </Show>
            <Show when={reglasFicha() !== null}>
              <dl class="grid gap-y-1 px-1">
                <For each={reglasFicha() ?? []}>{(par) => <MetaCuenta etiqueta={par[0]}>{par[1]}</MetaCuenta>}</For>
              </dl>
            </Show>
          </section>
        </Show>
              <section class="flex min-h-0 flex-1 flex-col rounded-[8px] border border-v2-border-border-muted bg-v2-background-bg-deep p-3">
                <h3 class="mb-2 px-1 text-[11px] tracking-[0.08em] text-v2-text-text-muted uppercase" style={LINEA}>
                  {language.t("trading.ficha.record")}
                </h3>
                {/* Same as the panel: wheel/drag scrolling, no stray bar inside the card. */}
                <div data-scrollable class="min-h-0 flex-1 overflow-y-auto no-scrollbar">
                  <Show
                    when={props.registros().length > 0}
                    fallback={<p class="px-1 text-[13px] text-v2-text-text-muted" style={LINEA}>{language.t("trading.ficha.record.empty")}</p>}
                  >
                    <ListaRegistro registros={props.registros()} />
                  </Show>
                </div>
              </section>
              <ProgramaTarea programar={props.programar} />
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="neutral" disabled={props.ocupado() || vista() === undefined} onClick={props.alternar}>
          {language.t(enMarchaFicha() ? "trading.ficha.stopNow" : "trading.ficha.startNow")}
        </Button>
        <Button type="button" variant="neutral" onClick={() => dialog.close()}>
          {language.t("common.close")}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}

// The styled native selects the scheduling row uses: no Select primitive exists in the app,
// and a native one keeps keyboard and accessibility behavior for free.
const SELECT = "h-7 shrink-0 rounded-[8px] border border-v2-border-border-muted bg-v2-background-bg-layer-01 px-2 text-[13px] text-v2-text-text-base leading-[16px] outline-none"

/**
 * The dossier's scheduling row: one system's fixed scope, so only the action (start or stop)
 * and the moment are picked — whole minutes from now or the next HH:MM on the PC's clock.
 * Validation mirrors the engine's; an invalid value keeps Program disabled instead of
 * reaching the engine and vanishing there.
 */
function ProgramaTarea(props: {
  programar: (entrada: { kind: "start-systems" | "stop-systems"; delayMinutes?: number; atTime?: string }) => Promise<unknown>
}) {
  const language = useLanguage()
  const [enviando, fijarEnviando] = createSignal(false)

  const [formulario, fijarFormulario] = createStore<{ accion: "arrancar" | "parar"; modo: "minutos" | "hora"; valor: string }>({
    accion: "arrancar",
    modo: "minutos",
    valor: "30",
  })

  const válido = () => {
    const texto = formulario.valor.trim()

    if (formulario.modo === "minutos") {
      // Whole positive minutes only, capped at one day out: the interval every plumbing
      // round or alike schedules by, and a stray 999999 could not hand the engine's clock
      // math an Infinity.
      return /^\d+$/.test(texto) && Number(texto) >= 1 && Number(texto) <= 1_440
    }

    return /^([01]?\d|2[0-3]):[0-5]\d$/.test(texto)
  }

  const enviar = async () => {
    if (enviando()) return

    fijarEnviando(true)

    // The parent reports its own success/failure toast and resolves either way — but if it
    // ever rejects, the send button still comes back (try: the write; finally: the button).
    try {
      await props.programar({
        kind: formulario.accion === "arrancar" ? "start-systems" : "stop-systems",
        delayMinutes: formulario.modo === "minutos" ? Number(formulario.valor.trim()) : undefined,
        atTime: formulario.modo === "hora" ? formulario.valor.trim() : undefined,
      })
    } finally {
      fijarEnviando(false)
    }
  }

  return (
    <div class="flex flex-wrap items-center gap-2 border-t border-v2-border-border-muted px-1 py-2">
      <select
        class={SELECT}
        aria-label={language.t("trading.tasks.new.action")}
        value={formulario.accion}
        onChange={(event) => fijarFormulario("accion", event.currentTarget.value === "parar" ? "parar" : "arrancar")}
      >
        <option value="arrancar">{language.t("trading.task.start")}</option>
        <option value="parar">{language.t("trading.task.stop")}</option>
      </select>
      <select
        class={SELECT}
        aria-label={language.t("trading.tasks.new.when")}
        value={formulario.modo}
        onChange={(event) => fijarFormulario("modo", event.currentTarget.value === "hora" ? "hora" : "minutos")}
      >
        <option value="minutos">{language.t("trading.tasks.new.mode.minutes")}</option>
        <option value="hora">{language.t("trading.tasks.new.mode.time")}</option>
      </select>
      <TextInput
        class="w-24"
        appearance="small"
        value={formulario.valor}
        numeric={formulario.modo === "minutos"}
        aria-label={language.t("trading.tasks.new.value")}
        placeholder={formulario.modo === "minutos" ? "30" : "10:30"}
        onInput={(event) => fijarFormulario("valor", event.currentTarget.value)}
      />
      <Button type="button" variant="outline" size="small" disabled={enviando() || !válido()} onClick={() => void enviar()}>
        {language.t("trading.tasks.new.program")}
      </Button>
    </div>
  )
}

/**
 * The chat's system prompt editor: a controlled textarea over the stored prompt. "Restore"
 * only fills the textarea with the default desk context, so the change still needs "Save",
 * and nothing is written until then; Cancel discards every edit. The saved prompt survives
 * app restarts (server-global store) and each boot's adoption re-puts it into the chat.
 */
function DialogPrompto(props: { contenido: string; guardar: (valor: string) => Promise<boolean> }) {
  const language = useLanguage()
  const dialog = useDialog()
  const [borrador, setBorrador] = createSignal(props.contenido)
  const [guardando, setGuardando] = createSignal(false)

  // The save's verdict comes back: a saved prompt closes the editor; a failed one stays
  // open with its error toast, so the text never leaves the screen on a failure.
  const guardar = async () => {
    if (guardando()) return

    setGuardando(true)
    const guardado = await props.guardar(borrador())
    setGuardando(false)

    if (guardado) dialog.close()
  }

  return (
    <Dialog size="large" preventBackdropDismiss>
      <DialogHeader>
        <DialogTitleGroup title={language.t("trading.prompt.title")} description={language.t("trading.prompt.description")} />
      </DialogHeader>
      <DialogBody class="flex min-h-0 flex-1 flex-col gap-2 px-4 pt-1">
        {/* An edited prompt replaces the default for good, so the desk's newer instructions
            (new accounts, links, endpoints) never reach the chat on their own: say so while
            the text differs from the default, next to the restore that brings them back. */}
        <Show when={borrador() !== TRADING_DESK_CONTEXT}>
          <p data-slot="trading-prompt-custom" class="flex shrink-0 items-start gap-2 text-[13px] text-v2-state-fg-warning" style={LINEA}>
            <Icon name="circle-exclamation" class="mt-0.5 size-3.5 shrink-0" />
            {language.t("trading.prompt.custom")}
          </p>
        </Show>
        <Textarea
          value={borrador()}
          rows={14}
          aria-label={language.t("trading.prompt.title")}
          class="!w-full min-h-0 flex-1 [&_[data-slot=textarea-v2-textarea]]:h-full [&_[data-slot=textarea-v2-textarea]]:font-mono"
          spellcheck={false}
          onInput={(event) => setBorrador(event.currentTarget.value)}
        />
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="ghost-muted" onClick={() => setBorrador(TRADING_DESK_CONTEXT)}>
          {language.t("trading.prompt.restore")}
        </Button>
        <Button type="button" variant="neutral" onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </Button>
        <Button type="button" variant="submit" disabled={guardando() || borrador() === props.contenido} onClick={guardar}>
          {language.t("common.save")}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}

/** The wizard's address check: idle, running, or the engine's verdict on the typed address. */
type EstadoPrueba = "nada" | "probando" | "abierto" | "cerrado" | "falla"

/** Each check state's line: its tone and its copy (the idle state renders no line at all). */
const PRUEBA = {
  nada: { tono: "", clave: "trading.accounts.add.test.running" },
  probando: { tono: "text-v2-text-text-muted", clave: "trading.accounts.add.test.running" },
  abierto: { tono: "text-v2-state-fg-success", clave: "trading.accounts.add.test.open" },
  cerrado: { tono: "text-v2-state-fg-warning", clave: "trading.accounts.add.test.closed" },
  falla: { tono: "text-v2-state-fg-warning", clave: "trading.accounts.add.test.failed" },
} as const

/** The IBKR registration's quick ports: the live and paper TWS sockets. The live one carries
 * the warning tone; the paper one stays calm. */
const PRESETS: ReadonlyArray<{ puerto: string; clave: string; aria: string }> = [
  { puerto: "7496", clave: "trading.accounts.add.preset.live", aria: "trading.accounts.add.preset.live.aria" },
  { puerto: "7497", clave: "trading.accounts.add.preset.paper", aria: "trading.accounts.add.preset.paper.aria" },
]

/**
 * Registering a balance watch over one wizard: the broker first — IBKR dials a second
 * TWS address, MT5 rides its own engine (the register call goes out as-is and the
 * engine's refusal is the answer until its read bridge lands) while NT stays behind its
 * own row — then that platform's form. A failed registration keeps the dialog on its
 * step (like the prompt editor); a saved one closes it and the tree's broker folder
 * takes the link.
 */
/**
 * The desk's first-run page: nothing has ever connected, so the sheet's dashes would only say
 * "nothing here". Instead it walks the three steps TWS needs before the engine can read it —
 * open and sign in, enable the API on the primary link's port, press Connect — and keeps the
 * other door (an MT5 or second TWS registration) one click away. Once Connect is pressed the
 * engine chases TWS every 5 s; the page says it is waiting and offers to stop trying.
 */
function BienvenidaConexión(props: {
  puerto: number | null
  dirección: string
  conectando: boolean
  /** Whether something answers on the primary link's port right now; undefined until known. */
  responde: boolean | undefined
  ocupado: boolean
  conectar: () => void
  detener: () => void
  añadir: () => void
}) {
  const language = useLanguage()

  const pasos = () => [
    language.t("trading.welcome.step.open"),
    language.t("trading.welcome.step.api", { port: String(props.puerto ?? 7497) }),
    language.t("trading.welcome.step.connect"),
  ]

  return (
    <div data-slot="trading-welcome" class="flex w-full justify-center px-6 py-10">
      <div class="flex w-full max-w-[520px] flex-col gap-5">
        <div class="flex flex-col gap-1">
          <h2 class="text-[15px] font-medium text-v2-text-text-base" style={{ "line-height": "var(--line-height-base)" }}>
            {language.t("trading.welcome.title")}
          </h2>
          <p class="text-[13px] text-v2-text-text-muted" style={LINEA}>
            {language.t("trading.welcome.description")}
          </p>
        </div>
        <ol class="flex flex-col gap-3">
          <For each={pasos()}>
            {(paso, índice) => (
              <li class="flex items-start gap-3">
                <span
                  class="flex size-5 shrink-0 items-center justify-center rounded-full border border-v2-border-border-muted text-[11px] tabular-nums text-v2-text-text-muted"
                  style={LINEA}
                  aria-hidden="true"
                >
                  {índice() + 1}
                </span>
                <p class="min-w-0 pt-0.5 text-[13px] text-v2-text-text-base" style={LINEA}>
                  {paso}
                </p>
              </li>
            )}
          </For>
        </ol>
        <Show when={props.responde !== undefined && !props.conectando}>
          <p
            data-slot="trading-welcome-port"
            class={`flex items-start gap-2 text-[13px] ${props.responde ? "text-v2-state-fg-success" : "text-v2-text-text-muted"}`}
            style={LINEA}
          >
            <Icon name={props.responde ? "circle-check" : "circle-exclamation"} class="mt-0.5 size-3.5 shrink-0" />
            {language.t(props.responde ? "trading.welcome.port.open" : "trading.welcome.port.closed", { port: String(props.puerto ?? 7497) })}
          </p>
        </Show>
        <Show
          when={props.conectando}
          fallback={
            <div class="flex flex-wrap items-center gap-2">
              <Button type="button" variant="submit" size="normal" icon="globe" disabled={props.ocupado} onClick={props.conectar}>
                {language.t("trading.engine.connect")}
              </Button>
              <Button type="button" variant="ghost-muted" size="normal" onClick={props.añadir}>
                {language.t("trading.welcome.other")}
              </Button>
            </div>
          }
        >
          <div class="flex flex-col gap-2 rounded-[8px] border border-v2-border-border-muted px-3 py-2.5">
            <p class="flex items-center gap-2 text-[13px] text-v2-text-text-base" style={LINEA}>
              <Loader class="size-3.5 shrink-0" />
              {language.t("trading.welcome.waiting", { address: props.dirección })}
            </p>
            <p class="text-[13px] text-v2-text-text-muted" style={LINEA}>
              {language.t("trading.welcome.waiting.hint")}
            </p>
            <div>
              <Button type="button" variant="ghost-muted" size="small" disabled={props.ocupado} onClick={props.detener}>
                {language.t("trading.welcome.stop")}
              </Button>
            </div>
          </div>
        </Show>
      </div>
    </div>
  )
}

function DialogCuentaNueva(props: {
  registrar: (entrada: { broker: "ibkr" | "mt5"; host?: string; port?: number; label?: string; live?: boolean; mt5Login?: number; mt5Server?: string }) => Promise<boolean>
  buscar: (probe: boolean) => Promise<readonly Trading.Mt5Detected[] | undefined>
  detectar: (entrada?: { host?: string; port?: number }) => Promise<readonly Trading.IbkrPort[] | undefined>
  /** The links the engine already has: an MT5 account among them reads as already added. */
  enlaces: Accessor<readonly string[]>
}) {
  const language = useLanguage()
  const dialog = useDialog()
  const [paso, fijarPaso] = createSignal<"broker" | "ibkr" | "mt5">("broker")
  // Paper starts the form: the live ports are the user's explicit pick, never the resting
  // default (the add link's path of least resistance has to be a session that costs nothing).
  const [entrada, setEntrada] = createStore({ host: "127.0.0.1", port: "7497", label: "", live: false })

  // The MT5 search rides its own store: the accounts this computer's terminals have on
  // record, the search's state and the picked row ("login@server"; a re-search can retire it).
  const [busque, fijarBusque] = createStore<{
    filas: readonly Trading.Mt5Detected[]
    buscando: boolean
    ya: boolean
    falla: boolean
    elegida: string | null
  }>({ filas: [], buscando: false, ya: false, falla: false, elegida: null })

  const [guardando, setGuardando] = createSignal(false)
  // The IBKR step's two readings, both plain TCP knocks the engine makes (nothing connects):
  // which of this computer's four default ports answer (they mark the presets), and the
  // check of the address typed. Editing the address forgets the check.
  const [puertos, fijarPuertos] = createStore<{ abiertos: Record<number, boolean>; ya: boolean }>({ abiertos: {}, ya: false })
  const [prueba, fijarPrueba] = createStore<{ estado: EstadoPrueba; dirección: string }>({ estado: "nada", dirección: "" })

  createEffect(() => {
    if (paso() !== "ibkr" || puertos.ya) return
    fijarPuertos("ya", true)
    void props.detectar().then((filas) => fijarPuertos("abiertos", Object.fromEntries((filas ?? []).map((fila) => [fila.port, fila.open]))))
  })

  const probar = async () => {
    if (!válido() || prueba.estado === "probando") return
    const host = entrada.host.trim() === "" ? undefined : entrada.host.trim()
    const port = Number(entrada.port.trim())
    fijarPrueba({ estado: "probando", dirección: `${host ?? "127.0.0.1"}:${port}` })
    const filas = await props.detectar({ host, port })
    fijarPrueba("estado", filas === undefined ? "falla" : filas[0]?.open ? "abierto" : "cerrado")
  }

  // Whole numbers only, in TWS's reachable range; the engine re-checks and can still refuse.
  const válido = () => {
    const texto = entrada.port.trim()

    return /^\d+$/.test(texto) && Number(texto) >= 1 && Number(texto) <= 65_535
  }

  // The live session's port: 7496 is TWS live. The comment tone rides it; the paper one
  // reads quiet.
  const vivo = () => entrada.port.trim() === "7496"

  // Two searches (M-04): the entry's reads the disk records alone — a closed MetaTrader 5
  // stays closed — and the button's second search adds the live reading behind the user's
  // explicit order. A server that did not answer is stated once and keeps the step usable;
  // the picked row follows the list it is still part of.
  const buscar = async (probe = false) => {
    if (busque.buscando) return

    fijarBusque("buscando", true)
    const filas = await props.buscar(probe)
    fijarBusque("buscando", false)
    fijarBusque("ya", true)
    fijarBusque("falla", filas === undefined)
    const lista = filas ?? []

    if (busque.elegida !== null && !lista.some((fila) => claveMT5(fila) === busque.elegida)) fijarBusque("elegida", null)
    fijarBusque("filas", lista)
  }

  // The step's entry searches the disk records once, side-effect free; revisits re-search
  // by the buttons — the terminal's live reading only behind the explicit probe.
  createEffect(() => {
    if (paso() !== "mt5" || busque.ya) return
    void buscar()
  })

  const registrar = async (broker: "ibkr") => {
    if (guardando()) return

    setGuardando(true)

    const guardado = await props.registrar({
      broker,
      host: entrada.host.trim() === "" ? undefined : entrada.host.trim(),
      port: Number(entrada.port.trim()),
      label: entrada.label.trim() === "" ? undefined : entrada.label.trim(),
      // The engine's own gate (M-01) refuses a live port without this flag; the wizard
      // only reaches here with the live box checked, so the flag states the same truth.
      live: vivo() && entrada.live,
    })

    setGuardando(false)

    if (guardado) dialog.close()
  }

  // The picked account names the watch: the registration goes out with its login and
  // server, and the engine's sidecar bridge starts reading that terminal.
  const registrarMT5 = async () => {
    if (guardando()) return
    const fila = elegida()

    if (fila === undefined) return

    setGuardando(true)

    const guardado = await props.registrar({
      broker: "mt5",
      label: entrada.label.trim() === "" ? undefined : entrada.label.trim(),
      mt5Login: fila.login,
      mt5Server: fila.server,
    })

    setGuardando(false)

    if (guardado) dialog.close()
  }

  // The row's key pairs login and server (both arrive from the terminal folders' records).
  const claveMT5 = (fila: Trading.Mt5Detected) => `${fila.login}@${fila.server}`
  const elegida = () => busque.filas.find((fila) => claveMT5(fila) === busque.elegida)

  // The header's line follows the step so the wizard reads whole: broker → its form.
  const descripción = () => {
    if (paso() === "broker") return "trading.accounts.add.broker.description"

    if (paso() === "ibkr") return "trading.accounts.add.description"

    return "trading.accounts.add.mt5.description"
  }

  const tarjeta = (broker: "ibkr" | "mt5" | "nt") => {
    const clave = language.t(`trading.accounts.broker.${broker}`)
    const esperando = broker === "nt"

    return (
      <button
        type="button"
        disabled={esperando}
        aria-disabled={esperando || undefined}
        title={esperando ? language.t("trading.accounts.add.broker.nt.pending") : undefined}
        class="flex w-full flex-col items-start gap-1 rounded-[8px] border border-v2-border-border-muted px-3 py-2.5 text-start text-v2-text-text-muted hover:bg-v2-background-bg-layer-02 disabled:text-v2-text-text-muted disabled:hover:bg-transparent"
        onClick={() => fijarPaso(broker === "ibkr" ? "ibkr" : "mt5")}
      >
        <span class="flex w-full items-center gap-2">
          <span class="text-[13px] font-medium text-v2-text-text-base">{clave}</span>
          <Icon name="chevron-right" class={`ms-auto shrink-0 ${esperando ? "opacity-40" : ""}`} size="small" />
        </span>
        <span class="text-[13px]" style={LINEA}>
          {language.t(esperando ? "trading.accounts.add.broker.nt.pending" : broker === "ibkr" ? "trading.accounts.add.broker.ibkr.description" : "trading.accounts.add.broker.mt5.description")}
        </span>
      </button>
    )
  }

  return (
    <Dialog preventBackdropDismiss>
      <DialogHeader>
        <DialogTitleGroup title={language.t("trading.accounts.add.title")} description={language.t(descripción())} />
      </DialogHeader>
      <DialogBody class="flex flex-col gap-2 px-4 pb-2 -mt-2">
        <Show when={paso() === "broker"}>
          <div class="flex flex-col gap-1.5">{tarjeta("ibkr")}{tarjeta("mt5")}{tarjeta("nt")}</div>
        </Show>
        <Show when={paso() === "ibkr"}>
          <div class="flex gap-2">
            <TextInput
              value={entrada.host}
              aria-label={language.t("trading.accounts.add.host")}
              onInput={(event) => {
                setEntrada("host", event.currentTarget.value)
                fijarPrueba("estado", "nada")
              }}
            />
            <TextInput
              class="w-24"
              value={entrada.port}
              numeric
              aria-label={language.t("trading.accounts.add.port")}
              placeholder="7497"
              onInput={(event) => {
                setEntrada("port", event.currentTarget.value)
                fijarPrueba("estado", "nada")
              }}
            />
            <Button type="button" variant="ghost-muted" disabled={!válido() || prueba.estado === "probando"} onClick={() => void probar()}>
              {language.t("trading.accounts.add.test")}
            </Button>
          </div>
          <Show when={prueba.estado !== "nada"}>
            <p
              data-slot="trading-link-test"
              class={`flex items-start gap-2 text-[13px] ${PRUEBA[prueba.estado].tono}`}
              style={LINEA}
            >
              <Show when={prueba.estado === "probando"} fallback={<Icon name={prueba.estado === "abierto" ? "circle-check" : "circle-exclamation"} class="mt-0.5 size-3.5 shrink-0" />}>
                <Loader class="mt-0.5 size-3.5 shrink-0" />
              </Show>
              {language.t(PRUEBA[prueba.estado].clave, { address: prueba.dirección })}
            </p>
          </Show>
          <div class="flex flex-wrap items-center gap-1.5" role="group" aria-label={language.t("trading.accounts.add.preset.aria")}>
            <For each={PRESETS}>
              {(preset) => (
                <button
                  type="button"
                  class="flex items-baseline gap-1.5 whitespace-nowrap rounded-full border border-v2-border-border-muted px-2 py-0.5 text-[12px] text-v2-text-text-muted hover:bg-v2-background-bg-layer-02 hover:text-v2-text-text-base"
                  title={language.t(preset.aria)}
                  aria-label={language.t(preset.aria)}
                  onClick={() => {
                    setEntrada("port", preset.puerto)
                    fijarPrueba("estado", "nada")
                  }}
                >
                  {/* The search's verdict for this default port: green when TWS answers there,
                      muted when nothing does, absent until it lands. */}
                  <Show when={puertos.abiertos[Number(preset.puerto)] !== undefined}>
                    <span
                      class={`size-1.5 shrink-0 self-center rounded-full ${puertos.abiertos[Number(preset.puerto)] ? "bg-v2-state-fg-success" : "bg-v2-border-border-muted"}`}
                      title={language.t(puertos.abiertos[Number(preset.puerto)] ? "trading.accounts.add.preset.open" : "trading.accounts.add.preset.closed")}
                    />
                  </Show>
                  {language.t(preset.clave)}
                  <span class="font-mono text-[11px]">{preset.puerto}</span>
                </button>
              )}
            </For>
          </div>
          <TextInput
            value={entrada.label}
            aria-label={language.t("trading.accounts.add.label")}
            placeholder={language.t("trading.accounts.add.label")}
            onInput={(event) => setEntrada("label", event.currentTarget.value)}
          />
          <Show when={vivo()}>
            {/* The live port's own consent: the registration carries the live flag the
                engine gates on (M-01), so the flag reads exactly what the box admits — and
                the confirm stays down until this box does, the honest order (LIVE, then the
                write). */}
            <Switch appearance="compact" checked={entrada.live} onChange={(valor) => setEntrada("live", valor)}>
              <span class="font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-v2-state-fg-warning">{language.t("trading.accounts.add.preset.live")}</span>
              {language.t("trading.accounts.add.live")}
            </Switch>
            <p class="flex items-start gap-2 text-[13px] text-v2-state-fg-warning" style={LINEA}>
              <Icon name="circle-exclamation" class="mt-0.5 size-3.5 shrink-0" />
              {language.t("trading.accounts.add.liveWarning")}
            </p>
          </Show>
        </Show>
        <Show when={paso() === "mt5"}>
          <div class="flex flex-col gap-1.5" role="radiogroup" aria-label={language.t("trading.accounts.add.mt5.rows.aria")}>
            <For each={busque.buscando || !busque.ya ? [] : busque.filas}>
              {(fila) => {
                const clave = claveMT5(fila)
                const añadida = () => props.enlaces().includes(`mt5-${clave}`)

                return (
                  <button
                    type="button"
                    role="radio"
                    disabled={añadida()}
                    aria-checked={busque.elegida === clave}
                    data-state={busque.elegida === clave ? "pressed" : undefined}
                    class="flex w-full items-center gap-2 rounded-[8px] border border-v2-border-border-muted px-3 py-2 text-start text-[13px] text-v2-text-text-muted enabled:hover:bg-v2-background-bg-layer-02 enabled:hover:text-v2-text-text-base disabled:opacity-60 data-[state=pressed]:bg-v2-background-bg-layer-02 data-[state=pressed]:text-v2-text-text-base"
                    style={LINEA}
                    aria-label={language.t("trading.accounts.add.mt5.row.aria", { login: String(fila.login), server: fila.server })}
                    onClick={() => fijarBusque("elegida", clave)}
                  >
                    <span class="font-mono">{fila.login}</span>
                    <span aria-hidden="true" class="shrink-0 opacity-50">
                      ·
                    </span>
                    <span class="min-w-0 truncate">{fila.server}</span>
                    <Show when={fila.active}>
                      <span class="shrink-0 rounded-full border border-v2-border-border-muted px-1.5 text-[11px] text-v2-text-text-muted">
                        {language.t("trading.accounts.add.mt5.row.active")}
                      </span>
                    </Show>
                    <Show when={añadida()}>
                      <span class="shrink-0 rounded-full border border-v2-border-border-muted px-1.5 text-[11px] text-v2-text-text-muted">
                        {language.t("trading.accounts.add.mt5.row.added")}
                      </span>
                    </Show>
                    <span class="ms-auto min-w-0 truncate">{fila.name ?? ""}</span>
                  </button>
                )
              }}
            </For>
            <Show when={busque.buscando && !busque.ya}>
              <p class="flex items-center gap-2 text-[13px] text-v2-text-text-muted" style={LINEA}>
                <Loader class="size-3.5 shrink-0" />
                {language.t("trading.accounts.add.mt5.searching")}
              </p>
            </Show>
            <Show when={!busque.buscando && busque.ya && busque.filas.length === 0}>
              <p class="flex items-start gap-2 text-[13px] text-v2-text-text-muted" style={LINEA}>
                <Icon name="circle-exclamation" class="mt-0.5 size-3.5 shrink-0" />
                {language.t(busque.falla ? "trading.accounts.add.mt5.detect.failed" : "trading.accounts.add.mt5.none")}
              </p>
            </Show>
          </div>
          <div class="flex items-center gap-3">
            <Button type="button" variant="ghost-muted" disabled={busque.buscando} onClick={() => void buscar(true)} aria-label={language.t("trading.accounts.add.mt5.search.aria")}>
              {language.t("trading.accounts.add.mt5.search")}
            </Button>
            <p class="min-w-0 text-[11px] text-v2-text-text-muted" style={LINEA}>
              {language.t("trading.accounts.add.mt5.probe.hint")}
            </p>
          </div>
          <TextInput
            value={entrada.label}
            aria-label={language.t("trading.accounts.add.label")}
            placeholder={language.t("trading.accounts.add.label")}
            onInput={(event) => setEntrada("label", event.currentTarget.value)}
          />
        </Show>
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="ghost-muted" onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </Button>
        <Show when={paso() !== "broker"}>
          <Button type="button" variant="ghost-muted" disabled={guardando()} onClick={() => fijarPaso("broker")}>
            {language.t("trading.accounts.add.back")}
          </Button>
        </Show>
        <Show when={paso() === "ibkr"}>
          <Button
            type="button"
            variant="submit"
            /* A live port registers only behind its box (the engine would refuse it
               anyway) — the gate makes the important case the honest wait. */
            disabled={guardando() || !válido() || (vivo() && !entrada.live)}
            onClick={() => void registrar("ibkr")}
          >
            <Show when={vivo()}>
              <span class="font-mono text-[11px] font-medium uppercase tracking-[0.08em]" aria-hidden="true">
                {language.t("trading.accounts.add.preset.live")} ·
              </span>
            </Show>
            {language.t("trading.accounts.add.confirm")}
          </Button>
        </Show>
        <Show when={paso() === "mt5"}>
          <Button type="button" variant="submit" disabled={guardando() || !busque.ya || elegida() === undefined} onClick={() => void registrarMT5()}>
            {language.t("trading.accounts.add.confirm")}
          </Button>
        </Show>
      </DialogFooter>
    </Dialog>
  )
}

/** Merges the log ring and the trade record into one chronological list. Every close is
 * already a log line (`event: "close"`), so the trades replace those rows — carrying the
 * P/L the log lacks — and the log's own close rows drop out, keeping no duplicates. The
 * replacement only exists when the trades arrived (an engine predating the trade record
 * sends none): then the log's close rows are the record of the closes and stay. */
function reunirRegistro(registros: RegistroInfo[], trades: TradeInfo[]): FilaRegistroNav[] {
  const cambiaCierres = trades.length > 0

  const lineas: FilaRegistroNav[] = registros.flatMap((registro) =>
    cambiaCierres && registro.evento === "cierre"
      ? []
      : [{
          ts: registro.ts,
          nivel: registro.nivel,
          bot: registro.bot,
          mensaje: registro.mensaje,
          clave_mensaje: registro.clave_mensaje,
          params_mensaje: registro.params_mensaje,
          evento: registro.evento,
          pnl: null,
        }],
  )

  const cierres: FilaRegistroNav[] = trades.map((trade) => ({
    ts: trade.hora,
    nivel: "info",
    bot: trade.bot,
    mensaje: trade.mensaje,
    clave_mensaje: null,
    params_mensaje: null,
    evento: "cierre",
    pnl: trade.pnl,
  }))

  return [...lineas, ...cierres].sort((a, b) => a.ts - b.ts)
}

/**
 * Today's closed trades, as the bots themselves reported them: a summary line (how many, how
 * many won, the net) over one row per close, newest first. Only today's — the engine's record
 * keeps several days, and the sheet speaks about the day. Hidden until a trade closes today.
 */
function OperacionesHoy(props: { trades: TradeInfo[] }) {
  const language = useLanguage()
  const { formatoUSD, formatoHora } = useFormatos()

  const hoy = createMemo(() => {
    const inicio = new Date()

    inicio.setHours(0, 0, 0, 0)

    return props.trades.filter((trade) => trade.hora >= inicio.getTime()).sort((a, b) => b.hora - a.hora)
  })

  const resumen = createMemo(() => {
    const conCifra = hoy().flatMap((trade) => (trade.pnl === null ? [] : [trade.pnl]))

    return {
      ganadas: conCifra.filter((pnl) => pnl > 0).length,
      medidas: conCifra.length,
      neto: conCifra.length === 0 ? null : conCifra.reduce((suma, pnl) => suma + pnl, 0),
    }
  })

  return (
    <Show when={hoy().length > 0}>
      <section data-slot="trading-trades-today" class="flex flex-col gap-2" aria-label={language.t("trading.trades.today")}>
        <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <p class="text-[11px] tracking-[0.08em] text-v2-text-text-muted uppercase" style={LINEA}>
            {language.t("trading.trades.today")}
          </p>
          <p class="text-[12px] tabular-nums text-v2-text-text-muted" style={LINEA}>
            {language.plural("trading.trades.summary", hoy().length, { wins: String(resumen().ganadas), measured: String(resumen().medidas) })}
            {" · "}
            <span class={tonoPnl(resumen().neto)}>
              {flechaPnl(resumen().neto)}
              {formatoUSD(resumen().neto)}
            </span>
          </p>
        </div>
        <div class="flex flex-col">
          <For each={hoy()}>
            {(trade) => (
              <div class="grid min-h-8 grid-cols-[64px_minmax(0,1fr)_minmax(72px,auto)] items-center gap-x-3 border-b border-v2-border-border-muted last:border-b-0">
                <span class="text-[12px] tabular-nums text-v2-text-text-muted" style={LINEA}>
                  {formatoHora(trade.hora)}
                </span>
                <span class="min-w-0 truncate text-[13px] text-v2-text-text-base" style={LINEA} title={trade.mensaje}>
                  <span class="font-mono text-[12px]">{trade.bot}</span>
                  <span class="ps-2 text-v2-text-text-muted">{trade.mensaje}</span>
                </span>
                <span class={`text-end ${NÚMERO} ${tonoPnl(trade.pnl)}`} style={LINEA}>
                  {formatoUSD(trade.pnl)}
                </span>
              </div>
            )}
          </For>
        </div>
      </section>
    </Show>
  )
}

/**
 * The day's P/L curve: the series the engine samples every 15 s, drawn on a time axis with
 * zero always in range (the line reads as above or below break-even at a glance), the
 * range's high and low on the left, the first and last sample's clock time below, and a
 * crosshair with its value while the pointer is over it. Fewer than two numeric samples
 * draw nothing, and a read that isn't live (`caída`) lands in the dash row too — the body
 * keeps the curve's height either way, so connecting never jumps the layout.
 */
function CurvaDia(props: { curva: CurvaInfo[]; caída?: boolean }) {
  const language = useLanguage()
  const { formatoUSD, formatoHora } = useFormatos()
  const [cursor, fijarCursor] = createSignal<number | undefined>()

  // flatMap keeps the numbers' type without a cast: null samples just drop out.
  const vista = createMemo(() => {
    const serie = props.curva.flatMap((punto) => (punto.pnl_dia === null || !Number.isFinite(punto.hora) ? [] : [{ hora: punto.hora, valor: punto.pnl_dia }]))

    if (serie.length < 2) return null

    const valores = serie.map((punto) => punto.valor)
    const alto = Math.max(0, ...valores)
    const bajo = Math.min(0, ...valores)
    const rango = alto - bajo || 1
    const inicio = serie[0].hora
    const tramo = serie[serie.length - 1].hora - inicio || 1
    // 0..100 on both axes, y inverted, 6% headroom above and below so the stroke never
    // touches the frame.
    const x = (hora: number) => ((hora - inicio) / tramo) * 100
    const y = (valor: number) => 6 + (1 - (valor - bajo) / rango) * 88
    const puntos = serie.map((punto) => ({ ...punto, x: x(punto.hora), y: y(punto.valor) }))

    return {
      puntos,
      alto: Math.max(...valores),
      bajo: Math.min(...valores),
      cero: y(0),
      yAlto: y(Math.max(...valores)),
      yBajo: y(Math.min(...valores)),
      último: serie[serie.length - 1].valor,
      primer: serie[0].valor,
      línea: puntos.map((punto) => `${punto.x.toFixed(2)},${punto.y.toFixed(2)}`).join(" "),
    }
  })

  // The pointer's nearest sample by time (x is a time scale, so gaps keep their width).
  const enfocado = () => {
    const actual = vista()
    const posición = cursor()

    if (!actual || posición === undefined) return undefined

    return actual.puntos.reduce((mejor, punto) => (Math.abs(punto.x - posición) < Math.abs(mejor.x - posición) ? punto : mejor))
  }

  return (
    <div data-slot="trading-curve" class="flex flex-col gap-1.5">
      <div class="flex items-baseline justify-between gap-3">
        <p class="text-[11px] tracking-[0.08em] text-v2-text-text-muted uppercase" style={LINEA}>
          {language.t("trading.account.curve")}
        </p>
        <Show when={!props.caída && vista()}>
          {(actual) => (
            <p class={`text-[13px] tabular-nums ${tonoPnl(actual().último)}`} style={LINEA}>
              {flechaPnl(actual().último)}
              {formatoUSD(actual().último)}
            </p>
          )}
        </Show>
      </div>
      <Show
        when={!props.caída && vista()}
        keyed
        fallback={
          <div class="flex h-40 items-center">
            <p class="text-[13px] text-v2-text-text-muted" style={LINEA}>
              —
            </p>
          </div>
        }
      >
        {(actual) => (
          <div class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1">
            {/* The y values sit in their own gutter at the heights they mark — the range's
                high and low, and break-even when it is far enough from both to stay legible —
                so they never sit on the line, and the stretched viewBox never distorts them. */}
            <div class="relative h-40 min-w-12 text-end text-[11px] tabular-nums text-v2-text-text-muted" style={LINEA} aria-hidden="true">
              <span class="absolute end-0 -translate-y-1/2 whitespace-nowrap" style={{ top: `${actual.yAlto}%` }}>
                {formatoUSD(actual.alto)}
              </span>
              <Show when={Math.abs(actual.cero - actual.yAlto) > 14 && Math.abs(actual.cero - actual.yBajo) > 14}>
                <span class="absolute end-0 -translate-y-1/2 whitespace-nowrap" style={{ top: `${actual.cero}%` }}>
                  {formatoUSD(0)}
                </span>
              </Show>
              <Show when={actual.yBajo - actual.yAlto > 14}>
                <span class="absolute end-0 -translate-y-1/2 whitespace-nowrap" style={{ top: `${actual.yBajo}%` }}>
                  {formatoUSD(actual.bajo)}
                </span>
              </Show>
            </div>
            <div
              class="relative h-40"
              onPointerMove={(event) => {
                const caja = event.currentTarget.getBoundingClientRect()
                fijarCursor(((event.clientX - caja.left) / caja.width) * 100)
              }}
              onPointerLeave={() => fijarCursor(undefined)}
            >
              <svg viewBox="0 0 100 100" preserveAspectRatio="none" class="absolute inset-0 size-full overflow-visible" role="img" aria-label={language.t("trading.account.curve.aria")}>
                <title>{language.t("trading.account.curve.aria")}</title>
                <desc>
                  {language.t("trading.account.curve.desc", {
                    first: formatoUSD(actual.primer),
                    last: formatoUSD(actual.último),
                    low: formatoUSD(actual.bajo),
                    high: formatoUSD(actual.alto),
                  })}
                </desc>
                {/* Break-even: the one reference line, recessive and dashed. */}
                <line x1="0" x2="100" y1={actual.cero} y2={actual.cero} stroke="var(--v2-border-border-muted)" stroke-width="1" stroke-dasharray="3 3" vector-effect="non-scaling-stroke" />
                <polyline
                  fill="none"
                  stroke={actual.último >= 0 ? "var(--v2-state-fg-success)" : "var(--v2-state-fg-danger)"}
                  stroke-width="2"
                  stroke-linejoin="round"
                  stroke-linecap="round"
                  vector-effect="non-scaling-stroke"
                  points={actual.línea}
                />
              </svg>
              <Show when={enfocado()}>
                {(punto) => (
                  <>
                    <span class="pointer-events-none absolute inset-y-0 w-px bg-v2-border-border-muted" style={{ left: `${punto().x}%` }} />
                    <span
                      class={`pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-v2-background-bg-base ${punto().valor >= 0 ? "bg-v2-state-fg-success" : "bg-v2-state-fg-danger"}`}
                      style={{ left: `${punto().x}%`, top: `${punto().y}%` }}
                    />
                    <span
                      data-slot="trading-curve-tooltip"
                      class="pointer-events-none absolute top-0 z-10 whitespace-nowrap rounded-[6px] border border-v2-border-border-muted bg-v2-background-bg-base px-2 py-1 text-[12px] tabular-nums text-v2-text-text-base shadow-[var(--v2-elevation-floating)]"
                      style={{ ...LINEA, left: `${punto().x}%`, transform: `translateX(${punto().x > 70 ? "calc(-100% - 8px)" : "8px"})` }}
                    >
                      <span class="text-v2-text-text-muted">{formatoHora(punto().hora)}</span> {flechaPnl(punto().valor)}
                      {formatoUSD(punto().valor)}
                    </span>
                  </>
                )}
              </Show>
            </div>
            <span />
            <div class="flex justify-between text-[11px] tabular-nums text-v2-text-text-muted" style={LINEA}>
              <span>{formatoHora(actual.puntos[0].hora)}</span>
              <span>{formatoHora(actual.puntos[actual.puntos.length - 1].hora)}</span>
            </div>
          </div>
        )}
      </Show>
    </div>
  )
}

