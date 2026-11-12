// Connection with the trading engine: the app's own background service (the v2 service that
// serves the dashboard), through the same SDK the rest of the app uses. Snapshot reads are
// read-only; writes stay behind the engine and the agent's permissioned flow.

import type { OpenCodeClient } from "@opencode/client/promise"

export interface CuentaInfo {
  readonly id: string
  readonly tipo: string
  readonly efectivo: number | null
  readonly patrimonio: number | null
  readonly pnl_dia: number | null
  readonly pnl_realizado: number | null
  /** AvailableFunds from the account summary (USD); null until IBKR sends the tag. */
  readonly disponible: number | null
  /** BuyingPower from the account summary (USD); null until IBKR sends the tag. */
  readonly compraPoder: number | null
  /** MaintMarginReq from the account summary (USD); null until IBKR sends the tag. */
  readonly margenUsado: number | null
  /** ExcessLiquidity from the account summary (USD); null until IBKR sends the tag. */
  readonly liquidezExtra: number | null
  /** Epoch ms of the newest account fact (summary tag or portfolio update); null until seen. */
  readonly actualizada: number | null
  /** The engine link the account lives on ("host:port" or the MT5 identity); null when the engine predates links. */
  readonly enlace: string | null
  /** Whether the account itself carries demo money (MT5's terminal answers straight);
   * null when the engine predates the field or the platform keeps no such fact. */
  readonly demo: boolean | null
}

/** One registered watch: an IBKR TWS address whose socket the engine keeps chasing, or an
 * MT5 identity whose account arrives over the engine's Python bridge (no TWS address).
 * The panel's own primary link (the Conectar flow) is one of them, unnamed. */
export interface EnlaceInfo {
  readonly id: string
  /** The TWS address; null on an MT5 watch (its engine's bridge dials no address). */
  readonly host: string | null
  /** The TWS API port; null on an MT5 watch likewise. */
  readonly port: number | null
  readonly etiqueta: string | null
  /** The broker platform the link speaks (IBKR TWS so far); links of older engines read ibkr. */
  readonly broker: "ibkr" | "nt" | "mt5"
  readonly conectado: boolean
}

export interface BotInfo {
  readonly id: string
  readonly nombre: string
  readonly activo: boolean
  /** A live bot process exists for this system (the engine's running mirror). */
  readonly enMarcha: boolean
  /** The bot's process id while running; null otherwise. */
  readonly pid: number | null
  /** Epoch ms when the engine last saw the bot start; null otherwise. */
  readonly arrancada: number | null
  readonly simbolo: string
  readonly temporalidad: string
  readonly pnl_dia: number | null
  /** The bot's configured TWS CLIENT_ID; null when the engine drew a blank (older engine, unreadable config). */
  readonly cliente: number | null
  /** The config's session-close hour ("HH:MM:SS", New York's close); null when absent. */
  readonly horaCierre: string | null
  /** Epoch ms of the bot's newest own record row today; null until it logs. */
  readonly actividad: number | null
  /** The system's one-paragraph idea from its own reglas.json; null when absent. */
  readonly descripcion: string | null
  /** The system's rules as (name, rule) pairs in file order; null when reglas.json is absent. */
  readonly reglas: readonly (readonly [string, string])[] | null
}

export interface PosicionInfo {
  readonly simbolo: string
  readonly lado: "largo" | "corto"
  readonly tamano: number
  readonly entrada: number | null
  readonly actual: number | null
  readonly pnl: number | null
  readonly pnl_pct: number | null
}

export interface RegistroInfo {
  readonly ts: number
  readonly nivel: "info" | "aviso" | "error"
  readonly bot: string
  readonly mensaje: string
  /** The engine's i18n key for the row (`trading.log.*`); null when the row predates keys
   * or the text carries no key (bot rows, for instance). The view renders the key when
   * present and falls back to the raw English message. */
  readonly clave_mensaje: string | null
  /** Interpolation values for `clave_mensaje`; null when the row carries no key or none are needed. */
  readonly params_mensaje: Record<string, string | number | boolean> | null
  /** The few entries that mark a position lifecycle beat: an open, an average-in ("apertura"),
   * a close ("cierre") or the first signal ("senal"); null for every other line. */
  readonly evento: "apertura" | "cierre" | "senal" | null
}

/** One closed trade as the bot itself reported it (its "FUERA … (±X USD brutos)" row). */
export interface TradeInfo {
  readonly bot: string
  readonly hora: number
  /** The bot's stated gross USD; null when the row carried no figure. */
  readonly pnl: number | null
  readonly mensaje: string
}

/** One equity-curve sample: account values as reported by IBKR (null until they arrive). */
export interface CurvaInfo {
  readonly hora: number
  readonly patrimonio: number | null
  readonly pnl_dia: number | null
}

export interface SnapshotMotor {
  /** true while the engine's TWS socket is up (whatever TWS address it serves). */
  enlace: boolean
  /** The engine's TWS client id while TWS refuses it as taken by another API program; null
   * while it is free, on older engines and on the sample. */
  clienteOcupado: number | null
  /** true while only sample data is available (the engine has never been read). */
  demo: boolean
  motor: { version: string }
  cuenta: CuentaInfo
  bots: BotInfo[]
  posiciones: PosicionInfo[]
  /** Every open position the engine sees across the whole trading connection — the shown
   * view's rows span one account only, and the emergency close sweeps this surface (P-1).
   * null on older engines and the sample: the shown view stands in. */
  exposicion: PosicionInfo[] | null
  /** The positions the emergency close can actually close, cut down to the connection's own
   * accounts when the login spans others (P-1): what the panic closes, not what the whole
   * login sees. null on engines that predate the field (and the sample): `exposicion`
   * stands in. */
  exposicionCerrable: PosicionInfo[] | null
  registros: RegistroInfo[]
  trades: TradeInfo[]
  curva: CurvaInfo[]
  /** Every account the engine's links have discovered; null when the serving engine
   * predates the field (or the sample fallback, which invents none). */
  cuentas: CuentaInfo[] | null
  /** The engine's links, the panel's primary one first; null on older engines and the sample. */
  enlaces: EnlaceInfo[] | null
  /** The folder the engine reads its systems from; null on older engines and the sample. */
  carpetaSistemas: string | null
  /** TWS's and MetaTrader 5's state on this computer (MT5's only while an MT5 account is
   * linked); null on older engines and the sample. */
  programas: ProgramasInfo | null
}

export type EstadoPrograma = "running" | "opening" | "closed" | "missing"

export interface ProgramasInfo {
  tws: EstadoPrograma
  mt5: EstadoPrograma | null
}

// ----------------------------- sample data -----------------------------
// A fictional pool shaped like the real one: an obviously named sample account (U-11 —
// nothing here may be quotable as a real holding), one sample position on a symbol no
// desk would carry, 15 systems on the same shapes the user's pool has. Shown until the
// engine answers a first time; the values mirror the TUI plugin's DEMO so both views
// read the same numbers. Writes stay blocked on sample rows for good.

/** One DEMO row: the dossier facts stay null on purpose — the engine fills them from each
 * bot's own files, and a sample row has no business inventing CLIENT_IDs or rules. */
function botDemo(nombre: string, activo: boolean, simbolo: string, temporalidad: string, pnl_dia: number): BotInfo {
  return {
    id: nombre.slice(0, 2),
    nombre,
    activo,
    enMarcha: false,
    pid: null,
    arrancada: null,
    simbolo,
    temporalidad,
    pnl_dia,
    cliente: null,
    horaCierre: null,
    actividad: null,
    descripcion: null,
    reglas: null,
  }
}

export const DEMO: SnapshotMotor = {
  enlace: false,
  clienteOcupado: null,
  demo: true,
  motor: { version: "sample" },
  cuenta: {
    id: "DEMO-0000",
    tipo: "Demo (paper) · IBKR",
    efectivo: 24_870.35,
    patrimonio: 24_870.35,
    pnl_dia: -81.11,
    pnl_realizado: -124.5,
    disponible: null,
    compraPoder: null,
    margenUsado: null,
    liquidezExtra: null,
    actualizada: null,
    enlace: null,
    demo: true,
  },
  bots: [
    botDemo("01_nasdaq_apertura_alcista", true, "NQ", "5m", 12.5),
    botDemo("02_nasdaq_ruptura_media_hora", false, "NQ", "30m", 0),
    botDemo("03_nasdaq_impulso_con_tendencia", false, "NQ", "15m", 0),
    botDemo("04_oro_rebote_del_viernes", false, "GC", "30m", 0),
    botDemo("05_oro_fuerza_de_madrugada", false, "GC", "15m", 0),
    botDemo("06_nasdaq_pullback", true, "NQ", "1h", -40),
    botDemo("07_oro_nube_ichimoku", false, "GC", "1h", 0),
    botDemo("08_russell_estocastico_h2", false, "RTY", "2h", 0),
    botDemo("09_russell_cci_tendencia", false, "RTY", "1h", 0),
    botDemo("10_russell_estocastico_h4", false, "RTY", "4h", 0),
    botDemo("11_usdjpy_ruptura_bollinger", false, "JPY", "1h", 0),
    botDemo("12_usdjpy_ruptura_keltner", false, "JPY", "1h", 0),
    botDemo("13_usdjpy_ruptura_donchian", false, "JPY", "1h", 0),
    botDemo("14_usdjpy_cruce_ema_10_40", false, "JPY", "1h", 0),
    botDemo("15_usdjpy_precio_ema30_h3", false, "JPY", "3h", 0),
  ],
  posiciones: [
    { simbolo: "DEMO-MNQ", lado: "corto", tamano: 1, entrada: 25_150.75, actual: 25_191.3, pnl: -81.11, pnl_pct: -0.16 },
  ],
  // The sample invents no exposure read: the shown view stands in, the way older engines' do.
  exposicion: null,
  exposicionCerrable: null,
  registros: [
    RegistroDemo(-90, "info", "motor", "trading.demo.log.sample"),
    RegistroDemo(-80, "info", "01_nasdaq_apertura_alcista", "trading.demo.log.started"),
    RegistroDemo(-40, "info", "06_nasdaq_pullback", "trading.demo.log.signal"),
    RegistroDemo(-20, "aviso", "10_russell_estocastico_h4", "trading.demo.log.offsession"),
    RegistroDemo(-1, "info", "motor", "trading.demo.log.ready", { systems: 15, active: 3 }),
  ],
  trades: [
    { bot: "01_nasdaq_apertura_alcista", hora: Date.now() - 75 * 60_000, pnl: 46.25, mensaje: "FUERA a 10:32:14 · +46.25 USD brutos" },
    { bot: "06_nasdaq_pullback", hora: Date.now() - 52 * 60_000, pnl: -38.5, mensaje: "FUERA a 10:48:02 · -38.5 USD brutos" },
  ],
  curva: [],
  // The sample invents no account list or links either: the chips and the link rows stay
  // hidden until a serving engine carries them.
  cuentas: null,
  enlaces: null,
  carpetaSistemas: null,
  programas: null,
}

/** A sample log row: its text travels as an i18n key (`trading.demo.*` in `en.ts`), the same
 * way an engine row carries `trading.log.*` reads — never as inline copy. */
function RegistroDemo(minutosAtras: number, nivel: RegistroInfo["nivel"], bot: string, clave: string, params?: Record<string, string | number | boolean>): RegistroInfo {
  return { ts: Date.now() - minutosAtras * 60_000, nivel, bot, mensaje: "", clave_mensaje: clave, params_mensaje: params ?? null, evento: null }
}

// ------------------------------ read cycle ------------------------------

/** The engine's snapshot contract served by the app's own service (`experimental.trading.*`). */
type SnapshotNativo = Awaited<ReturnType<OpenCodeClient["experimental"]["trading"]["snapshot"]>>

/** The SDK keeps numbers JSON-safe: NaN and the infinities arrive as strings. Real values are
 * always finite (the engine runs everything through safeNumber), so anything else maps to null. */
type NumeroCru = number | "Infinity" | "-Infinity" | "NaN"

function numeroNulo(valor: NumeroCru | null): number | null {
  return typeof valor === "number" ? valor : null
}

function numero(valor: NumeroCru): number {
  return typeof valor === "number" ? valor : NaN
}

/** Maps the engine's native English contract onto the dashboard's existing Spanish views. */

// The engine maps its log levels ("warning") to the dashboard's Spanish ones ("aviso"); the
// warning→aviso mapping lives here so the view contract keeps its Spanish vocabulary.
function nivelDeMotor(level: "info" | "warning" | "error"): RegistroInfo["nivel"] {
  if (level === "warning") return "aviso"

  if (level === "error") return "error"

  return "info"
}

function eventoDeNativo(event: "open" | "close" | "signal" | undefined): RegistroInfo["evento"] {
  if (event === "open") return "apertura"

  if (event === "close") return "cierre"

  if (event === "signal") return "senal"

  return null
}

/** The engine's interpolation params, narrowed to what the templates use (strings, numbers,
 * booleans); anything else drops out and the view falls back to the row's raw English message. */
function paramsDeMotor(params: SnapshotNativo["logs"][number]["message_params"]): RegistroInfo["params_mensaje"] {
  if (params === undefined) return null
  const salida: Record<string, string | number | boolean> = {}
  for (const [clave, valor] of Object.entries(params)) {
    if (typeof valor === "string" || typeof valor === "number" || typeof valor === "boolean") salida[clave] = valor
  }
  return salida
}


/** The native account facts onto the dashboard's Spanish view; the optional link trait stays
 * null on older engines. Empty strings keep the existing fallback rendering ("—"). */
type CuentaNativa = NonNullable<SnapshotNativo["accounts"]>[number]

function cuentaDeNativo(nativa: CuentaNativa): CuentaInfo {
  return {
    id: nativa.id ?? "",
    tipo: nativa.type ?? "",
    efectivo: numeroNulo(nativa.cash ?? null),
    patrimonio: numeroNulo(nativa.equity ?? null),
    pnl_dia: numeroNulo(nativa.pnl_day ?? null),
    pnl_realizado: numeroNulo(nativa.pnl_realized ?? null),
    disponible: numeroNulo(nativa.available_funds ?? null),
    compraPoder: numeroNulo(nativa.buying_power ?? null),
    margenUsado: numeroNulo(nativa.margin_used ?? null),
    liquidezExtra: numeroNulo(nativa.excess_liquidity ?? null),
    actualizada: numeroNulo(nativa.updated_at ?? null),
    enlace: nativa.link ?? null,
    demo: nativa.demo ?? null,
  }
}

function desdeNativo(nativo: SnapshotNativo): Omit<SnapshotMotor, "demo"> {
  const cuenta: CuentaInfo = nativo.account === null
    ? {
        id: "",
        tipo: "",
        efectivo: null,
        patrimonio: null,
        pnl_dia: null,
        pnl_realizado: null,
        disponible: null,
        compraPoder: null,
        margenUsado: null,
        liquidezExtra: null,
        actualizada: null,
        enlace: null,
        demo: null,
      }
    : cuentaDeNativo(nativo.account)

  const filaPosicion = (position: SnapshotNativo["positions"][number]): PosicionInfo => ({
    simbolo: position.symbol,
    lado: position.side === "long" ? "largo" : "corto",
    tamano: numero(position.size),
    entrada: numeroNulo(position.entry),
    actual: numeroNulo(position.current),
    pnl: numeroNulo(position.pnl),
    pnl_pct: numeroNulo(position.pnl_pct),
  })

  return {
    enlace: nativo.connected,
    clienteOcupado: numeroNulo(nativo.client_in_use ?? null),
    motor: { version: nativo.version },
    cuenta,
    bots: [...nativo.systems].map((system) => ({
      id: system.id,
      nombre: system.name,
      activo: system.active,
      enMarcha: system.running,
      pid: numeroNulo(system.pid),
      arrancada: numeroNulo(system.started_at),
      simbolo: system.symbol,
      temporalidad: system.timeframe,
      pnl_dia: numeroNulo(system.pnl_day),
      cliente: numeroNulo(system.client_id ?? null),
      horaCierre: system.close_hour ?? null,
      actividad: numeroNulo(system.last_activity_at ?? null),
      descripcion: system.description ?? null,
      reglas: system.rules ? Object.entries(system.rules) : null,
    })),
    posiciones: nativo.positions.map(filaPosicion),
    exposicion: nativo.open_positions === undefined ? null : nativo.open_positions.map(filaPosicion),
    // An engine without the closable read (an older one) omits the field: the exposure stands in.
    exposicionCerrable: nativo.closable_positions === undefined ? null : nativo.closable_positions.map(filaPosicion),
    registros: [...nativo.logs].map((entry) => ({
      ts: numero(entry.ts),
      nivel: nivelDeMotor(entry.level),
      bot: entry.system,
      mensaje: entry.message,
      clave_mensaje: entry.message_key ?? null,
      params_mensaje: paramsDeMotor(entry.message_params),
      evento: eventoDeNativo(entry.event),
    })),
    // An engine predating these fields (the live sidecar until its engine restart) simply omits them.
    trades: (nativo.trades ?? []).map((trade) => ({
      bot: trade.system,
      hora: numero(trade.ts),
      pnl: numeroNulo(trade.pnl ?? null),
      mensaje: trade.message,
    })),
    curva: (nativo.equity ?? []).map((punto) => ({
      hora: numero(punto.ts),
      patrimonio: numeroNulo(punto.equity ?? null),
      pnl_dia: numeroNulo(punto.pnl_day ?? null),
    })),
    // The account list and the links arrive with the engine; absence keeps the chips hidden
    // (an older engine's snapshot stays shaped exactly as it was).
    carpetaSistemas: nativo.systems_dir ?? null,
    programas: nativo.programs === undefined ? null : { tws: nativo.programs.tws, mt5: nativo.programs.mt5 ?? null },
    cuentas:
      nativo.accounts === undefined
        ? null
        : [...nativo.accounts].map((cuentaNativa) => cuentaDeNativo(cuentaNativa)),
    enlaces:
      nativo.links === undefined
        ? null
        : [...nativo.links].map((enlace) => ({
            id: enlace.id,
            // An MT5 watch arrives with no TWS address at all.
            host: enlace.host ?? null,
            port: numeroNulo(enlace.port ?? null),
            etiqueta: enlace.label ?? null,
            // An engine predating the broker field runs TWS links only — every one an IBKR.
            broker: enlace.broker ?? "ibkr",
            conectado: enlace.connected,
          })),
  }
}

/**
 * Asks the engine (the app's own server) for its snapshot. undefined when the server does
 * not answer — a halted engine must keep the dashboard at its last data instead of hanging
 * the poll, so the call is aborted after a short wait.
 */
export async function pedirSnapshot(api: OpenCodeClient): Promise<Omit<SnapshotMotor, "demo"> | undefined> {
  const respuesta = await api
    .experimental.trading.snapshot({ signal: AbortSignal.timeout(10_000) })
    .catch(() => undefined)

  if (respuesta === undefined) return undefined

  return desdeNativo(respuesta)
}

/** Starts the system's bot process (or adopts one already running in the pool folder); a
 * refusal surfaces honestly through the engine's verdict. */
export function arrancarSistema(api: OpenCodeClient, id: string) {
  return api.experimental.trading.system.activate({ systemID: id }).catch(() => undefined)
}

/** Stops the system's bot process (the engine's pid-guarded kill; a stop it cannot confirm is reported). */
export function pararSistema(api: OpenCodeClient, id: string) {
  return api.experimental.trading.system.pause({ systemID: id }).catch(() => undefined)
}

/**
 * Schedules one of the engine's tasks: start or stop systems at a run time on the PC's clock,
 * given as a wait in minutes or a local "HH:MM". The task only starts or stops the bots —
 * it never places orders.
 */
export function programarTarea(api: OpenCodeClient, input: { kind: "start-systems" | "stop-systems"; systemIDs?: string[]; delayMinutes?: number; atTime?: string }) {
  return api.experimental.trading.task
    .add({ kind: input.kind, systemIDs: input.systemIDs, delayMinutes: input.delayMinutes, atTime: input.atTime })
    .catch(() => undefined)
}

/**
 * Runs the full close cycle for one position: the desk's own open orders cancel first
 * (anything foreign to the desk aborts the close), the live position is re-read, the
 * opposite market order goes out and, when it cannot execute, the engine sends two OCA
 * GTC limit orders a few ticks wide on the contract's own grid; an MT5 account's position
 * closes in its own terminal. The engine's transmitted closes are the broker's to fill, so
 * the verdict is a request outcome, not a done guarantee. `requestId` makes a repeat of the
 * same submission return its earlier verdict instead of racing it. undefined when the server
 * did not answer. A write: it only happens behind the confirmation dialog, never directly.
 */
export function cerrarPosicion(api: OpenCodeClient, símbolo: string, requestId?: string) {
  return api.experimental.trading.position.close({ symbol: símbolo, requestId }).catch(() => undefined)
}

/**
 * The emergency version of the per-position close: the same full cycle over every open
 * position, one past the other; a failure never stops the rest. `requestId` makes a repeat
 * of the same submission return its earlier verdict. The result is the engine's aggregated
 * verdict (ok + plain message listing every symbol's outcome); undefined when the server
 * did not answer. A write: it only happens behind the confirmation dialog, never directly.
 */
export function cerrarTotal(api: OpenCodeClient, requestId?: string) {
  return api.experimental.trading.positions.closeAll({ requestId }).catch(() => undefined)
}

/** Links the engine's TWS socket up (the user's click; the click opens a closed TWS and nothing else opens on its own). */
export function conectarCuenta(api: OpenCodeClient) {
  return api.experimental.trading.connect().catch(() => undefined)
}

/** Drops the engine's TWS socket until the next connect (running bots are untouched). */
export function desconectarCuenta(api: OpenCodeClient) {
  return api.experimental.trading.disconnect().catch(() => undefined)
}

/**
 * The panic button: every running bot stops and the emergency close-all runs over the open
 * positions. The result lists the stopped systems plus the close verdict; undefined when the
 * server did not answer. A write: it only happens behind the confirmation dialog.
 */
export function panicoTotal(api: OpenCodeClient) {
  return api.experimental.trading.panic().catch(() => undefined)
}

/** Switches the dashboard's active account (every account field follows in the next snapshot). */
export function seleccionarCuenta(api: OpenCodeClient, accountID: string) {
  return api.experimental.trading.account.select({ accountID }).catch(() => undefined)
}

/** Registers an extra link as a permanent balance watch: an IBKR registration dials a
 * second TWS address (the live port behind the dialog's explicit confirmation), platforms
 * without an engine-side read link yet are refused. The rejection surfaces raw — the caller
 * decides how the honest refusal shows. */
export function añadirEnlace(api: OpenCodeClient, input: { host?: string; port?: number; label?: string; broker?: "ibkr" | "nt" | "mt5"; live?: boolean; mt5Login?: number; mt5Server?: string }) {
  return api.experimental.trading.link.add({ host: input.host, port: input.port, label: input.label, broker: input.broker, live: input.live, mt5Login: input.mt5Login, mt5Server: input.mt5Server })
}

/** Knocks on IBKR API ports (TCP only, nothing connects): the two defaults on this computer,
 * or the one address given — the wizard's check before registering. undefined when the
 * server did not answer. */
export function detectarPuertosIbkr(api: OpenCodeClient, input: { host?: string; port?: number } = {}) {
  return api.experimental.trading.ibkr.detect({ host: input.host, port: input.port }).catch(() => undefined)
}

/** Points the engine at the systems folder the user picked; the engine's refusal (a system
 * running, or no systems in the folder) surfaces raw for the caller to show. */
export function elegirCarpetaSistemas(api: OpenCodeClient, dir: string) {
  return api.experimental.trading.pool.select({ dir })
}

/** Withdraws a registered link (the panel's own primary link refuses on its own). */
export function quitarEnlace(api: OpenCodeClient, linkID: string) {
  return api.experimental.trading.link.remove({ linkID }).catch(() => undefined)
}

/** How often the dashboard re-polls the engine. */
export const REFRESCO_MS = 3_000
