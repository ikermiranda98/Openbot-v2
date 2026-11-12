/** The trading dashboard's nav, drawn with the app's own sidebar language: the Inbox's section
 * headers (label, count, chevron) and the vertical tabs' rows (13px medium, faint at rest, the
 * hover overlay, the pressed overlay on the selected row). Two blocks — the accounts as one
 * flat list, the systems split into running and stopped — and the system log pinned at the
 * row's end, whose panel opens downward and wider than a row. The dashboard always renders
 * these in its header strip (the product has no sidebar anywhere); this module stays light
 * (no SDK, no engine imports) so the route keeps its heavy chunk out of the header; its row
 * data arrives through the nav-estado bridge the route writes. */
import { createMemo, createSignal, For, onCleanup, Show, type JSX } from "solid-js"
import { Schema } from "effect"
import { Popover } from "@kobalte/core/popover"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Button } from "@opencode/ui/button"
import { useLanguage } from "@/runtime/i18n/language"
import { Persistence } from "@/runtime/persistence/schema"
import { Persist, persisted } from "@/runtime/persistence/storage"
import { useFormatos } from "./formatos"
import type { FilaCuentaNav, FilaEnlaceNav, FilaRegistroNav, FilaSistemaNav } from "./nav-estado"
import { navArbol } from "./nav-estado"
import { EtiquetaRegistro, MenuDescarga, textoRegistro } from "./registro"

/** Signed day-P/L tone: the colour and the figure's own sign carry it (no arrow at this width). */
function tonoPnl(valor: number | null) {
  if (valor === null) return "text-v2-text-text-muted"

  return valor >= 0 ? "text-v2-state-fg-success" : "text-v2-state-fg-danger"
}

/** A sidebar row's day P/L in whole dollars: at the sidebar's width the cents cost a system its
 * name. The desk's sheet and the log panel keep the exact figure. */
function usarDólares() {
  const language = useLanguage()
  const formato = createMemo(() => new Intl.NumberFormat(language.intl(), { style: "currency", currency: "USD", currencyDisplay: "narrowSymbol", maximumFractionDigits: 0 }))

  return (valor: number | null) => (valor === null || !Number.isFinite(valor) ? "—" : formato().format(valor))
}

// The pool names' market words that read as tickers: currency pairs and indicator names,
// plus the bar tags ("h4", "ema30").
const SIGLA = /^(?:(?:usd|eur|gbp|jpy|aud|nzd|cad|chf){2}|cci|ema|sma|rsi|macd|atr|adx|vwap|(?:ema|sma|h)\d+)$/

// Folder names carry no accents; the words the pool uses get theirs back for display.
const TILDES: Record<string, string> = { estocastico: "estocástico", dia: "día", sesion: "sesión", senal: "señal" }

/** A pool folder name read as words: "11_usdjpy_ruptura_bollinger" → "USDJPY ruptura bollinger".
 * Display only — every action still dispatches the system's own id. */
export function nombreLegible(nombre: string) {
  const palabras = nombre
    .replace(/^\d+_/, "")
    .split("_")
    .filter(Boolean)
    .map((palabra) => (SIGLA.test(palabra) ? palabra.toUpperCase() : (TILDES[palabra] ?? palabra)))
    .join(" ")

  return palabras ? palabras.charAt(0).toUpperCase() + palabras.slice(1) : nombre
}

// The vertical tabs' row: 28px, 13px medium, muted at rest and base when hovered or selected;
// the hover overlay paints on hover and the pressed overlay on the selected row. The row
// spans its column and carries its own inline-size container (both join at the call sites);
// the strip's log trigger stands alone, so it can size to its content.
const FILA =
  "group flex h-7 shrink-0 items-center gap-2 rounded-[6px] px-2 text-[13px] leading-4 font-medium text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base data-[state=pressed]:bg-v2-overlay-simple-overlay-pressed data-[state=pressed]:text-v2-text-text-base"

// The trailing actions a row reveals on hover (always shown where there is no hover).
const REVELA = "shrink-0 opacity-0 focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"

/** The Inbox's section header: label, an optional muted count and the chevron that names the
 * fold, with optional trailing actions beside it (an add, the pool's start/stop pair). */
function Cabecera(props: { título: string; cuenta?: JSX.Element; abierto: boolean; alternar: () => void; acción?: JSX.Element }) {
  return (
    <div class="group flex h-6 w-full shrink-0 items-center gap-0.5">
      <button
        type="button"
        aria-expanded={props.abierto}
        class="flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded-[6px] px-2 text-start text-[12px] leading-4 font-medium text-v2-text-text-muted hover:text-v2-text-text-base focus-visible:outline-none focus-visible:bg-v2-overlay-simple-overlay-hover"
        onClick={props.alternar}
      >
        <span class="min-w-0 truncate">{props.título}</span>
        <Show when={props.cuenta}>
          <span class="shrink-0 tabular-nums text-v2-text-text-muted">{props.cuenta}</span>
        </Show>
        <Icon name="chevron-down" size="small" class="ms-auto shrink-0 transition-transform" classList={{ "-rotate-90 rtl:rotate-90": !props.abierto }} />
      </button>
      {props.acción}
    </div>
  )
}

/** The quiet empty line a block shows before its first row. */
function Vacío(props: { children: JSX.Element }) {
  return <p class="truncate px-2 py-1 text-[12px] leading-4 text-v2-text-text-muted">{props.children}</p>
}

/** A link's state dot: connected, chasing its socket, or offline. */
function PuntoEnlace(props: { estado: "conectado" | "conectando" | "desconectado" }) {
  return (
    <span
      class="size-1.5 shrink-0 rounded-full"
      classList={{
        "bg-v2-state-fg-success": props.estado === "conectado",
        "bg-v2-state-fg-warning": props.estado === "conectando",
        "bg-v2-border-border-muted": props.estado === "desconectado",
      }}
      aria-hidden="true"
    />
  )
}

const claveBroker = (broker: FilaEnlaceNav["broker"]) => {
  switch (broker) {
    case "ibkr":
      return "trading.accounts.broker.ibkr"
    case "nt":
      return "trading.accounts.broker.nt"
    case "mt5":
      return "trading.accounts.broker.mt5"
  }
}

const ORDEN_BROKER: Record<FilaEnlaceNav["broker"], number> = { ibkr: 0, nt: 1, mt5: 2 }

// The word a link without accounts shows: a connected one only reads (an account is on its
// way), the others name their state.
const CLAVE_ESTADO_ENLACE = {
  conectado: "trading.accounts.link.role.watch",
  conectando: "trading.accounts.link.state.connecting",
  desconectado: "trading.accounts.link.state.offline",
} as const

/** The accounts, and nothing but the accounts: one flat row each, IBKR first, then the watch
 * platforms. The connection plumbing lives on the rows themselves — the dot reads its link's
 * state, a tag names the broker (and real money), a watched account removes its link on
 * hover. A link with no account yet (just registered, or the trading connection offline)
 * keeps one quiet row with its state, and the trading connection's offers its connect. */
function BloqueCuentas(props: { pref: Preferencias }) {
  const language = useLanguage()
  const { formatoUSD } = useFormatos()
  const dólares = usarDólares()
  const abierto = () => props.pref.estado.cuentas

  const primario = () => navArbol.enlaces[0]?.id ?? null
  const enlaceDe = (cuenta: FilaCuentaNav) => navArbol.enlaces.find((enlace) => enlace.id === cuenta.enlace)
  const orden = (enlace: FilaEnlaceNav | undefined) => (enlace ? ORDEN_BROKER[enlace.broker] : 0)

  const cuentas = createMemo(() => [...navArbol.cuentas].sort((a, b) => orden(enlaceDe(a)) - orden(enlaceDe(b))))
  const pendientes = createMemo(() => navArbol.enlaces.filter((enlace) => !navArbol.cuentas.some((cuenta) => cuenta.enlace === enlace.id)))

  const estadoEnlace = (enlace: FilaEnlaceNav | undefined) => {
    if (!enlace || enlace.conectado) return "conectado" as const

    if (enlace.id !== primario() || navArbol.conectando) return "conectando" as const

    return "desconectado" as const
  }

  return (
    <div class="flex w-full flex-col items-stretch gap-[3px]">
      <Cabecera
        título={language.t("trading.accounts.title")}
        abierto={abierto()}
        alternar={() => props.pref.fijar("cuentas", !abierto())}
        acción={
          <IconButton
            type="button"
            variant="ghost-muted"
            size="small"
            class="shrink-0"
            onClick={() => navArbol.registrarEnlace()}
            aria-label={language.t("trading.accounts.add.aria")}
            icon={<Icon name="plus" size="small" />}
          />
        }
      />
      <Show when={abierto()}>
        <Show when={navArbol.sincronizado && (cuentas().length > 0 || pendientes().length > 0)} fallback={<Vacío>{language.t("trading.accounts.empty")}</Vacío>}>
          <For each={cuentas()}>
            {(cuenta) => {
              const enlace = () => enlaceDe(cuenta)
              const demo = () => cuenta.demo ?? cuenta.id.startsWith("DU")
              const activa = () => navArbol.activa === cuenta.id

              return (
                <div
                  class={`${FILA} w-full [container-type:inline-size]`}
                  data-action="trading-account-row"
                  data-account={cuenta.id}
                  data-state={activa() ? "pressed" : undefined}
                  title={enlace()?.etiqueta ?? cuenta.enlace ?? undefined}
                >
                  <PuntoEnlace estado={estadoEnlace(enlace())} />
                  <button
                    type="button"
                    class="flex h-full min-w-0 flex-1 items-center gap-2 text-start focus-visible:outline-none"
                    aria-current={activa() ? "true" : undefined}
                    aria-label={language.t(demo() ? "trading.accounts.row.demo.aria" : "trading.accounts.row.live.aria", {
                      id: cuenta.id || "—",
                      pnl: formatoUSD(cuenta.pnl_dia),
                    })}
                    onClick={() => navArbol.cambiarCuenta(cuenta.id)}
                  >
                    <span class="shrink-0 tabular-nums">{cuenta.id || "—"}</span>
                    <Show when={enlace()}>
                      {(valor) => <span class="hidden shrink-0 text-[12px] font-[440] text-v2-text-text-muted @min-[240px]:inline">{language.t(claveBroker(valor().broker))}</span>}
                    </Show>
                    {/* Real money is the one mode worth a word; demo is the quiet default. */}
                    <Show when={!demo()}>
                      <span class="shrink-0 text-[12px] font-[440] text-v2-state-fg-warning">{language.t("trading.accounts.mode.live.short")}</span>
                    </Show>
                    <span class={`ms-auto shrink-0 text-[12px] font-[440] tabular-nums ${tonoPnl(cuenta.pnl_dia)}`}>{dólares(cuenta.pnl_dia)}</span>
                  </button>
                  <Show when={enlace() && enlace()!.id !== primario()}>
                    <IconButton
                      type="button"
                      variant="ghost-muted"
                      size="small"
                      class={REVELA}
                      onClick={() => navArbol.quitarEnlace(cuenta.enlace ?? "")}
                      aria-label={`${language.t("trading.accounts.link.remove.title")} — ${cuenta.id}`}
                      icon={<Icon name="close" size="small" />}
                    />
                  </Show>
                </div>
              )
            }}
          </For>
          <For each={pendientes()}>
            {(enlace) => {
              const principal = () => enlace.id === primario()
              const estado = () => estadoEnlace(enlace)
              const nombre = () => enlace.etiqueta ?? (principal() ? language.t("trading.accounts.link.primary") : enlace.id)
              const texto = () => language.t(CLAVE_ESTADO_ENLACE[estado()])

              return (
                <div class={`${FILA} w-full [container-type:inline-size]`} data-action="vertical-tabs-trading-link" data-link={enlace.id} data-connected={enlace.conectado ? "true" : "false"} title={enlace.id}>
                  <PuntoEnlace estado={estado()} />
                  <span class="min-w-0 truncate">{nombre()}</span>
                  <span class="hidden shrink-0 text-[12px] font-[440] text-v2-text-text-muted @min-[240px]:inline">{language.t(claveBroker(enlace.broker))}</span>
                  <span class="ms-auto shrink-0 text-[12px] font-[440]" aria-label={language.t("trading.accounts.link.aria", { name: nombre(), state: texto() })}>
                    {texto()}
                  </span>
                  <Show when={principal() && estado() === "desconectado"}>
                    <IconButton
                      type="button"
                      variant="ghost-muted"
                      size="small"
                      class="shrink-0"
                      disabled={!navArbol.puedeConectar}
                      onClick={() => navArbol.conectarPrincipal()}
                      aria-label={language.t("trading.engine.connect")}
                      title={language.t("trading.engine.connect")}
                      icon={<Icon name="globe" size="small" />}
                    />
                  </Show>
                  <Show when={!principal()}>
                    <IconButton
                      type="button"
                      variant="ghost-muted"
                      size="small"
                      class={REVELA}
                      onClick={() => navArbol.quitarEnlace(enlace.id)}
                      aria-label={`${language.t("trading.accounts.link.remove.title")} — ${nombre()}`}
                      icon={<Icon name="close" size="small" />}
                    />
                  </Show>
                </div>
              )
            }}
          </For>
        </Show>
      </Show>
    </div>
  )
}

/** One system row: its run dot, its name read as words with what it trades beside it, the
 * day P/L once it has one, and the run toggle on hover. The row's click opens the dossier. */
function FilaSistema(props: { sistema: FilaSistemaNav; ahora: number }) {
  const language = useLanguage()
  const dólares = usarDólares()
  const meta = () => [props.sistema.simbolo, props.sistema.temporalidad].filter((parte) => parte && parte !== "?").join(" · ")
  const conPnl = () => props.sistema.pnl_dia !== null && (props.sistema.enMarcha || props.sistema.pnl_dia !== 0)

  // How long ago the bot last wrote its own record: a live bot that has gone quiet reads at a
  // glance. Minutes under the hour, hours past it; the row's title keeps it when the P/L wins.
  const actividad = () => {
    const ts = props.sistema.actividad

    if (ts === null) return undefined

    const minutos = Math.max(0, Math.round((props.ahora - ts) / 60_000))
    const relativo = new Intl.RelativeTimeFormat(language.intl(), { numeric: "auto", style: "narrow" })

    return minutos < 60 ? relativo.format(-minutos, "minute") : relativo.format(-Math.round(minutos / 60), "hour")
  }

  const título = () => {
    const cuándo = actividad()

    const nombre = nombreLegible(props.sistema.nombre)

    return cuándo ? `${nombre} · ${language.t("trading.nav.system.activity", { when: cuándo })}` : nombre
  }

  return (
    <div class={`${FILA} w-full [container-type:inline-size]`} data-action="vertical-tabs-trading-system" data-system={props.sistema.id} title={título()}>
      <span class={`size-1.5 shrink-0 rounded-full ${props.sistema.enMarcha ? "bg-v2-state-fg-success" : "bg-v2-border-border-muted"}`} aria-hidden="true" />
      <button
        type="button"
        class="flex h-full min-w-0 flex-1 items-center gap-2 text-start focus-visible:outline-none"
        onClick={() => navArbol.fichaSistema(props.sistema.id)}
        aria-label={props.sistema.nombre}
      >
        <span class="min-w-0 truncate">{nombreLegible(props.sistema.nombre)}</span>
        {/* What it trades only when the sidebar is wide enough: at the default width the name wins. */}
        <Show when={meta()}>
          <span class="hidden shrink-0 text-[12px] font-[440] text-v2-text-text-muted @min-[280px]:inline">{meta()}</span>
        </Show>
        <Show
          when={conPnl()}
          fallback={
            <Show when={props.sistema.enMarcha && actividad()}>
              {(cuándo) => <span class="ms-auto shrink-0 text-[12px] font-[440] tabular-nums text-v2-text-text-muted">{cuándo()}</span>}
            </Show>
          }
        >
          <span class={`ms-auto shrink-0 text-[12px] font-[440] tabular-nums ${tonoPnl(props.sistema.pnl_dia)}`}>{dólares(props.sistema.pnl_dia)}</span>
        </Show>
      </button>
      <IconButton
        type="button"
        variant="ghost-muted"
        size="small"
        class={REVELA}
        onClick={() => navArbol.conmutarSistema(props.sistema.id)}
        aria-label={language.t(props.sistema.enMarcha ? "trading.nav.system.stop.aria" : "trading.nav.system.start.aria", { name: props.sistema.nombre })}
        icon={<Icon name={props.sistema.enMarcha ? "stop" : "play"} size="small" />}
      />
    </div>
  )
}

/** The systems: the header counts the running ones over the pool and owns the pool's
 * start/stop pair (same gates and confirmations as ever); the running systems lead and the
 * stopped ones fold under their own header. The block opens on its own while something runs,
 * and the stopped fold opens on its own while nothing does — until the user picks. */
function BloqueSistemas(props: { pref: Preferencias }) {
  const language = useLanguage()
  // The rows' "last activity" reads against this clock, ticking twice a minute.
  const [ahora, fijarAhora] = createSignal(Date.now())
  const reloj = setInterval(() => fijarAhora(Date.now()), 30_000)

  onCleanup(() => clearInterval(reloj))

  const enMarcha = createMemo(() => navArbol.sistemas.filter((sistema) => sistema.enMarcha))
  const parados = createMemo(() => navArbol.sistemas.filter((sistema) => !sistema.enMarcha))
  // An empty pool opens too: its empty line carries the folder pick a new install needs first.
  const visible = () => props.pref.estado.sistemas ?? (enMarcha().length > 0 || navArbol.sistemas.length === 0)
  const paradosVisible = () => props.pref.estado.parados ?? enMarcha().length === 0

  return (
    <div class="flex w-full flex-col items-stretch gap-[3px]">
      <Cabecera
        título={language.t("trading.bots")}
        cuenta={navArbol.sistemas.length > 0 ? `${enMarcha().length}/${navArbol.sistemas.length}` : undefined}
        abierto={visible()}
        alternar={() => props.pref.fijar("sistemas", !visible())}
        acción={
          <>
            <IconButton
              type="button"
              variant="ghost-muted"
              size="small"
              class={REVELA}
              disabled={!navArbol.puedeElegirCarpeta}
              onClick={() => navArbol.elegirCarpeta()}
              aria-label={language.t("trading.systems.folder.pick")}
              title={navArbol.carpeta ?? undefined}
              icon={<Icon name="folder" size="small" />}
            />
            <IconButton
              type="button"
              variant="ghost-muted"
              size="small"
              class={REVELA}
              disabled={!navArbol.puedeArrancar}
              onClick={() => navArbol.arrancarSistemas()}
              aria-label={language.t("trading.systems.startAll")}
              icon={<Icon name="play" size="small" />}
            />
            <IconButton
              type="button"
              variant="ghost-muted"
              size="small"
              class={REVELA}
              disabled={!navArbol.puedeParar}
              onClick={() => navArbol.pararSistemas()}
              aria-label={language.t("trading.systems.stopAll")}
              icon={<Icon name="stop" size="small" />}
            />
          </>
        }
      />
      <Show when={visible()}>
        <Show
          when={navArbol.sincronizado && navArbol.sistemas.length > 0}
          fallback={
            // An empty pool says where it looked and offers the pick right there: an install
            // whose default folder does not exist (another computer, a sandbox) starts here.
            <div class="flex flex-col items-start gap-1 px-2 py-1">
              <p class="text-[12px] leading-4 text-v2-text-text-muted break-all">
                {navArbol.carpeta ? language.t("trading.systems.folder.empty", { dir: navArbol.carpeta }) : language.t("trading.bots.empty")}
              </p>
              <Show when={navArbol.puedeElegirCarpeta}>
                <Button type="button" size="small" variant="ghost" icon="folder" onClick={() => navArbol.elegirCarpeta()}>
                  {language.t("trading.systems.folder.pick")}
                </Button>
              </Show>
            </div>
          }
        >
          <For each={enMarcha()}>{(sistema) => <FilaSistema sistema={sistema} ahora={ahora()} />}</For>
          <Show when={parados().length > 0}>
            <Cabecera
              título={language.t("trading.bots.stopped")}
              cuenta={parados().length}
              abierto={paradosVisible()}
              alternar={() => props.pref.fijar("parados", !paradosVisible())}
            />
            <Show when={paradosVisible()}>
              <For each={parados()}>{(sistema) => <FilaSistema sistema={sistema} ahora={ahora()} />}</For>
            </Show>
          </Show>
        </Show>
      </Show>
    </div>
  )
}

/** The panel's three views: everything, the trades (entries, closes, signals), and the loud
 * lines (warnings, errors). */
type VistaRegistro = "todo" | "operaciones" | "avisos"

const VISTAS: ReadonlyArray<{ id: VistaRegistro; clave: string }> = [
  { id: "todo", clave: "trading.log.filter.all" },
  { id: "operaciones", clave: "trading.log.filter.trades" },
  { id: "avisos", clave: "trading.log.filter.alerts" },
]

/** What the sidebar remembers across sessions, the Inbox's way: each block's fold (the systems
 * and their stopped group stay automatic until the user picks) and the log's last view. */
const PreferenciasSidebar = Persistence.struct({
  cuentas: Schema.Boolean,
  sistemas: Persistence.optional(Schema.Boolean),
  parados: Persistence.optional(Schema.Boolean),
  vista: Schema.Literals(["todo", "operaciones", "avisos"]),
})

const usePreferencias = () => {
  const [estado, fijar] = persisted(Persist.global("trading.sidebar"), PreferenciasSidebar, { cuentas: true, vista: "todo" })

  return { estado, fijar }
}

type Preferencias = ReturnType<typeof usePreferencias>

const enVista = (entrada: FilaRegistroNav, vista: VistaRegistro) => {
  if (vista === "operaciones") return entrada.evento !== null

  if (vista === "avisos") return entrada.nivel !== "info"

  return true
}

/** One record entry in two lines, the Inbox row's shape: who and what on top (the system read
 * as words, the class tag, the close's P/L, the clock time), the message whole below. An entry
 * a pool system wrote opens that system's dossier. */
function EntradaRegistro(props: { entrada: FilaRegistroNav; abrir?: () => void }) {
  const language = useLanguage()
  const { formatoUSD, formatoHora, títuloMomento } = useFormatos()
  const fuente = () => (props.entrada.bot === "motor" ? language.t("trading.log.source.engine") : nombreLegible(props.entrada.bot))

  const contenido = () => (
    <>
      <span class="flex h-4 w-full min-w-0 items-center gap-2 text-[12px] leading-4">
        <span class="min-w-0 truncate font-medium text-v2-text-text-base" title={props.entrada.bot}>
          {fuente()}
        </span>
        <EtiquetaRegistro entrada={props.entrada} />
        <Show when={props.entrada.evento === "cierre" && props.entrada.pnl !== null}>
          <span class={`shrink-0 tabular-nums ${tonoPnl(props.entrada.pnl)}`}>{formatoUSD(props.entrada.pnl)}</span>
        </Show>
        <time class="ms-auto shrink-0 tabular-nums text-v2-text-text-muted" title={títuloMomento(props.entrada.ts)}>
          {formatoHora(props.entrada.ts)}
        </time>
      </span>
      <span class="line-clamp-2 text-[13px] leading-4 break-words text-v2-text-text-muted" title={textoRegistro(props.entrada, language)}>
        {textoRegistro(props.entrada, language)}
      </span>
    </>
  )

  return (
    <Show when={props.abrir} fallback={<div class="flex flex-col gap-0.5 rounded-[6px] px-2 py-1.5">{contenido()}</div>}>
      {(abrir) => (
        <button
          type="button"
          class="flex w-full flex-col gap-0.5 rounded-[6px] px-2 py-1.5 text-start hover:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none focus-visible:bg-v2-overlay-simple-overlay-hover"
          onClick={abrir()}
        >
          {contenido()}
        </button>
      )}
    </Show>
  )
}

/** The system log's pinned row with its panel. The row says what is new since the panel was
 * last read (a count, and a red dot when an error is among it); the panel is the app's own v2
 * popover (portal, outside click and Escape close it), wider than a row so whole messages
 * fit, with the three views on top and the entries grouped by day, newest first. The strip's
 * row under the titlebar opens it downward. */
function FilaRegistro(props: { pref: Preferencias }) {
  const language = useLanguage()
  const [abierto, fijarAbierto] = createSignal(false)
  const vista = () => props.pref.estado.vista
  // What the reader has seen: entries newer than the last close count as new. Session-only.
  const [leído, fijarLeído] = createSignal(Date.now())

  const recientes = createMemo(() => [...navArbol.registros].reverse())
  const nuevas = createMemo(() => (abierto() ? [] : navArbol.registros.filter((entrada) => entrada.ts > leído())))
  const conError = () => nuevas().some((entrada) => entrada.nivel === "error")

  const día = createMemo(() => new Intl.DateTimeFormat(language.intl(), { weekday: "long", day: "numeric", month: "long" }))

  const grupos = createMemo(() => {
    const hoy = new Date().toDateString()
    const lista: { clave: string; título: string; entradas: FilaRegistroNav[] }[] = []

    for (const entrada of recientes()) {
      if (!enVista(entrada, vista())) continue
      const clave = new Date(entrada.ts).toDateString()
      const último = lista.at(-1)

      if (último?.clave === clave) {
        último.entradas.push(entrada)
        continue
      }

      lista.push({ clave, título: clave === hoy ? language.t("trading.log.day.today") : día().format(entrada.ts), entradas: [entrada] })
    }

    return lista
  })

  const cambiar = (abrir: boolean) => {
    if (!abrir) fijarLeído(Date.now())
    fijarAbierto(abrir)
  }

  // An entry of a pool system opens that system's dossier (the engine's own lines have none).
  const abrirSistema = (entrada: FilaRegistroNav) => {
    const sistema = navArbol.sistemas.find((candidato) => candidato.nombre === entrada.bot)

    if (!sistema) return undefined

    return () => {
      cambiar(false)
      navArbol.fichaSistema(sistema.id)
    }
  }

  return (
    <Popover open={abierto()} onOpenChange={cambiar} placement="bottom-start" gutter={4}>
      <Popover.Trigger
        data-action="trading-log-row"
        class={`${FILA} data-[expanded]:bg-v2-overlay-simple-overlay-pressed data-[expanded]:text-v2-text-text-base`}
        aria-label={language.t("trading.log")}
      >
        <Icon name="bullet-list" class="shrink-0" />
        <span class="min-w-0 truncate">{language.t("trading.log")}</span>
        <Show when={nuevas().length > 0}>
          <Show when={conError()}>
            <span class="size-1.5 shrink-0 rounded-full bg-v2-state-fg-danger" aria-hidden="true" />
          </Show>
          <span class="ms-auto shrink-0 text-[12px] font-[440] tabular-nums text-v2-text-text-muted">{language.plural("trading.log.unread", nuevas().length)}</span>
        </Show>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          aria-label={language.t("trading.log")}
          dir={language.direction()}
          class="z-50 flex max-h-[min(520px,var(--kb-popper-content-available-height))] w-[min(440px,calc(100vw-24px))] flex-col overflow-hidden rounded-[10px] bg-v2-background-bg-layer-01 shadow-[var(--v2-elevation-floating)] outline-none"
        >
          <div class="flex shrink-0 items-center gap-2 py-1.5 pe-1.5 ps-3">
            <span class="min-w-0 flex-1 truncate text-[13px] leading-4 font-medium text-v2-text-text-base">{language.t("trading.log")}</span>
            <MenuDescarga entradas={recientes} />
          </div>
          <div class="flex shrink-0 gap-1 px-2.5 pb-1.5" role="group">
            <For each={VISTAS}>
              {(opción) => (
                <button
                  type="button"
                  class="h-6 shrink-0 rounded-full border px-2 text-[12px] leading-4"
                  classList={{
                    "border-v2-border-border-muted bg-v2-background-bg-layer-02 text-v2-text-text-base": vista() === opción.id,
                    "border-transparent text-v2-text-text-muted hover:text-v2-text-text-base": vista() !== opción.id,
                  }}
                  aria-pressed={vista() === opción.id}
                  onClick={() => props.pref.fijar("vista", opción.id)}
                >
                  {language.t(opción.clave)}
                </button>
              )}
            </For>
          </div>
          <div class="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5" data-scrollable>
            <Show
              when={grupos().length > 0}
              fallback={<Vacío>{language.t(recientes().length > 0 ? "trading.log.filter.empty" : "trading.log.empty")}</Vacío>}
            >
              <For each={grupos()}>
                {(grupo) => (
                  <div class="flex flex-col gap-px">
                    <div class="flex h-6 items-center px-2 text-[12px] leading-4 font-medium text-v2-text-text-muted">{grupo.título}</div>
                    <For each={grupo.entradas}>{(entrada) => <EntradaRegistro entrada={entrada} abrir={abrirSistema(entrada)} />}</For>
                  </div>
                )}
              </For>
            </Show>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover>
  )
}

/** The strip's docked panel: the nav's own block under a row. The popover the system log
 * rides, hosting a nav block verbatim — the center stays the desk on every layout, and the
 * nav stays one click overhead without a column, a sidebar or a page of its own. Its row
 * runs on content. */
function FilaPanel(props: { pref: Preferencias; icono: string; clave: string; children: JSX.Element }) {
  const language = useLanguage()
  const [abierto, fijarAbierto] = createSignal(false)

  return (
    <Popover open={abierto()} onOpenChange={fijarAbierto} placement="bottom-start" gutter={4}>
      <Popover.Trigger
        data-action="trading-nav-strip"
        class={`${FILA} data-[expanded]:bg-v2-overlay-simple-overlay-pressed data-[expanded]:text-v2-text-text-base`}
        aria-label={language.t(props.clave)}
      >
        <Icon name={props.icono} class="shrink-0" />
        <span class="min-w-0 truncate">{language.t(props.clave)}</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          aria-label={language.t(props.clave)}
          dir={language.direction()}
          class="z-50 flex max-h-[min(520px,var(--kb-popper-content-available-height))] w-[min(440px,calc(100vw-24px))] flex-col overflow-hidden rounded-[10px] bg-v2-background-bg-layer-01 shadow-[var(--v2-elevation-floating)] outline-none"
        >
          <div class="min-h-0 flex-1 overflow-y-auto px-2 pt-2 pb-2.5" data-scrollable>
            {props.children}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover>
  )
}

/** The strip for the layouts that never host the product's sidebar (a horizontal tab strip,
 * every stacked window and the phone — crates whose dashboard header carries this row): the
 * sidebar's surfaces as docked panels — accounts, systems, then the system log pinned at
 * the row's end — and nothing more. No page of its own behind any of them: the center is
 * the desk on every layout, and the nav opens overhead like the sidebar's foot does. */
export function TradingNavStrip() {
  const language = useLanguage()
  const pref = usePreferencias()

  return (
    <nav aria-label={language.t("trading.nav.aria")} class="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto no-scrollbar">
      <FilaPanel pref={pref} icono="providers" clave="trading.accounts.title">
        <BloqueCuentas pref={pref} />
      </FilaPanel>
      <FilaPanel pref={pref} icono="play" clave="trading.bots">
        <BloqueSistemas pref={pref} />
      </FilaPanel>
      <div class="ms-auto flex items-center gap-1 ps-2">
        <FilaRegistro pref={pref} />
      </div>
    </nav>
  )
}
