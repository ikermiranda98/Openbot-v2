export * as TradingEngine from "./trading.js"

import { and, asc, desc, eq, isNotNull, lte } from "drizzle-orm"
import { Cause, Context, Effect, Exit, Layer, Option, Schema } from "effect"
import { spawn, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import { createInterface } from "node:readline"
import { createConnection, isIP } from "node:net"
import { open, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Trading } from "@opencode/schema/trading"
import {
  IBApiNext,
  IBApiNextError,
  ConnectionState,
  OrderAction,
  OrderType,
  TimeInForce,
  type AccountSummaryValues,
  type Contract,
  type OpenOrder,
  type Order,
  type Position,
} from "@stoqey/ib"
import { Database } from "./database/database.js"
import { TradingAccountTable, TradingCloseTable, TradingLinkTable, TradingMetaTable, TradingTaskTable, TradingTradeTable } from "./trading/sql.js"
import {
  type DatoVivo,
  LineaPuenteMT5,
  MODO_MT5,
  PUENTE_PY,
  carpetaMetaQuotes,
  leerCuentasDisco,
  leerPuente,
  sondearCuenta,
} from "./trading/mt5.js"
import { ordenMT5 } from "./trading/mt5-ordenes.js"
import { conexionIb } from "./trading/registro-ib.js"
import { DESCARGA, type EstadoPrograma, type Programa, abrir, enMarcha, localizar, procesos } from "./trading/programas.js"

/** The wire's words for a program's state. */
const ESTADO_PROGRAMA: Record<EstadoPrograma, Trading.ProgramState> = {
  abierto: "running",
  abriendo: "opening",
  cerrado: "closed",
  falta: "missing",
}

export class SystemNotFoundError extends Schema.TaggedError<SystemNotFoundError>()("TradingEngine.SystemNotFound", {
  systemID: Schema.String,
}) {}

/** The engine starts one bot process per system, so its name/id must also tell the pool folder. */
export class InvalidTaskError extends Schema.TaggedError<InvalidTaskError>()("TradingEngine.InvalidTask", {
  message: Schema.String,
}) {}

export class TaskNotFoundError extends Schema.TaggedError<TaskNotFoundError>()("TradingEngine.TaskNotFound", {
  taskID: Schema.String,
}) {}

export interface TaskAddInput {
  readonly kind: Trading.TaskKind
  /** System IDs to act on; empty or omitted means every system in the pool. */
  readonly systemIDs?: readonly string[]
  /** Minutes from now on the server machine's local (PC) clock; mutually exclusive with `atTime`. */
  readonly delayMinutes?: number
  /** The next local wall-clock time "HH:MM" (PC clock; tomorrow when it is past today already); mutually exclusive with `delayMinutes`. */
  readonly atTime?: string
}

export interface Interface {
  /** The engine's whole state; a synchronous read of the last values received from IBKR. */
  readonly snapshot: () => Trading.Snapshot
  /** Starts the system's bot: spawns `pythonw bot.py` with its pid marker after adopting
   * any instance already running, and reports a folder, console or spawn fault honestly. */
  readonly activate: (systemID: string) => Effect.Effect<Trading.System, SystemNotFoundError>
  /** Stops the system's bot process — the pid-guarded kill that only ever terminates a
   * process whose command line is the system's own `bot.py`; a stop the engine could not
   * confirm is reported rather than claimed. */
  readonly pause: (systemID: string) => Effect.Effect<Trading.System, SystemNotFoundError>
  /**
   * Runs the full close cycle for one position: the desk's own open orders on the contract
   * cancel first (anything foreign to the desk aborts the close before a single cancel
   * flies), the live position is re-read right before the send, and the opposite market
   * order goes out. When it cannot execute, two OCA GTC limit orders a few ticks wide go
   * out once the market order's terminal state is positively confirmed. Returns the flow's
   * verdict; `ok: false` is a normal outcome (the message carries the reason), never a
   * defect. The caller must have confirmed with the user first. `requestId` makes a repeat
   * of the same submission return its earlier verdict instead of new orders.
   */
  readonly closePosition: (symbol: string, requestId?: string) => Effect.Effect<Trading.PositionCloseResult>
  /** The emergency version of `closePosition`: runs the same full cycle over every open
   * position, keeps going past individual failures, and names whatever still reads open in
   * the final verdict. `requestId` makes a repeat of the same submission return its earlier
   * verdict instead of racing it again. The view guards (AE-012) always apply on this
   * public path; Panic reaches the unguarded sweep through an internal helper. */
  readonly closeAllPositions: (requestId?: string) => Effect.Effect<Trading.PositionCloseResult>
  readonly taskList: () => Effect.Effect<Trading.Task[]>
  /** Schedules a systems task and persists it; it fires only while the service runs. */
  readonly taskAdd: (input: TaskAddInput) => Effect.Effect<Trading.Task, InvalidTaskError | SystemNotFoundError>
  /** Withdraws a pending task so it never fires. */
  readonly taskCancel: (id: Trading.TaskID) => Effect.Effect<Trading.Task, InvalidTaskError | TaskNotFoundError>
  /** Links the TWS socket up (the user's own click); the 5 s reconnect loop starts chasing until TWS accepts — the boot's first tick starts that chase on its own, opening nothing. Returns the current account (null until the balances arrive). */
  readonly connect: () => Effect.Effect<Trading.Account | null>
  /** Drops the TWS socket and stops the reconnect chase until the next `connect`. */
  readonly disconnect: () => Effect.Effect<Trading.Account | null>
  /**
   * Switches the dashboard's active account (the one `snapshot.account` shows). The input
   * must be an account one of the engine's links has discovered. The selection persists in
   * `trading_meta` and survives restarts while the account appears in any link again.
   */
  readonly accountSelect: (accountID: string) => Effect.Effect<Trading.Account | null, InvalidTaskError>
  /** Registers a watch: an extra IBKR TWS link chased as its own socket, or an MT5 watch
   * whose sidecar Python bridge reads the terminal's account (opening the terminal if it
   * is closed). Its rows feed the dashboard right away and it never places orders.
   * Persisted, so it comes back reading on the next boot. */
  readonly linkAdd: (input: LinkAddInput) => Effect.Effect<Trading.Link, InvalidTaskError>
  /** Withdraws a registered link: its socket drops (or its bridge is stopped) and its row
   * leaves the table. The panel's own primary link is never removable. Returns the
   * remaining links. */
  readonly linkRemove: (linkID: string) => Effect.Effect<Trading.Link[], InvalidTaskError>
  /** Searches this computer's MetaTrader 5 terminals for their accounts: the terminal
   * folders' own records (config and logs) read off disk alone — no side effects — and
   * `probe` additionally reads the live terminal's logged-in account with its name,
   * opening a closed terminal to do so. Read-only; it never registers a link. */
  readonly mt5Detect: (probe?: boolean) => Effect.Effect<Trading.Mt5Detected[], never>
  /** Knocks on IBKR API ports with a plain TCP connection: the four defaults on this
   * computer, or the one address given. No handshake, no client id — nothing connects or
   * registers. Read-only. */
  readonly ibkrDetect: (input: { host?: string; port?: number }) => Effect.Effect<Trading.IbkrPort[], InvalidTaskError>
  /**
   * Stops every running bot (same pid-guarded kill path as the user's stop) and then runs the
   * emergency close-all over the open positions. Nothing is re-armed afterwards; the systems'
   * flags stay off until reactivated. The caller must have confirmed with the user first.
   */
  readonly panic: () => Effect.Effect<Trading.PanicResult>
  /** Points the engine at another systems folder and reloads the pool from it. Refused while a
   * system runs or when the folder holds no systems; the pick is persisted and wins over the
   * env key and the built-in default (a passed Options build still wins over it). */
  readonly poolSelect: (dir: string) => Effect.Effect<Trading.PoolSelectResult, InvalidTaskError>
  /** The expiry loop; forked once from `process.ts`, like the Schedule loop. */
  readonly run: Effect.Effect<never>
}

/** When an engine stop was ordered; the record names the caller honestly. */
export type StopOrigin = "user" | "task" | "panic"

/** The record's verdict line for each stop origin. */
const STOP_ORIGIN_MESSAGE: Record<StopOrigin, string> = {
  user: "Bot stopped by the user",
  task: "Bot stopped by a scheduled task",
  panic: "Bot stopped by panic",
}

export interface LinkAddInput {
  /** The TWS host; omitted means the engine's own (the options') host. The engine trims
   * it and requires a loopback or private-network IP literal (AE-005): the link id builds on it. */
  readonly host?: string
  /** The TWS API port (the live port is 7496; its demo sibling is 7497). An MT5 link omits
   * it: its sidecar bridge dials no address of its own. */
  readonly port?: number
  /** IBKR registrations on the live port only: the explicit confirmation that this
   * registration may watch the live account — the interface's dialog passes it after the
   * user has confirmed, and a direct API call must pass it the same way. */
  readonly live?: boolean
  /** The user's own name for the link; shown beside the address. */
  readonly label?: string
  /** The platform the registration asks for; omitted means an IBKR TWS socket. */
  readonly broker?: Trading.Broker
  /** MT5 registrations only: the MetaTrader 5 login the terminal account carries. */
  readonly mt5Login?: number
  /** MT5 registrations only: the server the terminal logs into; given with `mt5Login`. */
  readonly mt5Server?: string
}

// Trading messages are authored in English as the fallback (AE-011 / D-10). Each engine
// pushLog entry and user-facing close/position verdict may also carry a `message_key`
// (`trading.log.*` / `trading.close.*` / `trading.panic.*`) plus `message_params` so the
// client can translate; entries without a key are shown verbatim. Bot-originated rows
// (latido.message) and technical identifiers (running/opening/closed/missing,
// InvalidTaskError) stay in English and are never translated.
export class Service extends Context.Service<Service, Interface>()("@opencode/TradingEngine") {}

export interface Options {
  readonly host?: string
  readonly port?: number
  /** The pool folder: one `NN_name` subfolder with `bot.py` per system. A passed build
   * wins over the env key `TRADING_SYSTEMS_DIR`; with neither, the engine starts with an
   * empty pool (a one-time migration may seed the historical default folder if it exists). */
  readonly systemsDir?: string
  /** Folder put on the bots' PYTHONPATH so ib_async and the Python 3.14 sitecustomize load.
   * The env key `TRADING_BOT_PYTHON_PATH` sits between a passed build and an empty value,
   * which forces PYTHONPATH to "". */
  readonly botPythonPath?: string
  /** The TWS API client id of the engine's trading connection. Two engines on one TWS need two
   * ids (a second one under the same id is dropped by TWS): a passed build wins over the env key
   * `TRADING_CLIENT_ID`, which wins over the id persisted per installation in `trading_meta`
   * (`client_id`, generated once in the 1000-9999 range), which wins over the extreme fallback
   * `CLIENT_ID` (30). */
  readonly clientId?: number
}

/** Migration-only: the install's historical default pool folder. Used once at boot to seed a

/** Options flow to the engine at composition; these env keys sit between a passed build and
 * the persisted pick (or the one-time migration). An absent or blank key leaves the value
 * to the chain. No machine-specific default remains. */
const opcionEntorno = (clave: string): string | undefined => {
  const valor = process.env[clave]?.trim()
  return valor === "" ? undefined : valor
}

/** Display metadata per known pool folder; a folder without an entry still works and reads as unknown. */
const META: Record<string, { symbol: string; timeframe: string }> = {
  "01_nasdaq_apertura_alcista": { symbol: "NQ", timeframe: "5m" },
  "02_nasdaq_ruptura_media_hora": { symbol: "NQ", timeframe: "30m" },
  "03_nasdaq_impulso_con_tendencia": { symbol: "NQ", timeframe: "15m" },
  "04_oro_rebote_del_viernes": { symbol: "GC", timeframe: "30m" },
  "05_oro_fuerza_de_madrugada": { symbol: "GC", timeframe: "15m" },
  "06_nasdaq_pullback": { symbol: "NQ", timeframe: "1h" },
  "07_oro_nube_ichimoku": { symbol: "GC", timeframe: "1h" },
  "08_russell_estocastico_h2": { symbol: "RTY", timeframe: "2h" },
  "09_russell_cci_tendencia": { symbol: "RTY", timeframe: "1h" },
  "10_russell_estocastico_h4": { symbol: "RTY", timeframe: "4h" },
  "11_usdjpy_ruptura_bollinger": { symbol: "USDJPY", timeframe: "1h" },
  "12_usdjpy_ruptura_keltner": { symbol: "USDJPY", timeframe: "1h" },
  "13_usdjpy_ruptura_donchian": { symbol: "USDJPY", timeframe: "1h" },
  "14_usdjpy_cruce_ema_10_40": { symbol: "USDJPY", timeframe: "1h" },
  "15_usdjpy_precio_ema30_h3": { symbol: "USDJPY", timeframe: "3h" },
}

/** One pool system: a folder with its bot.py, the dossier facts its own files state, and the
 * display metadata the folder's name maps to. */
interface Definicion {
  readonly id: string
  readonly name: string
  readonly dir: string | null
  readonly clientId: number | null
  /** The "HOST:PUERTO" the bot's config.py points at; null when either line is missing.
   * A config that points elsewhere runs outside the engine's own watch. */
  readonly servidor: string | null
  /** The config's HORA_CIERRE as "HH:MM:SS" (New York's close); null when the line is absent. */
  readonly horaCierre: string | null
  /** The system's one-paragraph idea from its own reglas.json. */
  readonly descripcion: string | null
  /** The system's rules, key→text in file order; null when reglas.json is absent. */
  readonly reglas: Readonly<Record<string, string>> | null
  readonly meta: { symbol: string; timeframe: string } | null
}

interface Runtime {
  /** Where the live pid came from, for honest reports: the folder's panel.pid or a TWS probe hit. */
  source: "panel" | "external" | null
  pid: number | null
  startedAt: number | null
  /** The child handle for an engine-launched bot; null for adopted-external bots. */
  child: ChildProcess | null
  /** A stop (or task kill) already accounted for; its exit must not report a fallen bot. */
  planeado: boolean
  /** The sweep's last check could not answer for the adopted pid: the seat stays and the
   * warning is logged once, until a checked answer clears it. */
  sondeoDudado: boolean
  registroOffset: number
  consolaOffset: number
  /** Epoch ms of the bot's newest own row today; null when it has not logged today. */
  ultimaActividad: number | null
}

/** The pool's folder names: directories `NN_name` (bot.py checked later, per definition). */
const escanearCarpetas = async (dir: string): Promise<string[]> => {
  try {
    const entradas = await readdir(dir, { withFileTypes: true })
    return entradas.filter((entry) => entry.isDirectory() && /^\d\d_/.test(entry.name)).map((entry) => entry.name).sort()
  } catch {
    return []
  }
}

/** Systems currently between launch and runtime publication; a second activation for the
 * same system aborts instead of racing the first one into a twin bot process. */
const arranquesEnVuelo = new Set<string>()

/** Reads the bot's config.py and reglas.json into the system's dossier facts: its CLIENT_ID
 * (the TWS probe matches on it), the HOST:PUERTO the config points at, the close hour, and
 * the written idea/rules. Unreadable or malformed files null their own facts only — the bot
 * itself boots fine without them, and only the engine's dossier and probe miss out. */
const definicion = async (name: string, dir: string): Promise<Definicion> => {
  const folder = `${dir}\\${name}`
  const config = await readFile(`${folder}\\config.py`, "utf8").catch(() => "")
  const clientId = Number(/^CLIENT_ID\s*=\s*(\d+)/m.exec(config)?.[1]) || null
  const servidorHost = /^HOST\s*=\s*"([^"]+)"/m.exec(config)?.[1]
  const servidorPuerto = Number(/^PUERTO\s*=\s*(\d+)/m.exec(config)?.[1]) || null
  const tupla = /^\s*HORA_CIERRE\s*=\s*\((\d+),\s*(\d+)(?:,\s*(\d+))?\)/m.exec(config)
  const horaCierre =
    tupla === null
      ? null
      : `${tupla[1].padStart(2, "0")}:${tupla[2].padStart(2, "0")}${tupla[3] === undefined ? "" : `:${tupla[3].padStart(2, "0")}`}`
  const escrito = (await readFile(`${folder}\\reglas.json`, "utf8")
    .then((texto) => JSON.parse(texto) as { idea?: unknown; reglas?: unknown })
    .catch(() => null)) ?? null
  const descripcion = typeof escrito?.idea === "string" ? escrito.idea : null
  const reglas =
    escrito === null || typeof escrito.reglas !== "object" || escrito.reglas === null
      ? null
      : Object.fromEntries(Object.entries(escrito.reglas).filter((entrada) => typeof entrada[1] === "string"))
  return {
    id: name.slice(0, 2),
    name,
    dir: folder,
    clientId,
    servidor: servidorHost !== undefined && servidorPuerto !== null ? `${servidorHost}:${servidorPuerto}` : null,
    horaCierre,
    descripcion,
    reglas,
    meta: META[name] ?? null,
  }
}

/** One child process run with a hard timeout; stdout is the only output read. Failure to
 * start resolves with whatever arrived — the callers only match substrings anyway, and
 * nothing on the stop path is allowed to block the server's own loop (no spawnSync). */
const ejecutalo = async (ruta: string, argumentos: readonly string[], timeout: number): Promise<string> =>
  new Promise<string>((resolve) => {
    const proceso = spawn(ruta, [...argumentos], { windowsHide: true })
    let salida = ""
    proceso.stdout?.on("data", (trozo: Buffer) => {
      salida += trozo.toString()
    })
    const reloj = setTimeout(() => proceso.kill(), timeout)
    proceso.on("exit", () => {
      clearTimeout(reloj)
      resolve(salida)
    })
    proceso.on("error", () => {
      clearTimeout(reloj)
      resolve(salida)
    })
  })

/** The real Python on this computer, windowless first. `where` lists every match on PATH; the
 * Microsoft Store's WindowsApps alias is a stub that opens the Store instead of running a
 * script, so it never counts. Null when no real interpreter is installed. */
const localizarPython = async (): Promise<string | null> => {
  if (process.platform !== "win32") return null
  for (const nombre of ["pythonw", "python", "py"]) {
    const ruta = (await ejecutalo("where", [nombre], 5_000))
      .split(/\r?\n/)
      .map((linea) => linea.trim())
      .find((linea) => linea !== "" && !/\\WindowsApps\\/i.test(linea))
    if (ruta !== undefined) return ruta
  }
  return null
}

/** Whether a pid still belongs to a live process — three-way like `pidEsBot`: `true`/`false`
 * only when tasklist answered (a checked no is its "no tasks match" line), `null` when the
 * check itself could not answer (blocked, killed by the timeout). Callers that may kill
 * always add the bot.py command-line check. */
const pidVivo = async (pid: number): Promise<boolean | null> => {
  const salida = await ejecutalo("tasklist", ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"], 5_000)
  // No rows at all (not even the no-match line): nothing was checked.
  if (salida.trim() === "") return null
  return salida.includes(`"${pid}"`)
}

/** Folds a Windows path into a lowercase backslash form so two spellings of one folder
 * prefix-compare; a non-plain spelling with `..\\` simply fails the prefix (fail-closed). */
const rutaPlana = (ruta: string): string => ruta.toLowerCase().replace(/\//g, "\\").replace(/\\{2,}/g, "\\")

/** The pid-kill safeguard: only a bot.py the pool owns is ever terminated. Three gates in
 * order: the command line must run a bot.py; the system's panel.pid must still claim the
 * pid; and without that marker the script path on the line must sit inside the system's
 * folder — the engine names its spawns by absolute path, so a relative or out-of-folder
 * bot.py is not ours to kill (Windows reuses pids, and a shared-name bot.py of some other
 * project must not die). The answer is three-way: `null` when the check itself could not
 * answer — an empty line arrives when PowerShell is blocked by policy, restarting or
 * timed out, and also when the process died in flight (the caller's own tasklist answer
 * separates that case on the next sweep) — so callers keep the process and its seat and
 * wait for a checked answer: retiring a seat on an unchecked answer would strand a live
 * bot outside the panel's and the panic's reach. */
const pidEsBot = async (pid: number, dir: string | null): Promise<boolean | null> => {
  const salida = await ejecutalo(
    "powershell",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object -ExpandProperty CommandLine)`,
    ],
    8_000,
  )
  // No command line came back: nothing was checked (a checked answer names the program).
  if (salida.trim() === "") return null
  if (!salida.toLowerCase().includes("bot.py")) return false
  if (dir !== null) {
    const marcado = (await readFile(`${dir}\\panel.pid`, "utf8").catch(() => "")).trim()
    if (marcado === String(pid)) return true
    if (marcado !== "") return false
    const citada = /"([^"]*bot\.py)"/i.exec(salida)?.[1]
    const ruta = citada ?? /([^\s"]*bot\.py)/i.exec(salida)?.[1]
    if (ruta === undefined) return false
    return rutaPlana(ruta).startsWith(`${rutaPlana(dir)}\\`)
  }
  return salida.toLowerCase().includes("pythonw")
}

/** The IBKR API defaults the port search knocks on: TWS paper and live first, then IB
 * Gateway paper (4002) and live (4001) — a desk running Gateway instead of TWS must be found too. */
const PUERTOS_IBKR = [
  { port: 7497, live: false },
  { port: 7496, live: true },
  { port: 4002, live: false },
  { port: 4001, live: true },
] as const

/** The live (real-money) API ports: TWS live and IB Gateway live. A watch on either needs
 * the explicit live confirmation. */
const PUERTOS_REALES: ReadonlySet<number> = new Set(PUERTOS_IBKR.filter((puerto) => puerto.live).map((puerto) => puerto.port))

/** What a TWS port says about the money behind it, for the record: only TWS's two default
 * ports name it (7496/4001 live, 7497/4002 paper); any other port says nothing it cannot know. */
const entornoPuerto = (port: number) => {
  const fila = PUERTOS_IBKR.find((defecto) => defecto.port === port)
  if (fila === undefined) return ""
  return fila.live ? " · live" : " · paper"
}

export const MENSAJE_HOST_TWS =
  "A TWS host must be a loopback or private-network IP literal (127.0.0.0/8, ::1, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, fc00::/7)."

/** Expands an IPv6 literal into its 8 hextets, expanding `::`. Returns null for a zone id,
 * a non-IPv6 string, or a shape that is not a valid IPv6 literal. */
const expandirIpv6 = (host: string): number[] | null => {
  if (host === "") return null
  if (host.includes("%")) return null
  // An IPv4-embedded tail ("::ffff:127.0.0.1", "::192.168.1.1") expands into the last two
  // hextets; its octets must be canonical decimal (no leading zeros, in range).
  let texto = host
  const ipv4 = /^((?:.*):)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(texto)
  if (ipv4 !== null) {
    const octetos = ipv4[2].split(".")
    if (octetos.some((octeto) => !/^(0|[1-9][0-9]?|1[0-9][0-9]|2[0-4][0-9]|25[0-5])$/.test(octeto))) return null
    const nums = octetos.map((octeto) => Number(octeto))
    const h1 = ((nums[0] << 8) | nums[1]).toString(16)
    const h2 = ((nums[2] << 8) | nums[3]).toString(16)
    texto = `${ipv4[1]}${h1}:${h2}`
  }
  const partes = texto.split("::")
  if (partes.length > 2) return null
  const cabeza = partes[0] === "" ? [] : partes[0].split(":")
  const cola = partes.length === 2 && partes[1] !== "" ? partes[1].split(":") : []
  if (cabeza.some((hexteto) => hexteto === "" || !/^[0-9a-fA-F]{1,4}$/.test(hexteto))) return null
  if (cola.some((hexteto) => hexteto === "" || !/^[0-9a-fA-F]{1,4}$/.test(hexteto))) return null
  if (cabeza.some((hexteto) => hexteto.includes(".")) || cola.some((hexteto) => hexteto.includes("."))) return null
  const total = cabeza.length + cola.length
  if (partes.length === 1) {
    if (total !== 8) return null
    return [...cabeza, ...cola].map((hexteto) => Number.parseInt(hexteto, 16))
  }
  if (total > 8) return null
  const relleno = 8 - total
  const hextetos = [
    ...cabeza.map((hexteto) => Number.parseInt(hexteto, 16)),
    ...Array.from({ length: relleno }, () => 0),
    ...cola.map((hexteto) => Number.parseInt(hexteto, 16)),
  ]
  return hextetos.length === 8 ? hextetos : null
}

const esIpv4Permitida = (ip: string): boolean => {
  const texto = ip.trim()
  const octetos = texto.split(".")
  if (octetos.length !== 4) return false
  const numeros: number[] = []
  for (const octeto of octetos) {
    if (!/^(0|[1-9][0-9]?|1[0-9][0-9]|2[0-4][0-9]|25[0-5])$/.test(octeto)) return false
    numeros.push(Number(octeto))
  }
  const [a, b] = numeros
  if (a === 127) return true
  if (a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  return false
}

const esIpv6Permitida = (ip: string): boolean => {
  const texto = ip.trim()
  const mapeada = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(texto)
  if (mapeada !== null) return esIpv4Permitida(mapeada[1])
  const hextetos = expandirIpv6(texto)
  if (hextetos === null) return false
  const esLoopback = hextetos.slice(0, 7).every((h) => h === 0) && hextetos[7] === 1
  if (esLoopback) return true
  if ((hextetos[0] & 0xfe00) === 0xfc00) return true
  return false
}

export const hostTwsPermitido = (host: string): boolean => {
  const texto = host.trim()
  if (texto === "" || texto.length > 80) return false
  const tipo = isIP(texto)
  if (tipo === 4) return esIpv4Permitida(texto)
  if (tipo === 6) return esIpv6Permitida(texto)
  return false
}

/** One TCP knock: true when the address accepts the connection within the short deadline.
 * The socket closes at once — no API handshake ever starts. */
const puertoAbierto = (host: string, port: number) => {
  if (!hostTwsPermitido(host)) return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ host, port })
    const fin = (abierto: boolean) => {
      socket.destroy()
      resolve(abierto)
    }
    socket.setTimeout(1_500, () => fin(false))
    socket.once("connect", () => fin(true))
    socket.once("error", () => fin(false))
  })
}
/** The one shape of an IBApiNext stream the engine relies on: an rxjs Observable's
 * subscribe with its value and error callbacks (core does not import rxjs itself; this is
 * the overload TypeScript infers the value type from). */
interface Escuchable<T> {
  subscribe(next: (value: T) => void, error: (error: unknown) => void): unknown
}

/** A stream fault in the record's words: TWS's own code and text when it sent one. */
const textoErrorIb = (error: unknown) => (error instanceof IBApiNextError ? `${error.code}: ${error.error.message}` : String(error))

/** TWS's codes for an order it refused or dropped (validation, permissions, margin, routing,
 * duplicate ids, cancels by the system). Warnings that ride an accepted order — 399, 2109,
 * 10349 — are deliberately left out: those orders still work and may fill. */
const RECHAZOS_ORDEN: ReadonlySet<number> = new Set([
  103, 104, 105, 106, 107, 109, 110, 111, 113, 116, 117, 118, 119, 120, 121, 122, 123, 124, 125, 126, 129, 131, 132, 133,
  134, 135, 136, 137, 140, 141, 144, 146, 147, 148, 151, 152, 153, 154, 155, 156, 158, 159, 160, 163, 164, 166, 167, 168,
  169, 200, 201, 202, 203, 312, 313, 314, 315, 320, 321, 322, 323, 324, 325, 327, 328, 329, 383, 387, 388,
])

/** A contract-details answer names a future's last trade with its hour and zone
 * ("20261218 08:30:00 US/Central"), a shape TWS itself refuses on an order (error 321, "the
 * date entered is invalid"). Orders carry the bare date it sends beside it. */
const contratoParaOrden = (contrato: Contract): Contract => {
  const fecha = contrato.lastTradeDate ?? contrato.lastTradeDateOrContractMonth?.split(" ")[0]
  return fecha === undefined ? contrato : { ...contrato, lastTradeDateOrContractMonth: fecha }
}

/** Whether a TWS client id is already in use (the engine's boot probe; 326 means a bot runs with it). */
const clientIdEnUso = async (host: string, port: number, clientId: number): Promise<boolean> =>
  new Promise<boolean>((resolve) => {
    let hecho = false
    const listo = (vivo: boolean) => {
      if (hecho) return
      hecho = true
      clearTimeout(timer)
      ib.disconnect()
      resolve(vivo)
    }
    // TWS says 326 through the library's logger only (see conexionIb): watching errorSubject
    // alone never saw it, so every probe timed out as "free".
    const ib = conexionIb({ host, port }, () => listo(true))
    const timer = setTimeout(() => listo(false), 2_500)
    ib.errorSubject.subscribe((error) => {
      if (Number(error.code) === 326 || /already in use/i.test(String(error.error))) listo(true)
    })
    ib.connect(clientId)
  })

/** The tracked instrument families, fixed snapshot order; a family stays present with null
 * fields until the first fact naming it arrives (no position and no notice = no news). */
const familiasRastreo = ["MNQ", "M2K", "MGC", "USDJPY"] as const
type Familia = (typeof familiasRastreo)[number]

/** Which tracked family a local symbol or an IBKR notice text belongs to. Word-boundary
 * match so "MNQZ6" attributes to MNQ without swallowing lookalikes inside longer words. */
const familiaDe = (texto: string): Familia | null => {
  if (/\bMNQ|\bNQ/.test(texto)) return "MNQ"
  if (/\bM2K|\bRTY/.test(texto)) return "M2K"
  if (/\bMGC|\bGC/.test(texto)) return "MGC"
  if (/\bUSDJPY|\bJPY/.test(texto)) return "USDJPY"
  return null
}

/** The tick sizes captured from re-resolved contract details (per conId), on top of the
 * pool's known family ticks — the fallback when a position contract arrives lean and no
 * detail lookup has named its grid (MNQ 0.25, M2K/MGC 0.1; USDJPY trades on a far finer
 * grid — never a cent-quantized one). */
const TICKS_DEFECTO: Record<Familia, number> = { MNQ: 0.25, M2K: 0.1, MGC: 0.1, USDJPY: 0.001 }
const ticksPorConId = new Map<number, number>()

/** The tick a close's emergency limits must respect: a captured detail's minTick when one
 * was fetched for this contract, else the family's known tick, else the micro default. */
const tickDeContrato = (conId: number, symbol: string): number => {
  const propio = ticksPorConId.get(conId)
  if (propio !== undefined && Number.isFinite(propio) && propio > 0) return propio
  const familia = familiaDe(symbol)
  return familia === null ? TICKS_DEFECTO.MNQ : TICKS_DEFECTO[familia]
}

/** Snaps a price exactly onto a tick grid (a limit price off the grid is rejected). */
const enRejilla = (precio: number, tick: number): number => Number((Math.round(precio / tick) * tick).toFixed(9))

/** Renders a price with exactly the decimals its tick grid needs (0.25 → "150.25"). */
const textoPrecio = (precio: number, tick: number): string => {
  const texto = String(tick)
  const decimales = texto.includes("e") || texto.includes("E") ? 9 : (texto.split(".")[1]?.length ?? 0)
  return precio.toFixed(Math.min(decimales, 6))
}

/** The close cycle's guards: one in-flight close per contract id (a second request aborts
 * instead of racing the first into a double order), and the last verdicts by the endpoint's
 * requestId — a repeated submission inside a minute reads its own verdict again. */
const cierresEnVuelo = new Set<number>()
const cierresRecientes = new Map<string, { ts: number; salida: Trading.PositionCloseResult }>()

/** How long an open claim refuses repeats of the contract: a live close (a market cycle
 * resolves inside a minute) never gets raced, and a claim older than the window reads as
 * a session that died mid-close — the next close takes it over. */
const VIGENCIA_RECLAMO_MS = 5 * 60_000
/** Recorded verdicts age out of the claim table after a day (open claims never delete). */
const VIGENCIA_VEREDICTO_MS = 24 * 60 * 60_000
/** Anonymous close submissions (the panic path) carry no caller id: the row id stamps
 * uniqueness per run instead — wall clock, pid and a module counter, so two closes minted
 * in the same millisecond never share one. */
let contadorSello = 0
const selloAnonimo = () => `${Date.now()}-${process.pid}-${contadorSello++}`

/** A close claim's outcome: a verdict to return untouched ("repetida", a recorded one;
 * "vestigio", the submission's own refusal; "ajena", another claim holding the contract),
 * the granted claim ("nueva"), or the degraded no-row path ("fallida" — the database was
 * unreachable, so the close is refused rather than running unguarded). */
type ReclamoCierre =
  | { kind: "repetida"; salida: Trading.PositionCloseResult }
  | { kind: "vestigio"; salida: Trading.PositionCloseResult }
  | { kind: "ajena"; salida: Trading.PositionCloseResult }
  | { kind: "nueva" }
  | { kind: "fallida" }

/** The pool as the engine sees it: every known system, folder and its live runtime (empty when never started). */
let sistemas: Definicion[] = []
const bots = new Map<string, Runtime>()
/** Each bot's last portfolio PnL from its own registro.log; the bots log it only while running. */
const pnlBots = new Map<string, number>()

/** IBKR's refusal of a currency trade the account may not leverage (error 201). */
const RECHAZO_DIVISAS = /expose account to currency leverage/i
const EXPLICACION_DIVISAS =
  "IBKR rejects currency trades (USDJPY) on this account: currency leverage is not allowed. Enable it in IBKR's Client Portal (Settings › Trading Permissions › Forex); paper accounts copy the live account's permissions the next day"

/** The contracts each pool family trades: its full-size root and the micro the bots order. */
const CONTRATOS_FAMILIA: Record<string, readonly string[]> = {
  NQ: ["NQ", "MNQ"],
  GC: ["GC", "MGC"],
  RTY: ["RTY", "M2K"],
  USDJPY: ["USDJPY"],
}

/** Whether a bot's `updatePortfolio:` row is about its own system's contract. */
const esDelSistema = (systemID: string, fila: string) => {
  const familia = sistemas.find((def) => def.id === systemID)?.meta?.symbol
  if (familia === undefined) return false
  const contrato = `${/symbol='([^']*)'/.exec(fila)?.[1] ?? ""}${/currency='([^']*)'/.exec(fila)?.[1] ?? ""}`
  return (CONTRATOS_FAMILIA[familia] ?? [familia]).some((raiz) => contrato === raiz || contrato === `${raiz}USD`)
}

const toSchemaSystem = (system: Definicion): Trading.System => {
  const runtime = bots.get(system.id)
  const enMarcha = runtime !== undefined && runtime.startedAt !== null
  return {
    id: system.id,
    name: system.name,
    running: enMarcha,
    active: enMarcha,
    pid: enMarcha ? runtime.pid : null,
    started_at: enMarcha ? runtime.startedAt : null,
    symbol: system.meta?.symbol ?? "?",
    timeframe: system.meta?.timeframe ?? "?",
    pnl_day: pnlBots.get(system.id) ?? null,
    client_id: system.clientId,
    close_hour: system.horaCierre,
    last_activity_at: runtime === undefined ? null : runtime.ultimaActividad,
    description: system.descripcion,
    rules: system.reglas === null ? null : { ...system.reglas },
  }
}

/** Engine version reported in snapshots. */
const VERSION = "nativo-1"

/** Migration-only extreme fallback IBKR client id. Used only when no build, env, persisted or
 * generated id is available; new installs generate their own id in the 1000-9999 range and store
 * it in `trading_meta` (`client_id`), so two Openbot installs on one TWS no longer share 30. */
const CLIENT_ID = 30

/** How long a fresh TWS socket must hold before it counts as linked: TWS refuses a taken
 * client id (326) about half a second after accepting the socket. */
const CONEXION_FIRME_MS = 1_500

/** IBKR TWS API port. 7497 is TWS's default demo port (7496 would be live). */
const ACCOUNT_SUMMARY_TAGS =
  "NetLiquidation,TotalCashBalance,CashBalance,UnrealizedPnL,RealizedPnL,AccountType,Currency,AvailableFunds,BuyingPower,ExcessLiquidity,MaintMarginReq"

const parseValue = (value: string | undefined) => {
  if (value === undefined || value.trim() === "") return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** The engine never invents numbers: whatever IB sends broken (NaN, Infinity) is null, the
 * same bridge the dashboard's render already draws as "—" downstream. */
const safeNumber = (value: number | undefined | null) =>
  value !== undefined && value !== null && Number.isFinite(value) ? value : null

const firstTagValue = (tagValues: AccountSummaryValues | undefined) => {
  if (!tagValues) return undefined
  return (tagValues.get("USD") ?? [...tagValues.values()][0])?.value
}

/** A trade's deterministic identity: system, ts and the message's short hash, so replaying
 * a log tail re-inserts nothing (same identity, conflict no-op) and two different closes
 * in the same millisecond never collide on the primary key. */
const tradeIdentidad = (trade: { system: string; ts: number; message: string }): string =>
  `${trade.system}:${trade.ts}:${createHash("sha1").update(trade.message).digest("hex").slice(0, 12)}`

/** The engine's configurable build: the composition root's factory for pools, ports or
 * python paths outside the defaults. `engineLayer` and `node` stay the default build. */
export const layer = (options: Options = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      // The primary (trading) socket's address: a passed build, then the env keys
      // TRADING_TWS_HOST / TRADING_TWS_PORT (a desk on TWS live 7496 or IB Gateway 4001/4002
      // had no way to point its trading connection anywhere but 7497), then TWS paper.
      const hostEntorno = opcionEntorno("TRADING_TWS_HOST")
      const puertoEntorno = Number(opcionEntorno("TRADING_TWS_PORT"))
      const host = options.host ?? (hostEntorno !== undefined && hostTwsPermitido(hostEntorno) ? hostEntorno : "127.0.0.1")
      const port =
        options.port ?? (Number.isSafeInteger(puertoEntorno) && puertoEntorno >= 1 && puertoEntorno <= 65_535 ? puertoEntorno : 7497)
      // The pool folder. A passed build wins; then the folder the user picked (persisted, read
      // at boot below), the env key, or empty. A pick can move it at runtime.
      const carpetaPool = { value: options.systemsDir ?? opcionEntorno("TRADING_SYSTEMS_DIR") }
      const botPythonPath = options.botPythonPath ?? opcionEntorno("TRADING_BOT_PYTHON_PATH")
      /** Resolves the engine's TWS client id per installation: build → env → persisted →
       *  generated (1000-9999, persisted) → extreme fallback (CLIENT_ID). */
      const resolverClienteMotor = (opciones: Options) =>
        Effect.gen(function* () {
          if (opciones.clientId !== undefined) return opciones.clientId
          const env = opcionEntorno("TRADING_CLIENT_ID")
          if (env !== undefined) {
            const analizado = Number(env)
            if (Number.isInteger(analizado) && analizado >= 1000 && analizado <= 9999) return analizado
            yield* Effect.logWarning(`TRADING_CLIENT_ID="${env}" is not a valid client id (integer 1000-9999); ignoring it.`)
          }
          const filas = yield* db.select().from(TradingMetaTable).where(eq(TradingMetaTable.id, "client_id")).all().pipe(Effect.orDie)
          const fila = filas[0]
          if (fila !== undefined) {
            const analizado = Number(fila.value)
            if (Number.isInteger(analizado) && analizado >= 1000 && analizado <= 9999) return analizado
            yield* Effect.logWarning(`Persisted client id "${fila.value}" is not valid (integer 1000-9999); regenerating.`)
          }
          const generado = 1000 + Math.floor(Math.random() * 9000)
          const stamp = Date.now()
          yield* db
            .insert(TradingMetaTable)
            .values({ id: "client_id", value: String(generado), time_created: stamp, time_updated: stamp })
            .onConflictDoUpdate({ target: TradingMetaTable.id, set: { value: String(generado), time_updated: stamp } })
            .run()
            .pipe(Effect.orDie)
          return generado
        }).pipe(Effect.catchCause(() => Effect.succeed(CLIENT_ID)))
      const clienteMotor = yield* resolverClienteMotor(options)
      /** Resolved once at boot ("where pythonw"); a PATH miss degrades to the bare command. */
      let pythonwEjecutable = "pythonw"

      type TaskRow = typeof TradingTaskTable.$inferSelect

      const toSchemaTask = (row: TaskRow): Trading.Task => ({
        id: row.id,
        kind: row.kind,
        system_ids: [...row.system_ids],
        run_at: row.run_at,
        status: row.status,
        resolved_at: row.resolved_at,
        time_created: row.time_created,
        time_updated: row.time_updated,
      })

      // Per-link account states. The PRIMARY socket (the options' host/port) is itself a
      // link — the map's first entry always — and every registered link adds its own: each
      // link's account-summary and ledger streams discover that login's accounts into the
      // link's own map. Positions, contracts and the equity curve stay the primary link's
      // own readings (the trading flow trades through it); a link only watches balances.
      interface EstadoCuenta {
        tipo: string | null
        efectivo: number | null
        equity: number | null
        fondos: number | null
        compraPoder: number | null
        margen: number | null
        liquidez: number | null
        pnlDia: number | null
        pnlRealizado: number | null
        actualizada: number | null
        readonly linkID: string
      }

      /** One watch member of IbKR's era: a TWS address whose socket this link keeps
       * chasing (its own 5 s retry until TWS accepts). */
      interface EnlaceIBKR {
        readonly id: string
        readonly host: string
        readonly port: number
        /** The user's own name; null on the primary (unnamed) link. */
        readonly etiqueta: string | null
        /** The fixed TWS client id this link always connects with; passing it to every
         * connect call keeps the auto-reconnect's fixedClientId from drifting. */
        readonly cliente: number
        readonly broker: "ibkr"
        readonly ib: IBApiNext
        /** The socket's newest connection state. */
        conectado: boolean
        /** Whether this link was loaded as blocked (AE-005: host not allowed). A blocked link
         * is never connected and its socket is never touched. Runtime only, not serialized. */
        readonly bloqueado: boolean
        /** When TWS last refused the link's client id as taken (326); null once a connection
         * holds. While set, the socket's connect-then-drop cycle is that refusal, not a loss. */
        ocupado: number | null
        readonly cuentas: Map<string, EstadoCuenta>
      }

      /** One MT5 watch: no TWS address at all — its identity is the MetaTrader 5 login and
       * server the choose-the-terminal wizard named, and its facts arrive over the sidecar
       * Python bridge (spawned, read and restarted by `arrancarPuenteMT5` below). */
      interface EnlaceMT5 {
        readonly id: string
        readonly login: number
        readonly server: string
        readonly etiqueta: string | null
        readonly broker: "mt5"
        conectado: boolean
        readonly cuentas: Map<string, EstadoCuenta>
        /** The sidecar's python handle while it lives; null between restart attempts. */
        child: ChildProcess | null
        /** The newest reason the bridge read no account; the record's log throttles on it. */
        motivo: string | null
        /** The terminal's open positions as of the last read; empty while the bridge reads nothing. */
        posiciones: Trading.Position[]
        /** Today's closing deals as of the last read, newest first. */
        cierres: Trading.Trade[]
      }

      type Enlace = EnlaceIBKR | EnlaceMT5

      /** The primary link's map key; registered links key as their own identity too. */
      const clavePrimario = `${host}:${port}`

      /** Links beyond the primary pick engine-owned client ids in their own range, far from
       * the bots' configured CLIENT_IDs, so a re-registered link never collides with a bot. */
      let siguienteClienteEnlace = 71

      const enlaces = new Map<string, Enlace>()

      /** Set by the user's Desconectar until the socket reports the drop it asked for. */
      const desconexion = { pedida: false }

      /** The remembered accounts' mirror: the table's rows as last read or written
       * (account id → its link and the last-known kind), so the tick's reconcile only
       * touches the rows that changed and the boot seed knows what it seeded. */
      const recordadas = new Map<string, { linkID: string; tipo: string | null }>()


      const enlaceNueva = (id: string, hostEnlace: string, portEnlace: number, etiqueta: string | null, cliente: number, bloqueado: boolean = false): EnlaceIBKR => {
        const enlace: EnlaceIBKR = {
          id,
          host: hostEnlace,
          port: portEnlace,
          etiqueta,
          broker: "ibkr",
          ib: conexionIb({ host: hostEnlace, port: portEnlace, reconnectInterval: 5_000, connectionWatchdogInterval: 15 }, () =>
            clienteOcupado(enlace),
          ),
          cliente,
          conectado: false,
          bloqueado,
          ocupado: null,
          cuentas: new Map(),
        }
        return enlace
      }

      /** TWS refused the link's client id: another API program (a second Openbot on this TWS,
       * say) holds it, and the auto-reconnect would just repeat the refusal. Said once a minute
       * (pushLog's echo window) with the way out, instead of a silent connect-and-drop loop. */
      const clienteOcupado = (enlace: EnlaceIBKR) => {
        enlace.ocupado = Date.now()
        pushLog(
          "warning",
          "motor",
          enlace.id === clavePrimario
            ? `TWS rejects the connection: client id ${enlace.cliente} is already in use by another API program (another copy of Openbot against this TWS?) · close that program or start this app with TRADING_CLIENT_ID=<another number>`
            : `TWS rejects link ${enlace.id}: its client id ${enlace.cliente} is already in use by another API program`,
          { message_key: "trading.log.ibkr.client_id_in_use", message_params: { client: enlace.cliente, link: enlace.id } },
        )
      }

      const enlaceMt5Nueva = (id: string, login: number, server: string, etiqueta: string | null): EnlaceMT5 => ({
        id,
        login,
        server,
        etiqueta,
        broker: "mt5",
        conectado: false,
        cuentas: new Map(),
        child: null,
        motivo: null,
        posiciones: [],
        cierres: [],
      })

      const enlacePrimario = () => enlaces.get(clavePrimario)

      /** A link's first discovered account: Map order keeps it stable (the summary stream
       * inserts once), which makes it the panel's default account and the orders' addressee. */
      const primeraId = (enlace: Enlace | undefined) => {
        const primera = enlace?.cuentas.keys().next()
        return primera === undefined || primera.done ? null : primera.value
      }
      const idPrimario = () => primeraId(enlacePrimario())

      /** The dashboard's active account: the remembered selection while it still exists in
       * any link, else the primary link's own first account. The swap a ghost selection
       * produces is logged once — the header must not change accounts unexplained. */
      let cuentaActiva: string | null = null
      let cuentaActivaAviso: string | null = null
      const cuentaActivaEstado = (): { enlace: Enlace; id: string; estado: EstadoCuenta } | null => {
        if (cuentaActiva !== null) {
          for (const enlace of enlaces.values()) {
            const estado = enlace.cuentas.get(cuentaActiva)
            if (estado !== undefined) {
              cuentaActivaAviso = null
              return { enlace, id: cuentaActiva, estado }
            }
          }
          if (cuentaActivaAviso !== cuentaActiva) {
            cuentaActivaAviso = cuentaActiva
            pushLog(
              "warning",
              "motor",
              `Active account ${cuentaActiva} is absent · showing the primary link's first account instead; the selection returns if the account reappears or another is chosen`,
              { message_key: "trading.log.account.active_absent", message_params: { account: cuentaActiva } },
            )
          }
        }
        const id = idPrimario()
        if (id === null) return null
        return { enlace: enlaces.get(clavePrimario)!, id, estado: enlacePrimario()!.cuentas.get(id)! }
      }

      /** The account the engine addresses — orders and the equity curve
       * all aim here: the dashboard's active account while that selection belongs to the primary
       * link (its socket feeds the positions and this engine's orders); any other selection
       * falls back to the primary link's own first account. */
      const cuentaDeMotor = (): string | null =>
        cuentaActiva !== null && enlacePrimaria.cuentas.has(cuentaActiva) ? cuentaActiva : idPrimario()

      /** The selection's revalidation: "absent everywhere" is normally the between-sessions
       * case the remembered rows keep (a TWS reconnect or a chasing bridge may still feed
       * the id), so nothing is dropped until the link that owns the selection is connected
       * and has discovered accounts this session — and still none of them is the remembered
       * one. Then the selection names a ghost: memory drops it and `trading_meta` forgets
       * the row, so a restart cannot revive a selection no account could ever satisfy. */
      const revalidarCuentaActiva = Effect.fn("TradingEngine.revalidarCuentaActiva")(function* () {
        const activa = cuentaActiva
        if (activa === null) return
        for (const enlace of enlaces.values()) {
          if (enlace.cuentas.has(activa)) return
        }
        const recordada = recordadas.get(activa)
        if (recordada !== undefined) {
          const propia = enlaces.get(recordada.linkID)
          if (propia === undefined || !propia.conectado || propia.cuentas.size === 0) return
        }
        if (![...enlaces.values()].some((enlace) => enlace.conectado && enlace.cuentas.size > 0)) return
        cuentaActiva = null
        yield* db.delete(TradingMetaTable).where(eq(TradingMetaTable.id, "cuenta_activa")).run().pipe(Effect.orDie)
        pushLog("info", "motor", `Active account ${activa} discarded · its link is connected with accounts and none is it; showing the primary link's account`, { message_key: "trading.log.account.active_discarded", message_params: { account: activa } })
      })

      const vacioEstado = (enlace: Enlace): EstadoCuenta => ({
        tipo: null,
        efectivo: null,
        equity: null,
        fondos: null,
        compraPoder: null,
        margen: null,
        liquidez: null,
        pnlDia: null,
        pnlRealizado: null,
        actualizada: null,
        linkID: enlace.id,
      })

      const positions = { value: [] as Trading.Position[] }
      // The IB contracts behind the tracked positions (keyed by local symbol), stored as they
      // arrive so a close operates on the real contract instead of rebuilding one.
      const contratos = { value: new Map<string, Contract>() }
      // The engine's own orders' latest known status (the reqOpenOrders stream, client ID 30):
      // the close cycle reads it to tell an accepted order from a rejected or cancelled one.
      const ordenesIds = new Map<number, { status: string; filled: number }>()
      // The desk's own orders this session, and the reason TWS gave when it refused one: a
      // refusal arrives as an error on the order's id, long before any status poll could tell.
      const ordenesPropias = new Set<number>()
      const rechazosOrden = new Map<number, string>()
      const logs = { value: [] as Trading.Log[] }
      // Recent tasks held in memory so the synchronous snapshot can include them without a DB read.
      const tasks = { value: [] as Trading.Task[] }
      // Recent closed trades (newest first), harvested from the bots' logs; written to the
      // trading_trade table as well, so they survive restarts. Capped to 200.
      const trades = { value: [] as Trading.Trade[] }
      let positionKey = ""

      // Boot state from the DB: the recent-trades ring, so it survives restarts.
      trades.value = (yield* db.select().from(TradingTradeTable).orderBy(desc(TradingTradeTable.ts)).limit(200).all().pipe(Effect.orDie)).map(
        (row) => ({ system: row.system, ts: row.ts, pnl: row.pnl, message: row.message }),
      )

      // The remembered active account: whatever `trading_meta` holds, lazily re-validated —
      // `cuentaActivaEstado()` falls back to the primary link's first account until that
      // login's streams re-discover the named account (or forever, if they never do).
      cuentaActiva =
        (yield* db.select().from(TradingMetaTable).where(eq(TradingMetaTable.id, "cuenta_activa")).all().pipe(Effect.orDie))[0]?.value ?? null

      interface LogExtra {
        readonly ts?: number
        readonly event?: "open" | "close" | "signal"
        readonly message_key?: string
        readonly message_params?: Record<string, unknown>
      }

      /** Debounce for engine-owned messages (no bot timestamp): a connection flap storm keeps
       * repeating "conexión establecida/perdida" every 5 s, and echoing them all would bury
       * the record's ring. Everything else stays verbatim: bot rows are never debounced. */
      const echoReciente = new Map<string, number>()

      const pushLog = (level: Trading.LogLevel, system: string, message: string, extra?: LogExtra) => {
        if (extra === undefined) {
          const clave = `${level}\u0001${system}\u0001${message}`
          const visito = echoReciente.get(clave)
          if (visito !== undefined && Date.now() - visito < 60_000) return
          echoReciente.set(clave, Date.now())
        }
        const entry: Trading.Log =
          extra?.event !== undefined
            ? {
                ts: extra?.ts ?? Date.now(),
                level,
                system,
                message,
                ...(extra?.message_key !== undefined ? { message_key: extra.message_key } : {}),
                ...(extra?.message_params !== undefined ? { message_params: extra.message_params } : {}),
                event: extra.event,
              }
            : {
                ts: extra?.ts ?? Date.now(),
                level,
                system,
                message,
                ...(extra?.message_key !== undefined ? { message_key: extra.message_key } : {}),
                ...(extra?.message_params !== undefined ? { message_params: extra.message_params } : {}),
              }
        logs.value = logs.value.length >= 800 ? [...logs.value.slice(-799), entry] : [...logs.value, entry]
      }
      pushLog("info", "motor", `Native engine started · programs open only on connect · primary link ${host}:${port}`, { message_key: "trading.log.motor.started", message_params: { host, port } })

      // The Python every bot and every MetaTrader 5 bridge runs on, resolved once at boot —
      // whatever the pool holds: it used to be looked up only when a systems folder loaded, so
      // a desk with MT5 links and no pool ran the bridge on a bare "pythonw" that may not exist.
      const pythonLocalizado = yield* Effect.promise(localizarPython)
      if (pythonLocalizado !== null) pythonwEjecutable = pythonLocalizado
      else if (process.platform === "win32")
        pushLog(
          "warning",
          "motor",
          "Python not found on this computer (the Microsoft Store shortcut does not count) · the MetaTrader 5 bridge and the bots need it: install Python from python.org, then run `pip install MetaTrader5`",
          { message_key: "trading.log.python.missing", message_params: {} },
        )

      // Subscriber callbacks run on IB socket threads outside the Effect runtime; the only
      // failure surface there is the callback itself, so guarding is the real boundary.
      const guard = (where: string, run: () => void) => {
        try {
          run()
        } catch (cause) {
          pushLog("error", "motor", `Internal failure in ${where}: ${String(cause)}`, { message_key: "trading.log.motor.internal_failure", message_params: { where, cause: String(cause) } })
        }
      }

      /** Every engine stream from TWS goes through here. A TWS-side fault on a stream's own
       * request id (a refused request, or a rejected order whose id lands on a subscription)
       * errors the stream out, and rxjs rethrows an unobserved error out of the process: here
       * it reaches the record instead, and the stream re-subscribes after 5 s, since each one
       * feeds a fact the desk keeps reading. Shutdown sets the latch so nothing re-subscribes. */
      const apagadoIb = { value: false }
      const escuchar = <T>(donde: string, crear: () => Escuchable<T>, next: (value: T) => void) => {
        crear().subscribe(
          (value) => guard(donde, () => next(value)),
          (error) => {
            pushLog("warning", "motor", `IBKR ${donde}: the stream dropped (${textoErrorIb(error)}) · resubscribing in 5 s`, { message_key: "trading.log.ibkr.stream_dropped", message_params: { where: donde, error: textoErrorIb(error) } })
            setTimeout(() => {
              if (!apagadoIb.value) escuchar(donde, crear, next)
            }, 5_000)
          },
        )
      }

      /** Per-link stream wiring: the connection state, the summary's per-account rows (one
       * EstadoCuenta per discovered account, with its own PnL subscription) and the ledger's
       * cash filler. Every callback touches only its link's own account map. An MT5 watch
       * never comes here — its accounts arrive over the sidecar bridge instead. */
      /** Every IBKR account's own open positions, keyed by account id: the trading connection
       * and the read-only watches alike, so the dashboard shows the positions of the account
       * it shows (a login with several accounts reports them account by account). */
      const posicionesIbkr = new Map<string, Trading.Position[]>()

      /** The rows the close cycle may act on. A close addresses exactly one account — the
       * account the cycle pinned at its start — so its reads must stay inside that account:
       * the flat `positions` list carries the whole login at once, and closing from it would
       * order account A against account B's row (or double-fire on a shared symbol). */
      const posicionesDeMotor = (cuenta: string | null) => (cuenta === null ? [] : (posicionesIbkr.get(cuenta) ?? []))

      /** One IBKR position onto the dashboard's row; null drops a row whose size is broken
       * or flat (a broken size would poison every number derived from it). */
      const posicionDeIbkr = (position: Position): Trading.Position | null => {
        const size = position.pos
        if (!Number.isFinite(size) || size === 0) return null
        // TWS states a derivative's average cost per contract (price × multiplier: an MNQ
        // short at 28,641 reads 57,282); the row's entry is the price the market quotes.
        const coste = safeNumber(position.avgCost)
        const multiplicador = Number(position.contract.multiplier)
        const derivado = ["FUT", "FOP", "OPT"].includes(position.contract.secType ?? "") && multiplicador > 0
        const entry = coste !== null && derivado ? coste / multiplicador : coste
        return {
          symbol: position.contract.localSymbol ?? position.contract.symbol ?? `${position.contract.conId ?? "?"}`,
          side: size > 0 ? "long" : "short",
          size: Math.abs(size),
          entry,
          ...preciosDe(coste, size, safeNumber(position.marketPrice), safeNumber(position.unrealizedPNL)),
        }
      }

      /** The price columns of a row: the PnL percent is over what the position cost (the
       * per-contract average cost already carries the multiplier). */
      const preciosDe = (coste: number | null, size: number, current: number | null, pnl: number | null) => {
        const denom = coste === null ? null : Math.abs(coste * Math.abs(size))
        const pct = pnl !== null && denom ? (pnl / denom) * 100 : null
        return { current, pnl, pnl_pct: pct !== null && Number.isFinite(pct) ? pct : null }
      }

      /** Each account's portfolio prices by local symbol, from the ledger's portfolio rows:
       * the positions stream never carries them, so the shown rows take them from here. */
      const preciosIbkr = new Map<string, Map<string, { coste: number | null; size: number; current: number | null; pnl: number | null }>>()
      const guardarPreciosIbkr = (cuenta: string, lista: readonly Position[]) => {
        const porSimbolo = new Map(preciosIbkr.get(cuenta))
        for (const position of lista) {
          const simbolo = position.contract.localSymbol ?? position.contract.symbol
          if (simbolo === undefined) continue
          porSimbolo.set(simbolo, {
            coste: safeNumber(position.avgCost),
            size: position.pos,
            current: safeNumber(position.marketPrice),
            pnl: safeNumber(position.unrealizedPNL),
          })
        }
        preciosIbkr.set(cuenta, porSimbolo)
      }

      /** An account's rows with the ledger's prices laid over the ones the positions stream
       * left empty. */
      const conPreciosIbkr = (cuenta: string, filas: readonly Trading.Position[]): Trading.Position[] => {
        const precios = preciosIbkr.get(cuenta)
        if (precios === undefined) return [...filas]
        return filas.map((fila) => {
          const precio = precios.get(fila.symbol)
          if (precio === undefined || fila.current !== null) return fila
          return { ...fila, ...preciosDe(precio.coste, precio.size, precio.current, precio.pnl) }
        })
      }

      /** One positions update onto the per-account map: every account the update names. */
      const guardarPosicionesIbkr = (todas: ReadonlyMap<string, readonly Position[]>) => {
        for (const [cuenta, lista] of todas)
          posicionesIbkr.set(
            cuenta,
            lista.flatMap((position) => {
              const fila = posicionDeIbkr(position)
              return fila === null ? [] : [fila]
            }),
          )
      }

      const asociarCuentas = (enlace: EnlaceIBKR) => {
        const primario = enlace.id === clavePrimario
        const donde = primario ? "" : ` en ${enlace.id}`
        escuchar(
          `connectionState ${enlace.id}`,
          () => enlace.ib.connectionState,
          (estado) => {
            if (estado === ConnectionState.Connected && !enlace.conectado) {
              enlace.conectado = true
              // TWS accepts a socket whose client id is taken and refuses it (326) a moment
              // later: the link counts as up only once it holds past that window.
              setTimeout(() => {
                if (!enlace.conectado) return
                enlace.ocupado = null
                const direccion = `${enlace.host}:${enlace.port}${entornoPuerto(enlace.port)}`
                pushLog("info", "motor", primario ? `Connection to IBKR established (${direccion})` : `Link ${enlace.id} connection established (${direccion})`, { message_key: primario ? "trading.log.ibkr.connected_primary" : "trading.log.ibkr.connected_link", message_params: { address: direccion, link: enlace.id } })
              }, CONEXION_FIRME_MS)
              return
            }
            if (estado === ConnectionState.Disconnected && enlace.conectado) {
              enlace.conectado = false
              // The positions ride the primary socket's stream; losing it empties them (and
              // keeps the positions log quiet until a fresh full read names them again).
              if (primario) {
                positions.value = []
                positionKey = ""
              }
              for (const cuenta of enlace.cuentas.keys()) {
                posicionesIbkr.delete(cuenta)
                preciosIbkr.delete(cuenta)
              }
              // The user's own Desconectar is no loss: it stops the chase, and says so.
              if (primario && desconexion.pedida) {
                desconexion.pedida = false
                pushLog("info", "motor", "Disconnected from TWS at your request · press Connect to link again", { message_key: "trading.log.ibkr.disconnected_by_user", message_params: {} })
                return
              }
              // The refusal already said why (clienteOcupado): a "loss" line would only bury it.
              if (enlace.ocupado !== null) return
               pushLog(
                "warning",
                "motor",
                primario ? "Connection to IBKR lost · retrying every 5 s" : `Link ${enlace.id} connection lost · retrying every 5 s`,
                { message_key: primario ? "trading.log.ibkr.lost_primary" : "trading.log.ibkr.lost_link", message_params: { link: enlace.id } },
              )
            }
          },
        )

        // Each discovered account's own PnL stream, subscribed once whichever stream names the
        // account first: the ledger often lands before the summary, and a first sighting there
        // used to leave the account without its day's PnL for good.
        const conPnl = new Set<string>()
        const suscribirPnl = (id: string) => {
          if (conPnl.has(id)) return
          conPnl.add(id)
          escuchar(
            `pnl ${enlace.id} ${id}`,
            () => enlace.ib.getPnL(id),
            (updatePnl) => {
              const estado = enlace.cuentas.get(id)
              if (estado === undefined) return
              enlace.cuentas.set(id, {
                ...estado,
                pnlDia: safeNumber(updatePnl.dailyPnL),
                pnlRealizado: safeNumber(updatePnl.realizedPnL),
              })
            },
          )
        }

        // Every row of the summary is a discovered account of that login: each fills its own
        // facts beside its PnL stream.
        escuchar(
          `accountSummary ${enlace.id}`,
          () => enlace.ib.getAccountSummary("All", ACCOUNT_SUMMARY_TAGS),
          (update) => {
            for (const [id, tags] of update.all) {
              const previa = enlace.cuentas.get(id)
              enlace.cuentas.set(id, {
                tipo: firstTagValue(tags.get("AccountType")) ?? previa?.tipo ?? null,
                // Same tag repeats per currency; balances come from the USD row, else the first
                // row. TWS often leaves the cash tags out of the summary: the ledger's figure
                // below then stays instead of being wiped on every summary tick.
                efectivo: parseValue(firstTagValue(tags.get("TotalCashBalance") ?? tags.get("CashBalance"))) ?? previa?.efectivo ?? null,
                equity: parseValue(firstTagValue(tags.get("NetLiquidation"))),
                fondos: parseValue(firstTagValue(tags.get("AvailableFunds"))),
                compraPoder: parseValue(firstTagValue(tags.get("BuyingPower"))),
                margen: parseValue(firstTagValue(tags.get("MaintMarginReq"))),
                liquidez: parseValue(firstTagValue(tags.get("ExcessLiquidity"))),
                pnlDia: previa?.pnlDia ?? null,
                pnlRealizado: previa?.pnlRealizado ?? null,
                actualizada: Date.now(),
                linkID: enlace.id,
              })
              suscribirPnl(id)
              if (previa !== undefined) continue
              pushLog("info", "motor", `Account ${id} discovered${donde}`, { message_key: "trading.log.account.discovered", message_params: { id, where: donde } })
            }
          },
        )

        // A read-only watch reads its accounts' positions too (the trading connection reads its
        // own below, where the close cycle also needs them).
        if (!primario) escuchar(`positions ${enlace.id}`, () => enlace.ib.getPositions(), (update) => guardarPosicionesIbkr(update.all))

        // TWS serves only a subset of the requested tags on the summary stream; the
        // account-updates stream (the Account Window ledger) carries the cash balances, so
        // it fills its own fact in once it arrives. The ledger refreshes at most every 3 minutes.
        // Its portfolio rows are the only place TWS states a position's market price and
        // unrealized PnL: the positions stream carries size and average cost alone.
        escuchar(
          `accountUpdates ${enlace.id}`,
          () => enlace.ib.getAccountUpdates(),
          (update) => {
            for (const [id, lista] of update.all.portfolio ?? []) guardarPreciosIbkr(id, lista)
            const summaries = update.all.value
            if (!summaries) return
            for (const [id, tags] of summaries) {
              const previa = enlace.cuentas.get(id)
              const estado = previa ?? vacioEstado(enlace)
              suscribirPnl(id)
              if (previa === undefined) pushLog("info", "motor", `Account ${id} discovered${donde}`, { message_key: "trading.log.account.discovered", message_params: { id, where: donde } })
              estado.tipo = estado.tipo ?? (firstTagValue(tags.get("AccountType")) ?? null)
              estado.efectivo = parseValue(
                firstTagValue(
                  tags.get("$LEDGER-TotalCashBalance") ??
                    tags.get("TotalCashBalance") ??
                    tags.get("CashBalance") ??
                    tags.get("TotalCashValue"),
                ),
              ) ?? estado.efectivo
              estado.actualizada = Date.now()
              enlace.cuentas.set(id, estado)
            }
          },
        )
      }

      /** One IBKR link from nothing to watching: built, wired and chasing (its socket's own
       * 5 s retry until TWS accepts). `persistir` writes the DB row (a boot reload has one
       * already). A link never places orders — it reads balances, nothing else. The layer's
       * shutdown finalizer below drops every link's socket, so no per-link cleanup here. */
      const enlazar = Effect.fn("TradingEngine.enlazar")(function* (hostEnlace: string, portEnlace: number, etiqueta: string | null, persistir: boolean) {
        if (!hostTwsPermitido(hostEnlace)) return yield* new InvalidTaskError({ message: MENSAJE_HOST_TWS })
        const id = `${hostEnlace}:${portEnlace}`
        const cliente = siguienteClienteEnlace
        siguienteClienteEnlace = cliente + 1
        const enlace = enlaceNueva(id, hostEnlace, portEnlace, etiqueta, cliente)
        enlaces.set(id, enlace)
        asociarCuentas(enlace)
        if (persistir) {
          const stamp = Date.now()
          yield* db
            .insert(TradingLinkTable)
            .values({ id, host: hostEnlace, port: portEnlace, label: etiqueta, broker: "ibkr", time_created: stamp, time_updated: stamp })
            .run()
            .pipe(Effect.orDie)
        }
        yield* Effect.sync(() => enlace.ib.connect(cliente))
        pushLog("info", "motor", `Link ${id} ${persistir ? "registered" : "reloaded from table"} · retrying every 5 s until TWS accepts (watches, never places orders)`, { message_key: "trading.log.link.registered", message_params: { id, persisted: persistir } })
        return enlace
      })

      // The primary link: the socket the dashboard's Conectar button drives. No boot or tick
      // ever starts the TWS program itself — the user's Conectar (or their own TWS launch)
      // does; this socket only chases an already-running TWS from the engine's first tick.
      // Registered links below do chase at boot — the user registered them once and a
      // balance watch needs no further permission.
      const enlacePrimaria = enlaceNueva(clavePrimario, host, port, null, clienteMotor)
      enlaces.set(clavePrimario, enlacePrimaria)
      asociarCuentas(enlacePrimaria)
      const ib = enlacePrimaria.ib

      // The shutdown latch and the bridges' scheduled retries: a bridge that exited within
      // the last 5 s leaves a pending respawn behind — with the latch set, the timers die
      // here instead of resurrecting a python watcher after the app is gone.
      let apagadoMT5 = false
      const reintentosPuente = new Map<string, ReturnType<typeof setTimeout>>()

      // Shutdown drops every link — the IBKR sockets and the MT5 sidecars alike — including
      // ones registered mid-flight (after the recreate below, the map's last state is
      // exactly what had to be closed). The dropped-before-kill dance (like the bots') keeps
      // a killed sidecar's exit event from rescheduling its own restart.
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          apagadoMT5 = true
          apagadoIb.value = true
          for (const retraso of reintentosPuente.values()) clearTimeout(retraso)
          reintentosPuente.clear()
          for (const enlace of enlaces.values()) {
            if (enlace.broker === "mt5") {
              const child = enlace.child
              enlace.child = null
              child?.kill()
              continue
            }
            enlace.ib.disconnect()
          }
        }),
      )

      // The links' table reloads after the MT5 bridge machinery, further down.

      escuchar(
        "positions",
        () => ib.getPositions(),
        (update) => {
          const todas = [...update.all.values()].flat()
          // Store the contract behind every reported position (even ones already closed) at
          // the earliest moment, so a close never has to guess its shape later.
          for (const position of todas) {
            const local = position.contract.localSymbol ?? position.contract.symbol
            if (position.contract.conId !== undefined && local) contratos.value.set(local, position.contract)
          }
          const mapped = todas.flatMap((position) => {
            const fila = posicionDeIbkr(position)
            return fila === null ? [] : [fila]
          })
          positions.value = mapped
          guardarPosicionesIbkr(update.all)
          const key = mapped.map((p) => `${p.symbol}:${p.side}${p.size}`).join(", ") || "sin posiciones"
          if (key !== positionKey) {
            positionKey = key
            pushLog("info", "motor", `Positions: ${key}`, { message_key: "trading.log.positions.snapshot", message_params: { key } })
          }
        },
      )

      // IBKR's messages (order rejects, tick errors, data-farm status) used to vanish into
      // the sidecar console; every one reaches the record from here.
      const avisoIbkr = { texto: "", ts: 0 }
      ib.errorSubject.subscribe((error) =>
        guard("dataNotices", () => {
          const codigo = Number(error.code)
          const texto = String(error.error)
          const orden = Number(error.reqId)

          // A refusal of one of the desk's own orders ends that order on the spot: the close
          // cycle reads a terminal state and the reason TWS gave instead of waiting it out.
          if (ordenesPropias.has(orden) && RECHAZOS_ORDEN.has(codigo)) {
            rechazosOrden.set(orden, `${codigo}: ${texto}`)
            ordenesIds.set(orden, { status: "Inactive", filled: ordenesIds.get(orden)?.filled ?? 0 })
          }

          // The reconnect chase repeats the very same notice every 5 s while TWS is away;
          // once a minute is enough for the record, and it keeps the useful lines in the ring.
          // A refused socket is TWS not listening yet: said in the user's words, not the socket's.
          const aviso =
            codigo === 502 && texto.includes("ECONNREFUSED")
              ? `TWS is not accepting connections at ${host}:${port}: it is closed, has no session started, or the API is disabled · retrying every 5 s`
              : RECHAZO_DIVISAS.test(texto)
                ? EXPLICACION_DIVISAS
                : `IBKR ${codigo}: ${texto}`
          const ahora = Date.now()
          if (aviso === avisoIbkr.texto && ahora - avisoIbkr.ts < 60_000) return
          avisoIbkr.texto = aviso
          avisoIbkr.ts = ahora
          // Farm connection status reports are channel bookkeeping, not trouble.
          pushLog(
            codigo >= 2100 && codigo <= 2199 ? "info" : "warning",
            "motor",
            aviso,
            RECHAZO_DIVISAS.test(texto)
              ? { message_key: "trading.log.ibkr.currency_leverage", message_params: {} }
              : undefined,
          )
        }),
      )

        // The orders already standing when the socket links up. The library ends this stream
        // after its first snapshot (openOrderEnd), so later states are asked fresh by the
        // close cycle itself (refrescarOrden); this only seeds what was there before.
        escuchar(
          "openOrders",
          () => ib.getOpenOrders(),
          (update) => {
            for (const orden of update.all) {
              if (orden.orderStatus) ordenesIds.set(orden.orderId, orden.orderStatus)
            }
          },
        )

      // ------------------------------------------------------- programs ---------
      // Nothing opens on its own: the ticks watch TWS's and MetaTrader 5's state and report
      // it, but a program opens only behind the user's own intent — the Conectar click opens
      // a closed TWS, and the wizard's account search is the door to the MetaTrader 5
      // terminal. A program the user closes later stays closed until the next Conectar. One
      // that is not installed is reported, with where to get it, instead of being waited for.

      /** Each program's state for the panel, unknown until the first look; MT5's only while an
       * MT5 account is linked. */
      const programas: { tws: EstadoPrograma | null; mt5: EstadoPrograma | null } = { tws: null, mt5: null }
      /** When the engine last opened each program: it reads "abriendo" while it loads. */
      const abiertoEn = new Map<Programa, number>()
      const CARGA_PROGRAMA_MS = 120_000

      const hayMT5 = () => [...enlaces.values()].some((enlace) => enlace.broker === "mt5")

      const revisarProgramas = async () => {
        const vivos = await procesos()
        const estado = async (programa: Programa): Promise<EstadoPrograma> => {
          if (enMarcha(programa, vivos)) return "abierto"
          if (Date.now() - (abiertoEn.get(programa) ?? 0) < CARGA_PROGRAMA_MS) return "abriendo"
          return (await localizar(programa)) === null ? "falta" : "cerrado"
        }

        programas.tws = await estado("tws")
        programas.mt5 = hayMT5() ? await estado("mt5") : null
      }

      /** The Conectar click's opener: a closed TWS opens here, then the current states land;
       * the MetaTrader 5 terminal is the wizard's account search's door, never this one's. */
      const abrirTws = async () => {
        const vivos = await procesos()

        if (enMarcha("tws", vivos)) return revisarProgramas()
        if (Date.now() - (abiertoEn.get("tws") ?? 0) < CARGA_PROGRAMA_MS) return revisarProgramas()

        const ruta = await localizar("tws")

        if (ruta === null) {
        pushLog("warning", "motor", `TWS not found on this computer · download and install it from ${DESCARGA.tws}`, { message_key: "trading.log.tws.not_found", message_params: { url: DESCARGA.tws } })
          return revisarProgramas()
        }

        abiertoEn.set("tws", Date.now())
        abrir("tws", ruta)
        pushLog("info", "motor", `Opening TWS (${ruta}) · log in in its window; the app connects once TWS accepts`, { message_key: "trading.log.tws.opening", message_params: { path: ruta } })
        return revisarProgramas()
      }

      // Once linked, the 5 s reconnect interval keeps chasing a flapping TWS; the user's
      // Desconectar fully stops that chase until the next Conectar. The user's Conectar opens
      // a closed TWS first — the boot's first tick chases the socket but never opens a thing.
      const ponerEnMarcha = Effect.gen(function* () {
        pushLog("info", "motor", `Connecting to TWS at ${host}:${port}… retrying every 5 s until it accepts`, { message_key: "trading.log.tws.connecting", message_params: { host, port } })
        yield* Effect.sync(() => ib.connect(clienteMotor))
      })
      const connect = Effect.gen(function* () {
        yield* Effect.promise(abrirTws)
        desconexion.pedida = false
        if (enlacePrimaria.conectado) return toSchemaAccount()
        yield* ponerEnMarcha
        return toSchemaAccount()
      })
      const arranque = { hecho: false }
      const disconnect = Effect.gen(function* () {
        yield* Effect.sync(() => {
          desconexion.pedida = enlacePrimaria.conectado
          ib.disconnect()
        })
        return null
      })

      // ---------------------------------------------------------- bots ----------
      // One real bot process per system. The truth about a bot is its folder's panel.pid plus
      // the process list; the bots' own registro.log / consola.log are the dashboard's record
      // of reference, tailed into the shared log with the system's name so every entry makes
      // plain which system did what and when it went into or out of a position.

      /** End-of-file position (0 when the file does not exist yet). */
      const cola = async (path: string) => {
        try {
          const { size } = await stat(path)
          return size
        } catch {
          return 0
        }
      }

      /** Reads a bot's file from an offset; null when it has not grown (the common case every tick). */
      const leerCola = async (path: string, offset: number) => {
        const handle = await open(path, "r").catch(() => null)
        if (handle === null) return null
        try {
          const { size } = await handle.stat()
          if (size <= offset) return null
          const length = Math.min(size - offset, 1_000_000)
          const buffer = Buffer.alloc(length)
          const { bytesRead } = await handle.read(buffer, 0, length, offset)
          return { chunk: buffer.toString("utf8", 0, bytesRead), size }
        } finally {
          await handle.close()
        }
      }

      /** A bot's registro.log row: local PC clock "YYYY-MM-DD hh:mm:ss,mmm" plus the message. */
      const LINEA_BOT = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}),(\d{3}) (.+)$/
      /** Bot rows that would bury the record: portfolio dumps, data-farm heartbeats and
       * ib_async's own connection/position chatter (the bot asserts those in its own
       * lifecycle lines anyway). */
      const SORRO =
        /^(updatePortfolio:|Warning \d|Disconnecting|position: |Connecting|Connected|Logged on|API connection|Synchronization|connectRequest|commissionReport:|execDetails |openOrder:|orderStatus:)/
      /** Untagged rows worth keeping: the bot's own lifecycle notes and TWS error messages. */
      const CICLO = /^(conectado a|contrato:|contexto:|la estrategia ha terminado|desconectado|el bot ha arrancado|Hoy no |Error \d)/

      interface Latido {
        ts: number | null
        level: Trading.LogLevel
        message: string
        event?: "open" | "close" | "signal"
        message_key?: string
        message_params?: Record<string, unknown>
      }

      /** One close row harvested as a trade: the bot's own timestamp, message and optional gross figure. */
      interface CosechaCierre {
        ts: number | null
        pnl: number | null
        message: string
      }

      const tsDe = (match: RegExpExecArray) =>
        new Date(
          Number(match[1]),
          Number(match[2]) - 1,
          Number(match[3]),
          Number(match[4]),
          Number(match[5]),
          Number(match[6]),
          Number(match[7]),
        ).getTime()

      const nivelError = (texto: string): Trading.LogLevel => {
        if (!/^Error /.test(texto)) return /Traceback|Exception/.test(texto) ? "error" : "info"
        // IB connection notes (1100 gone, 1101 reconnecting, 1102 reconnected) are routine
        // during TWS flaps; any other API error is a real fault.
        return /^(1100|1101|1102)/.test(texto.slice(6)) ? "warning" : "error"
      }

      /** Splits a bot's chunk into lifecycle beats in order, harvesting the bot's unrealized
       * PnL from the portfolio dumps (live bots only, so dead systems keep their own session
       * result) and its closed-trade result from FUERA rows. Timestamp-less rows are either
       * indented traceback continuations (they glue to the beat above) or plain lifecycle
       * notes that timestamp on arrival. */
      const parsearChunk = (systemID: string, chunk: string, cosecha = true): { latidos: Latido[]; cierres: CosechaCierre[]; ultima: number | null } => {
        const latidos: Latido[] = []
        const cierres: CosechaCierre[] = []
        let ultimaTs: number | null = null
        for (const raw of chunk.split("\n")) {
          const texto = raw.trimEnd()
          if (texto === "") continue
          const match = LINEA_BOT.exec(texto)
          if (match !== null) {
            const msg = match[8]
            const ts = tsDe(match)
            ultimaTs = ts
            if (SORRO.test(msg)) {
              // These rows never reach the record, but they carry a live bot's own pnl.
              // ib_async logs every portfolio row of the account: only the system's own
              // contract is its pnl (a manual MNQ is not the USDJPY system's).
              if (cosecha && esDelSistema(systemID, msg)) {
                const cosechaPnl = /unrealizedPNL=([-+0-9.eE]+)/.exec(msg)
                const valor = cosechaPnl === null ? NaN : Number(cosechaPnl[1])
                if (Number.isFinite(valor)) pnlBots.set(systemID, valor)
              }
              continue
            }
            const sinTag = msg.replace(/^\[[^\]]+\] /, "")
            let event: Latido["event"]
            if (/DENTRO a |PROMEDIA a /.test(sinTag)) event = "open"
            else if (/FUERA|posici[oó]n cerrada/.test(sinTag)) event = "close"
            else if (/se[nñ]al (COMPRA|VENTA)/.test(sinTag)) event = "signal"
            if (event === "close") {
              // The bot's own words state what the trade made; that stays its last shown pnl.
              const brutos = /\(([-+0-9.]+) USD brutos\)/.exec(sinTag)
              if (brutos !== null) pnlBots.set(systemID, Number(brutos[1]))
              // Every close row is one trade for the trade record, timestamped by the bot.
              cierres.push({ ts, pnl: brutos === null ? null : Number(brutos[1]), message: sinTag })
            }
            latidos.push({ ts, level: nivelError(sinTag), message: sinTag, event })
            if (RECHAZO_DIVISAS.test(sinTag)) latidos.push({ ts, level: "error", message: EXPLICACION_DIVISAS, message_key: "trading.log.ibkr.currency_leverage", message_params: {} })
            continue
          }
          if (/^\s/.test(raw)) {
            // A traceback continuation: append to the beat above so an error reads whole.
            const previo = latidos[latidos.length - 1]
            if (previo !== undefined) previo.message = `${previo.message}\n${texto.trim()}`
            continue
          }
          if (CICLO.test(texto)) latidos.push({ ts: null, level: nivelError(texto), message: texto })
          else if (/Traceback|Exception/.test(texto))
            // In registro.log a traceback head follows the timestamped error row that caused
            // it; inherit that row's hour so the record keeps the fault in its true place.
            latidos.push({ ts: ultimaTs, level: "error", message: texto })
          if (RECHAZO_DIVISAS.test(texto)) latidos.push({ ts: ultimaTs, level: "error", message: EXPLICACION_DIVISAS, message_key: "trading.log.ibkr.currency_leverage", message_params: {} })
        }
        return { latidos, cierres, ultima: ultimaTs }
      }

      const runtimeNuevo = (): Runtime => ({
        source: null,
        pid: null,
        startedAt: null,
        child: null,
        planeado: false,
        sondeoDudado: false,
        registroOffset: 0,
        consolaOffset: 0,
        ultimaActividad: null,
      })

      /** The bot's latest own row: its line's own timestamp when it carries one, the arrival
       * time otherwise. Today only — the tail offsets start at today's first row, so a stopped
       * bot's activity is its latest line of the day, not its last session ever. */
      const notaActividad = (runtime: Runtime, ultima: number | null) => {
        const ts = ultima ?? Date.now()
        runtime.ultimaActividad = runtime.ultimaActividad === null ? ts : Math.max(runtime.ultimaActividad, ts)
      }

      /** The record owes itself to the current day only: the tail offset starts at today's
       * first registro.log row, so a restart never replays older sessions. */
      const offsetDeHoy = async (path: string) => {
        const contenido = await readFile(path, "utf8").catch(() => "")
        const hoy = new Date()
        const prefijo = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, "0")}-${String(hoy.getDate()).padStart(2, "0")} `
        const corte = contenido.indexOf(prefijo)
        return corte === -1 ? Buffer.byteLength(contenido) : Buffer.byteLength(contenido.slice(0, corte))
      }

      /** Attributes a detected bot to its system (idempotent); a fresh attach resets the day pnl. */
      const adjuntar = (def: Definicion, source: "panel" | "external", pid: number | null, nota: string) => {
        const runtime = bots.get(def.id)
        if (runtime === undefined) return
        runtime.source = source
        runtime.pid = pid
        runtime.planeado = false
        if (runtime.startedAt !== null) return
        runtime.startedAt = Date.now()
        pnlBots.delete(def.id)
        const message_key = source === "panel" ? "trading.log.bot.attached_panel" : "trading.log.bot.attached_external"
        const message_params = source === "panel" ? { pid } : { client: def.clientId }
        pushLog("info", def.name, nota, { message_key, message_params })
      }

      /** One tick's tail: new registro.log rows become record beats, new consola.log rows
       * capture what the bot cannot say itself (tracebacks, unhandled errors). Live bots
       * also keep harvesting their unrealized pnl; dead ones no longer need it. */
      const ingestaUna = async (def: Definicion, enMarchaSolo = true) => {
        if (def.dir === null) return
        const runtime = bots.get(def.id)
        if (runtime === undefined) return
        if (enMarchaSolo && runtime.startedAt === null) return
        const cosecha = runtime.startedAt !== null
        const registro = await leerCola(`${def.dir}\\registro.log`, runtime.registroOffset)
        if (registro !== null) {
          runtime.registroOffset = registro.size
          const salida = parsearChunk(def.id, registro.chunk, cosecha)
          for (const latido of salida.latidos) {
            pushLog(latido.level, def.name, latido.message, {
              ts: latido.ts ?? undefined,
              event: latido.event,
              ...(latido.message_key !== undefined ? { message_key: latido.message_key } : {}),
              ...(latido.message_params !== undefined ? { message_params: latido.message_params } : {}),
            })
          }
          if (salida.cierres.length > 0) void Effect.runPromise(registrarTrades(def.id, salida.cierres)).catch(() => undefined)
          if (salida.latidos.length > 0) notaActividad(runtime, salida.ultima)
        }
        const consola = await leerCola(`${def.dir}\\consola.log`, runtime.consolaOffset)
        if (consola !== null) {
          runtime.consolaOffset = consola.size
          const salida = parsearChunk(def.id, consola.chunk, cosecha)
          for (const latido of salida.latidos) {
            pushLog(latido.level, def.name, latido.message, {
              ts: latido.ts ?? undefined,
              event: latido.event,
              ...(latido.message_key !== undefined ? { message_key: latido.message_key } : {}),
              ...(latido.message_params !== undefined ? { message_params: latido.message_params } : {}),
            })
          }
          if (salida.latidos.length > 0) notaActividad(runtime, salida.ultima)
        }
      }

      /** Records a bot's closed trades: insert-if-new into the trading_trade table (the
       * id carries system+ts+message-hash, so a replayed log tail re-inserts nothing and
       * two closes in the same millisecond never collide) and newest-first into
       * the snapshot ring, capped to the most recent 200. The insert is a real Effect —
       * its caller runs it — and a database fault lands in the record, not in memory alone. */
      const registrarTrades = (systemID: string, cierres: readonly CosechaCierre[]): Effect.Effect<void> =>
        Effect.gen(function* () {
          const ahora = Date.now()
          let nueva = [...trades.value]
          for (const cierre of cierres) {
            const trade: Trading.Trade = {
              system: systemID,
              ts: cierre.ts ?? ahora,
              pnl: cierre.pnl ?? null,
              message: cierre.message,
            }
            yield* db
              .insert(TradingTradeTable)
              .values({
                id: tradeIdentidad(trade),
                system: trade.system,
                ts: trade.ts,
                pnl: trade.pnl,
                message: trade.message,
                time_created: trade.ts,
                time_updated: trade.ts,
              })
              .onConflictDoNothing()
              .run()
              .pipe(
                Effect.catch((error) =>
                  Effect.sync(() =>
        pushLog("error", "motor", `Could not save the trade of ${trade.system} to the table: ${String(error)}`, { message_key: "trading.log.trade.save_failed", message_params: { system: trade.system, error: String(error) } }),
                  ),
                ),
              )
            if (!nueva.some((previo) => previo.system === trade.system && previo.ts === trade.ts)) nueva.unshift(trade)
          }
          nueva = nueva.sort((a, b) => b.ts - a.ts).slice(0, 200)
          trades.value = nueva
        })

      let ultimoSondeo = 0

      /** The 45 s sweep, port of the old panel's sondeo: keeps honest state for adopted
       * (pid-less) bots, retires stale panel.pid files, and adopts bots started outside
       * the engine via their folder's panel.pid or a TWS probe with their CLIENT_ID. */
      const sondear = async (forzar = false) => {
        const ahora = Date.now()
        if (!forzar && ahora - ultimoSondeo < 45_000) return
        ultimoSondeo = ahora
        for (const def of sistemas) {
          if (def.dir === null) continue
          const runtime = bots.get(def.id)
          if (runtime !== undefined && runtime.startedAt !== null) {
            // The engine's own children watch themselves; only adopted bots need a pid check —
            // and an adopted pid keeps its seat only while it really is this system's bot.py:
            // a Windows-reused pid must neither pretend the bot is alive nor die here. An
            // unverified answer is not a no: the seat stays until the check answers again.
            if (runtime.child !== null) continue
            const pidAdoptado = runtime.pid
            const vivoAdoptado = pidAdoptado === null ? false : await pidVivo(pidAdoptado)
            if (vivoAdoptado === null) {
              // The tasklist check itself failed (blocked, timed out): as with a failed
              // command-line check, the seat stays and the record tells once.
              if (!runtime.sondeoDudado) {
                runtime.sondeoDudado = true
                pushLog(
                  "warning",
                  def.name,
                  `Could not verify that pid ${pidAdoptado} is still this system's bot (the check itself failed) · the bot stays running`,
                  { message_key: "trading.log.bot.verify_unknown", message_params: { pid: pidAdoptado } },
                )
              }
              continue
            }
            const esBotAdoptado = pidAdoptado !== null && vivoAdoptado ? await pidEsBot(pidAdoptado, def.dir) : false
            if (esBotAdoptado === true) {
              runtime.sondeoDudado = false
              continue
            }
            if (esBotAdoptado === null) {
              // The check itself could not answer (PowerShell blocked, busy, timed out):
              // keep the bot visible and running. The warning tells the record once, not on
              // every sweep while the check stays silent.
              if (!runtime.sondeoDudado) {
                runtime.sondeoDudado = true
                pushLog(
                  "warning",
                  def.name,
                  `Could not verify that pid ${pidAdoptado} is still this system's bot (the check itself failed) · the bot stays running`,
                  { message_key: "trading.log.bot.verify_unknown", message_params: { pid: pidAdoptado } },
                )
              }
              continue
            }
            runtime.source = null
            runtime.pid = null
            runtime.startedAt = null
            runtime.sondeoDudado = false
            // An adopted bot died without an exit event: wash its log tail once before the
            // record marks the fall, so its beats are not orphaned by the running-only tick.
            await ingestaUna(def, false).catch(() => undefined)
            pushLog(
              "warning",
              def.name,
              vivoAdoptado ? `Bot down · pid ${pidAdoptado} now belongs to another process; not killed, the bot is gone` : "Bot down · the probe found the process is gone",
              { message_key: vivoAdoptado ? "trading.log.bot.probe_reused" : "trading.log.bot.probe_down", message_params: vivoAdoptado ? { pid: pidAdoptado } : {} },
            )
            continue
          }
          const pid = Number((await readFile(`${def.dir}\\panel.pid`, "utf8").catch(() => "")).trim()) || 0
          // Adopting a live pid asks the same safeguard the stop does: only a bot.py of this
          // folder takes the seat, so a reused pid (its original bot long gone) is not
          // presented as a running system. An unverified answer is not a no: the marker file
          // stays up (dropping it on a broken check could retire a live bot's seat) and the
          // check answers again next sweep.
          if (pid > 0) {
            const vivo = await pidVivo(pid)
            if (vivo === null) continue
            // Adoption asks the same safeguard the stop does. A checked death is the only
            // thing below that retires the marker.
            if (vivo) {
              const esBot = await pidEsBot(pid, def.dir)
              if (esBot === true) {
                adjuntar(def, "panel", pid, `Bot ya en marcha · PID ${pid} (panel.pid)`)
                continue
              }
              if (esBot === null) continue
            }
          }
          if (pid > 0) await unlink(`${def.dir}\\panel.pid`).catch(() => undefined)
          if (def.clientId !== null && (await clientIdEnUso(host, port, def.clientId))) {
            adjuntar(def, "external", null, `Bot ya en marcha · detectado en TWS con su CLIENT_ID ${def.clientId}`)
          }
        }
      }

      /** Boot scan of the pool folder, then one forced sweep so bots already running when the
       * app opens (engine-restarted, old panel, or plain console) show up immediately. */
      const escanearArranque = async () => {
        // A reload starts from an empty pool: the previous folder's systems leave with it.
        sistemas = []
        bots.clear()
        pnlBots.clear()
        const carpeta = carpetaPool.value
        if (!carpeta) {
          pushLog("info", "motor", "No systems folder configured: empty pool", { message_key: "trading.log.pool.no_folder", message_params: {} })
          return
        }
        const carpetas = await escanearCarpetas(carpeta)
        if (carpetas.length === 0) {
          pushLog("warning", "motor", `No system folders found in ${carpeta}`, { message_key: "trading.log.pool.no_systems", message_params: { folder: carpeta } })
          return
        }
        sistemas = await Promise.all(carpetas.map((name) => definicion(name, carpeta)))
        // Config warnings at boot: a shared CLIENT_ID would have TWS reject the second bot,
        // and a config that points at another port runs outside the engine's own watch —
        // the sweep would neither see nor adopt a bot connecting over there.
        const porCliente = new Map<number, string[]>()
        for (const def of sistemas) {
          if (def.clientId === null) continue
          const lista = porCliente.get(def.clientId) ?? []
          lista.push(def.name)
          porCliente.set(def.clientId, lista)
        }
        for (const [clientId, names] of porCliente) {
        if (names.length > 1) pushLog("warning", "motor", `CLIENT_ID ${clientId} shared by ${names.join(", ")} · TWS would reject the second`, { message_key: "trading.log.pool.client_id_shared", message_params: { clientId, names: names.join(", ") } })
        }
        for (const def of sistemas) {
          if (def.servidor !== null && def.servidor !== `${host}:${port}`)
            pushLog("warning", def.name, `config.py points to ${def.servidor} · the engine watches ${host}:${port}`, { message_key: "trading.log.system.config_mismatch", message_params: { server: def.servidor, host, port } })
        }
        pushLog("info", "motor", `System pool loaded from ${carpeta} (${sistemas.length} systems)`, { message_key: "trading.log.pool.loaded", message_params: { folder: carpeta, count: sistemas.length } })
        await Promise.all(
          sistemas.map(async (def) => {
            if (def.dir === null) return
            const runtime = runtimeNuevo()
            runtime.registroOffset = await offsetDeHoy(`${def.dir}\\registro.log`)
            runtime.consolaOffset = await cola(`${def.dir}\\consola.log`)
            bots.set(def.id, runtime)
          }),
        )
        // Adopt anything already running first, then seed every bot's record with its full
        // day, even dead ones: a bot that closed its position and stopped at 10am must still
        // show its history after an app restart. The sweep reads one config ahead (attach
        // resets the day pnl), so the boot sweep refills live bots' pnl from their own logs.
        await sondear(true)
        await Promise.all(sistemas.map((def) => ingestaUna(def, false)))
      }

      /** One activation's whole story, guards included. `ok` states the truth for the caller
       * — a scheduled task only marks itself ran when it is (a failed folder, console or
       * spawn is not a ran). The launch holds one in-flight flag per system id: a second
       * activation while the first is still spawning aborts instead of racing the startedAt
       * check into two bot processes. */
      const arrancarNucleo = Effect.fn("TradingEngine.arrancar")(function* (id: string, origin: "user" | "task") {
        const def = sistemas.find((candidata) => candidata.id === id)
        if (def === undefined) return yield* new SystemNotFoundError({ systemID: id })
        const previo = bots.get(id)
        if (previo !== undefined && previo.startedAt !== null) return { sistema: toSchemaSystem(def), ok: true, motivo: null }
        if (def.dir === null) {
          pushLog("error", def.name, "The bot cannot start: the system folder is not available", { message_key: "trading.log.bot.folder_unavailable", message_params: {} })
          return { sistema: toSchemaSystem(def), ok: false, motivo: "la carpeta del sistema no está disponible" }
        }
        if (arranquesEnVuelo.has(id)) {
          pushLog("warning", def.name, "A start is already in flight for this system: no second process is launched", { message_key: "trading.log.bot.start_in_flight", message_params: {} })
          return { sistema: toSchemaSystem(def), ok: false, motivo: "ya hay un arranque en marcha" }
        }
        arranquesEnVuelo.add(id)
        return yield* Effect.ensuring(
          Effect.gen(function* () {
            // The folder's narrowing does not ride the nested generator: re-narrow here, the
            // one place the launch itself needs it.
            const dir = def.dir
            if (dir === null) return { sistema: toSchemaSystem(def), ok: false, motivo: "la carpeta del sistema no está disponible" }
            // TWS serves one session per client id: when a session already exists for this bot's
            // own id (an externally started process the sweep hasn't adopted yet), a second spawn
            // would be rejected. Adopt the live one instead of spawning a twin, exactly what the
            // sweep does on its own beat.
            const clientId = def.clientId
            if (enlacePrimaria.conectado && clientId !== null) {
              const ocupado = yield* Effect.promise(() => clientIdEnUso(host, port, clientId))
              if (ocupado) {
                adjuntar(def, "external", null, `Bot ya en marcha · detectado en TWS con su CLIENT_ID ${clientId}`)
                return { sistema: toSchemaSystem(def), ok: true, motivo: null }
              }
            }
            // Two bots over the same instrument may well duplicate each other's positions. The
            // start itself still proceeds; its warning lands in the record beside the launch note.
            const simbolo = def.meta?.symbol
            const gemelo =
              simbolo === undefined
                ? undefined
                : sistemas.find(
                    (otro) =>
                      otro.id !== id && otro.meta?.symbol === simbolo && (bots.get(otro.id)?.startedAt ?? null) !== null,
                  )
            if (gemelo !== undefined)
              pushLog(
                "warning",
                def.name,
                `Two bots on the same symbol · ${gemelo.name} already runs on ${simbolo}: can duplicate positions`,
                { message_key: "trading.log.bot.same_symbol", message_params: { twin: gemelo.name, symbol: simbolo } },
              )
            const runtime = previo ?? runtimeNuevo()
            if (previo === undefined) {
              // Tail offsets are seeded at the current day's first row, so the record keeps the
              // whole session even after a mid-day restart.
              runtime.registroOffset = yield* Effect.promise(() => offsetDeHoy(`${dir}\\registro.log`))
              runtime.consolaOffset = yield* Effect.promise(() => cola(`${dir}\\consola.log`))
            }
            const consola = yield* Effect.tryPromise({ try: () => open(`${dir}\\consola.log`, "a"), catch: (error) => String(error) }).pipe(
              Effect.catch((error) =>
                Effect.sync(() => {
                  pushLog("error", def.name, `Could not open ${dir}\\consola.log: ${error}`, { message_key: "trading.log.bot.console_open_failed", message_params: { path: `${dir}\\consola.log`, error } })
                  return null
                }),
              ),
            )
            if (consola === null)
              return { sistema: toSchemaSystem(def), ok: false, motivo: "no se pudo abrir la consola del bot" }
            // The spawned line names its script by absolute path: the adopted-pid safeguard
            // (pidEsBot) denies a kill whose bot.py does not live in this system's folder.
            const child = spawn(pythonwEjecutable, [`${dir}\\bot.py`], {
              cwd: dir,
              env: { ...process.env, PYTHONPATH: botPythonPath === undefined ? "" : botPythonPath },
              windowsHide: true,
              stdio: ["ignore", "ignore", consola.fd],
            })
            // The child inherited its own copy of the descriptor; the engine's handle closes
            // the same way the old panel's launch did.
            void consola.close().catch(() => undefined)
            child.on("error", (error) => {
              // A failed spawn may never fire exit, which would read as running forever;
              // the error event clears the runtime exactly like the exit event does.
        pushLog("error", def.name, `Could not start the bot: ${String(error)}`, { message_key: "trading.log.bot.start_failed", message_params: { error: String(error) } })
              const actual = bots.get(id)
              if (actual === undefined || actual.child !== child) return
              actual.child = null
              actual.source = null
              actual.pid = null
              actual.startedAt = null
            })
            if (child.pid === undefined) {
              void consola.close().catch(() => undefined)
              return { sistema: toSchemaSystem(def), ok: false, motivo: "el proceso no llegó a levantarse" }
            }
            child.on("exit", (code) => {
              const actual = bots.get(id)
              if (actual === undefined || actual.child !== child) return
              actual.child = null
              if (actual.planeado) return
              actual.source = null
              actual.pid = null
              actual.startedAt = null
              // The final tail is on disk by the time the process exits; harvest it now before
              // the tick ingests it, so the bot's closing beats reach the record in their place.
              void ingestaUna(def, false)
                .catch(() => undefined)
                .finally(() =>
                  // Exit 0 is a bot that ends its day on its own (not its weekday, past its
                  // signal hour, the session closed): its own last lines above say why.
                  code === 0
                    ? pushLog("info", def.name, "Stopped on its own: it no longer trades today", { message_key: "trading.log.bot.stopped_self", message_params: {} })
                    : pushLog("warning", def.name, `Bot down · the process exited with code ${code ?? "unknown"}`, { message_key: "trading.log.bot.crashed", message_params: { code: code ?? "unknown" } }),
                )
            })
            runtime.child = child
            runtime.source = "panel"
            runtime.pid = child.pid
            runtime.startedAt = Date.now()
            runtime.planeado = false
            bots.set(id, runtime)
            yield* Effect.promise(() => writeFile(`${dir}\\panel.pid`, String(child.pid)).catch(() => undefined))
            pushLog(
              "info",
              def.name,
              origin === "user"
                ? `Bot started by the user · PID ${child.pid} (errors in consola.log)`
                : `Bot started by a scheduled task · PID ${child.pid}`,
              { message_key: origin === "user" ? "trading.log.bot.started_user" : "trading.log.bot.started_task", message_params: { pid: child.pid } },
            )
            return { sistema: toSchemaSystem(def), ok: true, motivo: null }
          }),
          Effect.sync(() => arranquesEnVuelo.delete(id)),
        )
      })

      const arrancar = Effect.fn("TradingEngine.arrancar")(function* (id: string, origin: "user" | "task") {
        return (yield* arrancarNucleo(id, origin)).sistema
      })

      /** One stop's verdict: `stopped` is only true when the engine proved the process gone
       * (or it was already dead). A failed kill keeps the runtime upright, so the panel,
       * the guard and the sweep keep seeing the bot that is really still there. */
      const pararBot = Effect.fn("TradingEngine.pararBot")(function* (id: string, origin: StopOrigin) {
        const def = sistemas.find((candidata) => candidata.id === id)
        if (def === undefined) return yield* new SystemNotFoundError({ systemID: id })
        const runtime = bots.get(id)
        if (runtime === undefined || runtime.startedAt === null)
          return { sistema: toSchemaSystem(def), stopped: true, motivo: null }
        if (runtime.child === null && runtime.pid === null) {
        pushLog("warning", def.name, "Bot running but with no PID (external): the panel cannot stop it", { message_key: "trading.log.bot.external_no_pid", message_params: {} })
          return { sistema: toSchemaSystem(def), stopped: false, motivo: "externo sin PID (lo arrancó otra instancia)" }
        }
        const pid = runtime.pid
        if (runtime.child !== null) {
          const hijo = runtime.child.pid
          // The child usually exits within the wait below, before its state is dropped: the
          // mark tells its exit handler this stop was ordered, not a fallen bot.
          runtime.planeado = true
          runtime.child.kill()
          yield* Effect.sleep(300)
          const vivoHijo = hijo === undefined ? false : yield* Effect.promise(() => pidVivo(hijo))
          if (vivoHijo === null) {
            // The confirmation check itself failed: give the stop no verdict — the panel
            // keeps seeing the bot that may still be there, and the panic counts it as
            // unconfirmed rather than stopped.
            runtime.planeado = false
            pushLog(
              "warning",
              def.name,
              `Could not confirm that pid ${hijo} stopped (the check itself failed) · treated as still running`,
              { message_key: "trading.log.bot.stop_unconfirmed", message_params: { pid: hijo } },
            )
            return { sistema: toSchemaSystem(def), stopped: false, motivo: `no se pudo confirmar la parada del proceso ${hijo}` }
          }
          if (vivoHijo) {
            runtime.planeado = false
        pushLog("error", def.name, `Process ${hijo} is still alive after the stop; check Task Manager`, { message_key: "trading.log.bot.process_alive", message_params: { pid: hijo } })
            return { sistema: toSchemaSystem(def), stopped: false, motivo: `el proceso ${hijo} sigue vivo` }
          }
        } else if (pid !== null) {
          // The process was adopted, so the safeguard still applies — and it re-checks the
          // system's own panel.pid, because Windows reuses pids and a stray bot.py from
          // another project must never die under our stop.
          const vivo = yield* Effect.promise(() => pidVivo(pid))
          if (vivo === null) {
            // The alive-check itself could not answer (tasklist blocked, busy, timed out):
            // as with a failed command-line check, nothing is killed on an unchecked seat.
            pushLog(
              "warning",
              def.name,
              `Could not verify that pid ${pid} belongs to a bot of ${def.name} (the check itself failed) · nothing was killed, the bot stays as it is`,
              { message_key: "trading.log.bot.stop_unverified", message_params: { pid, name: def.name } },
            )
            return { sistema: toSchemaSystem(def), stopped: false, motivo: "la comprobación del pid no pudo responder: nada se ha matado" }
          }
          if (vivo) {
            const esBot = yield* Effect.promise(() => pidEsBot(pid, def.dir))
            if (esBot === false) {
              // The pid's owner changed under us: wash the runtime and the stale panel.pid
              // right here — not just report a down bot — so the panel stops showing it
              // running, the panic summary stays honest, and no further stop retries the
              // same dead seat. Nothing is killed that is not the bot's own.
              runtime.child = null
              runtime.source = null
              runtime.pid = null
              runtime.startedAt = null
              runtime.planeado = false
              runtime.sondeoDudado = false
              if (def.dir !== null) yield* Effect.promise(() => unlink(`${def.dir}\\panel.pid`).catch(() => undefined))
              pushLog(
                "warning",
                def.name,
                `Pid ${pid} no longer belongs to a bot of ${def.name} (reused pid or bot down) · reported down without killing any process`,
                { message_key: "trading.log.bot.pid_reused", message_params: { pid, name: def.name } },
              )
              return { sistema: toSchemaSystem(def), stopped: true, motivo: null }
            }
            if (esBot === null) {
              // The check itself could not answer (PowerShell blocked, busy, timed out):
              // the bot stays exactly as it is — visible, running, and this stop reports no
              // verdict: killing on an unchecked seat is never our call. A stop retried when
              // the check answers gets the real path.
              pushLog(
                "warning",
                def.name,
                `Could not verify that pid ${pid} belongs to a bot of ${def.name} (the check itself failed) · nothing was killed, the bot stays as it is`,
                { message_key: "trading.log.bot.stop_unverified", message_params: { pid, name: def.name } },
              )
              return { sistema: toSchemaSystem(def), stopped: false, motivo: "la comprobación del pid no pudo responder: nada se ha matado" }
            }
            yield* Effect.promise(() => ejecutalo("taskkill", ["/PID", String(pid), "/T", "/F"], 8_000))
            const vivoTras = yield* Effect.promise(() => pidVivo(pid))
            if (vivoTras === null) {
              pushLog(
                "warning",
                def.name,
                `Could not confirm that pid ${pid} stopped (the check itself failed) · treated as still running`,
                { message_key: "trading.log.bot.stop_unconfirmed", message_params: { pid } },
              )
              return { sistema: toSchemaSystem(def), stopped: false, motivo: "no se pudo confirmar la parada tras taskkill (la comprobación no respondió)" }
            }
            if (vivoTras) {
              pushLog(
                "error",
                def.name,
                `Could not terminate process ${pid} with taskkill; it is still running, check Task Manager`,
                { message_key: "trading.log.bot.taskkill_failed", message_params: { pid } },
              )
              return { sistema: toSchemaSystem(def), stopped: false, motivo: `taskkill no pudo terminar el proceso ${pid}` }
            }
          }
        }
        // The child state is dropped here, so an exit event later than the wait finds no owner
        // either and never reports a fallen bot for a stop we ordered ourselves.
        runtime.child = null
        runtime.source = null
        runtime.pid = null
        runtime.startedAt = null
        runtime.planeado = false
        if (def.dir !== null) {
          yield* Effect.promise(() => unlink(`${def.dir}\\panel.pid`).catch(() => undefined))
        }
        pushLog("info", def.name, STOP_ORIGIN_MESSAGE[origin], { message_key: "trading.log.bot.stopped_origin", message_params: { origin } })
        return { sistema: toSchemaSystem(def), stopped: true, motivo: null }
      })

      const detener = Effect.fn("TradingEngine.detener")(function* (id: string, origin: StopOrigin) {
        return (yield* pararBot(id, origin)).sistema
      })

      /** Stops every running bot in turn; a stop failure never blocks the rest, and the
       * verdict names the ones that stayed alive, so a panic's summary never lies. */
      const detenerTodos = Effect.fn("TradingEngine.detenerTodos")(function* (origin: StopOrigin) {
        const detenidos: string[] = []
        const fallos: string[] = []
        for (const def of sistemas) {
          if ((bots.get(def.id)?.startedAt ?? null) === null) continue
          const salida = yield* pararBot(def.id, origin).pipe(
            Effect.catch(() =>
              Effect.succeed({ sistema: toSchemaSystem(def), stopped: false, motivo: "fallo inesperado en la parada" }),
            ),
          )
          if (salida.stopped) detenidos.push(def.name)
          else fallos.push(`${def.name}: ${salida.motivo ?? "parada sin confirmar"}`)
        }
        if (fallos.length > 0) pushLog("error", "motor", `Could not stop: ${fallos.join(" · ")}`, { message_key: "trading.log.bot.stop_failed", message_params: { systems: fallos.join(" · ") } })
        return { detenidos, fallos }
      })

      /** One equity point every 15 s while the tick runs, for every account any link reads
       * (an IBKR login's or an MT5 terminal's); only reported values are kept. The snapshot
       * shows the curve of the account the dashboard is showing, so switching accounts never
       * splices one account's line onto another's. */
      let equityUltima = 0
      const curvas = new Map<string, Trading.EquityPoint[]>()
      const muestrearEquity = () => {
        const ahora = Date.now()
        if (ahora - equityUltima < 15_000) return
        equityUltima = ahora
        for (const enlace of enlaces.values())
          for (const [id, estado] of enlace.cuentas) {
            const punto: Trading.EquityPoint = { ts: ahora, equity: estado.equity, pnl_day: estado.pnlDia }
            if (punto.equity === null && punto.pnl_day === null) continue
            curvas.set(id, [...(curvas.get(id) ?? []), punto].slice(-1000))
          }
      }

      /** Orders the task list newest first; the snapshot shows this exact slice. */
      const refreshTasks = Effect.gen(function* () {
        const rows = yield* db
          .select()
          .from(TradingTaskTable)
          .orderBy(desc(TradingTaskTable.time_created), desc(TradingTaskTable.run_at))
          .limit(50)
          .all()
          .pipe(Effect.orDie)
        tasks.value = rows.map(toSchemaTask)
      })

      const fmtHora = (ts: number) => {
        const fecha = new Date(ts)
        return `${String(fecha.getHours()).padStart(2, "0")}:${String(fecha.getMinutes()).padStart(2, "0")}:${String(
          fecha.getSeconds(),
        ).padStart(2, "0")}`
      }

      /** The next local wall-clock occurrence of "HH:MM" (PC clock), or null when the input lacks that shape. */
      const nextAtTime = (atTime: string | undefined, now: number) => {
        const match = atTime === undefined ? undefined : /^(\d{1,2}):(\d{2})$/.exec(atTime)
        if (!match) return null
        const hour = Number(match[1])
        const minute = Number(match[2])
        if (hour > 23 || minute > 59) return null
        const today = new Date(now)
        const due = new Date(today.getFullYear(), today.getMonth(), today.getDate(), hour, minute).getTime()
        // Tomorrow's occurrence is built as a local date, never as 24 added hours: the two
        // clock changes of the year would otherwise push a scheduled stop an hour late (a
        // shut-down that fires at 22:00 after a spring forward leaves it open an extra hour).
        return due > now ? due : new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1, hour, minute).getTime()
      }

      const taskAdd = Effect.fn("TradingEngine.taskAdd")(function* (input: TaskAddInput) {
        if (input.delayMinutes !== undefined && input.atTime !== undefined)
          return yield* new InvalidTaskError({ message: "Give either delayMinutes or atTime, not both." })
        if (input.delayMinutes === undefined && input.atTime === undefined)
          return yield* new InvalidTaskError({ message: "Give delayMinutes or atTime." })
        if (input.delayMinutes !== undefined && (!Number.isFinite(input.delayMinutes) || input.delayMinutes <= 0))
          return yield* new InvalidTaskError({ message: "delayMinutes must be a positive number of minutes." })

        const now = Date.now()
        const runAt =
          input.delayMinutes !== undefined
            ? now + input.delayMinutes * 60_000
            : nextAtTime(input.atTime, now)
        if (runAt === null) return yield* new InvalidTaskError({ message: 'atTime must be a local "HH:MM" time.' })

        // Empty (or omitted) means every system; explicit IDs must all belong to the pool.
        const ids = [...new Set(input.systemIDs ?? [])]
        for (const id of ids) {
          if (!sistemas.some((candidate) => candidate.id === id)) return yield* new SystemNotFoundError({ systemID: id })
        }

        const task: Trading.Task = {
          id: Trading.TaskID.create(),
          kind: input.kind,
          system_ids: ids,
          run_at: runAt,
          status: "pending",
          resolved_at: null,
          time_created: now,
          time_updated: now,
        }
        yield* db
          .insert(TradingTaskTable)
          .values({
            id: task.id,
            kind: task.kind,
            system_ids: [...task.system_ids],
            run_at: task.run_at,
            status: task.status,
            resolved_at: null,
            time_created: task.time_created,
            time_updated: task.time_updated,
          })
          .run()
          .pipe(Effect.orDie)
        const alcance = ids.length === 0 ? "todos los sistemas" : ids.join(", ")
        pushLog(
          "info",
          "motor",
          `Scheduled task · ${input.kind === "start-systems" ? "start" : "stop"} ${alcance} at ${fmtHora(runAt)}`,
          { message_key: "trading.log.task.scheduled", message_params: { kind: input.kind, scope: alcance, time: fmtHora(runAt) } },
        )
        yield* refreshTasks
        return task
      })

      const taskCancel = Effect.fn("TradingEngine.taskCancel")(function* (id: Trading.TaskID) {
        const rows = yield* db.select().from(TradingTaskTable).where(eq(TradingTaskTable.id, id)).all().pipe(Effect.orDie)
        const row = rows[0]
        if (!row) return yield* new TaskNotFoundError({ taskID: id })
        if (row.status !== "pending") return yield* new InvalidTaskError({ message: "Only pending tasks can be cancelled." })
        const stamp = Date.now()
        yield* db
          .update(TradingTaskTable)
          .set({ status: "cancelled", resolved_at: stamp, time_updated: stamp })
          .where(eq(TradingTaskTable.id, id))
          .run()
          .pipe(Effect.orDie)
        pushLog("info", "motor", `Task cancelled · was scheduled for ${fmtHora(row.run_at)}`, { message_key: "trading.log.task.cancelled", message_params: { time: fmtHora(row.run_at) } })
        yield* refreshTasks
        return toSchemaTask({ ...row, status: "cancelled", resolved_at: stamp, time_updated: stamp })
      })

      /** The expiry loop: marks overdue-at-boot tasks missed honestly, then fires due tasks forever. */
      const reconcileAtBoot = Effect.gen(function* () {
        const now = Date.now()
        const overdue = yield* db
          .select({ id: TradingTaskTable.id })
          .from(TradingTaskTable)
          .where(and(eq(TradingTaskTable.status, "pending"), lte(TradingTaskTable.run_at, now)))
          .all()
          .pipe(Effect.orDie)

        if (overdue.length === 0) return
        // A task that fell due while the app was closed is skipped, never fired late in a burst.
        const stamp = Date.now()
        yield* db
          .update(TradingTaskTable)
          .set({ status: "missed", resolved_at: stamp, time_updated: stamp })
          .where(and(eq(TradingTaskTable.status, "pending"), lte(TradingTaskTable.run_at, now)))
          .run()
          .pipe(Effect.orDie)
        pushLog(
          "warning",
          "motor",
          `${overdue.length} scheduled task(s) expired while the app was closed · marked not executed`,
          { message_key: "trading.log.task.overdue", message_params: { count: overdue.length } },
        )
        yield* refreshTasks
      })

      /** Reconciles the remembered-accounts table with the maps: a discovered id stays
       * remembered under the link (the map's oldest first, the primary's own), its
       * last-known kind riding along; a row whose link has left the registry forgets
       * itself. A kept row whose account is absent from every link's map is the point —
       * the link is between sessions (TWS closed, a bridge chasing) and the sidebar keeps
       * listing the account, switchable, until the link reads it again. */
      const sincronizarCuentas = Effect.fn("TradingEngine.sincronizarCuentas")(function* () {
        const escribe: Array<{ id: string; linkID: string; tipo: string | null }> = []
        const vivos = new Set<string>()
        for (const enlace of enlaces.values()) {
          for (const [id, estado] of enlace.cuentas) {
            if (vivos.has(id)) continue
            vivos.add(id)
            const previa = recordadas.get(id)
            if (previa !== undefined && previa.linkID === enlace.id && previa.tipo === estado.tipo) continue
            recordadas.set(id, { linkID: enlace.id, tipo: estado.tipo })
            escribe.push({ id, linkID: enlace.id, tipo: estado.tipo })
          }
        }
        // Forgets by scanning the table itself, not just the mirror: a row whose link is
        // gone (removed while the engine was off, or a boot that never restored it) is
        // cleaned up here even when the mirror never saw it.
        const filasOlvidar = yield* db.select().from(TradingAccountTable).all().pipe(Effect.orDie)
        for (const fila of filasOlvidar) {
          if (enlaces.has(fila.link_id)) continue
          recordadas.delete(fila.id)
          yield* db.delete(TradingAccountTable).where(eq(TradingAccountTable.id, fila.id)).run().pipe(Effect.orDie)
        }
        for (const fila of escribe) {
          const stamp = Date.now()
          yield* db
            .insert(TradingAccountTable)
            .values({ id: fila.id, link_id: fila.linkID, tipo: fila.tipo, time_created: stamp, time_updated: stamp })
            .onConflictDoUpdate({
              target: TradingAccountTable.id,
              set: { link_id: fila.linkID, tipo: fila.tipo, time_updated: stamp },
            })
            .run()
            .pipe(Effect.orDie)
        }
      })

      /** The tick's lease: one row in `trading_meta` ("bucle-motor") names its holder and
       * its last heartbeat. Every server process builds the engine, but the tick's
       * duties — the scheduled tasks, the sweep, the equity — run on the
       * holder only, so no duty ever runs twice from two processes. A boot claims the row
       * right away (a restarted server never waits), a live holder renews every tick, and
       * a silent holder loses it after 30 s of silence. */
      const TITULAR_BUCLE = `proceso-${process.pid}-${Math.random().toString(36).slice(2, 10)}`
      const rentaBucle = Effect.fn("TradingEngine.rentaBucle")(function* () {
        const stamp = Date.now()
        const filas = yield* db.select().from(TradingMetaTable).where(eq(TradingMetaTable.id, "bucle-motor")).all().pipe(Effect.orDie)
        const fila = filas[0]
        if (fila === undefined || fila.value === TITULAR_BUCLE) {
          yield* db
            .insert(TradingMetaTable)
            .values({ id: "bucle-motor", value: TITULAR_BUCLE, time_created: stamp, time_updated: stamp })
            .onConflictDoUpdate({ target: TradingMetaTable.id, set: { value: TITULAR_BUCLE, time_updated: stamp } })
            .run()
            .pipe(Effect.orDie)
          return true
        }
        if (stamp - fila.time_updated <= 30_000) return false
        // The holder went silent: claim the lease optimistically — the update only lands
        // while the row still names that dead holder, so a refreshed holder keeps its own,
        // and `.returning()` names the winner without a second read.
        const cobrados = yield* db
          .update(TradingMetaTable)
          .set({ value: TITULAR_BUCLE, time_updated: stamp })
          .where(and(eq(TradingMetaTable.id, "bucle-motor"), eq(TradingMetaTable.value, fila.value)))
          .returning({ id: TradingMetaTable.id })
          .all()
          .pipe(Effect.orDie)
        return cobrados.length > 0
      })

      /** One scheduled task's step as a boolean: true is a confirmed start/stop, false is
       * any fault (including the task's system id being gone — logged, not thrown). */
      const pasoDeTarea = (kind: Trading.TaskKind, id: string): Effect.Effect<boolean> =>
        (kind === "start-systems"
          ? arrancarNucleo(id, "task").pipe(Effect.map((salida) => salida.ok))
          : pararBot(id, "task").pipe(Effect.map((salida) => salida.stopped))
        ).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              if (error._tag === "TradingEngine.SystemNotFound")
        pushLog("error", "motor", `Task with unknown system (${error.systemID})`, { message_key: "trading.log.task.unknown_system", message_params: { systemID: error.systemID } })
        else pushLog("error", "motor", `Task failed on system ${id}: ${error.message}`, { message_key: "trading.log.task.system_failed", message_params: { system: id, error: error.message } })
              return false
            }),
          ),
        )

      const tick = Effect.fn("TradingEngine.tick")(function* () {
        // The duties below run on the lease holder's process alone; a second server
        // process's tick just sleeps through (its HTTP handlers keep working).
        if (!(yield* rentaBucle())) return
        // The first tick that holds the lease starts the primary socket's chase on its own, so
        // the desk reads when TWS is already open. It opens nothing — the user's Conectar is
        // the only thing that opens a program.
        if (!arranque.hecho) {
          arranque.hecho = true
          yield* ponerEnMarcha
        }
        yield* Effect.promise(revisarProgramas)
        // Bots first: one tail pass of every running bot's record, plus the 45 s state sweep.
        yield* Effect.promise(() => Promise.all(sistemas.filter((def) => def.dir !== null).map((def) => ingestaUna(def))))
        yield* Effect.promise(() => sondear())
        yield* Effect.sync(muestrearEquity)
        yield* sincronizarCuentas()
        yield* revalidarCuentaActiva()
        // Re-rent before the task batch and again between its rows: a big pool's logs, probes
        // and starts/stops can outlast the 30 s window, and a turn that runs silent meanwhile
        // hands the lease to another process, whose tick would run the same duties in
        // parallel. Losing the lease mid-batch stops here — whatever is left stays pending
        // for the new holder's tick.
        if (!(yield* rentaBucle())) return
        const due = yield* db
          .select()
          .from(TradingTaskTable)
          .where(and(eq(TradingTaskTable.status, "pending"), lte(TradingTaskTable.run_at, Date.now())))
          .all()
          .pipe(Effect.orDie)
        if (due.length === 0) return
        for (const row of due) {
          if (!(yield* rentaBucle())) break
          let fallos = 0
          let cesado = false
          for (const id of row.system_ids.length === 0 ? sistemas.map((system) => system.id) : row.system_ids) {
            if (!(yield* pasoDeTarea(row.kind, id))) fallos += 1
            // A single row across a big pool can outlast the 30 s window by itself (starts
            // and stops sleep, the sweep probes spawn): re-rent between its systems too.
            // Losing the lease mid-row leaves the row pending for the next holder's tick —
            // the steps re-run idempotently (a running bot just reports as started).
            if (!(yield* rentaBucle())) {
              cesado = true
              break
            }
          }
          if (cesado) break
          const stamp = Date.now()
          // A task speaks its verdict: a launch or stop that failed is "failed", never "ran".
          yield* db
            .update(TradingTaskTable)
            .set({ status: fallos > 0 ? "failed" : "ran", resolved_at: stamp, time_updated: stamp })
            .where(eq(TradingTaskTable.id, row.id))
            .run()
            .pipe(Effect.orDie)
          if (fallos > 0)
        pushLog("error", "motor", `Task ${row.kind} ran with ${fallos} failed step(s)`, { message_key: "trading.log.task.failed_steps", message_params: { kind: row.kind, failed: fallos } })
        }
        yield* refreshTasks
      })

      /** An IB request turned into an outcome; a transport failure is a result, not a defect. */
      type ResultadoIb<T> = { ok: true; value: T } | { ok: false; error: string }
      const pedirLe = <T>(run: () => Promise<T>): Effect.Effect<ResultadoIb<T>> =>
        Effect.tryPromise({ try: run, catch: (error) => String(error) }).pipe(
          Effect.map((value) => ({ ok: true as const, value })),
          Effect.catch((error) => Effect.succeed({ ok: false as const, error: String(error) })),
        )

      const TERMINACIONES: ReadonlySet<string> = new Set([
        "Filled",
        "Cancelled",
        "ApiCancelled",
        "Inactive",
      ])

      const estadoDeOrden = (orderId: number): string | undefined => ordenesIds.get(orderId)?.status

      const llenadoDeOrden = (orderId: number): number => {
        const estado = ordenesIds.get(orderId)
        return estado && Number.isFinite(estado.filled) ? estado.filled : 0
      }

      /** TWS's word on one of the desk's own orders, asked fresh. The library's open-orders
       * stream ends after its first snapshot, so a status never arrives on its own: an order
       * still working reads from the open orders, and one gone from there reads from today's
       * executions — matched by id and by its own reference, since order ids restart with
       * every session. Enough executions make it Filled; an order in neither keeps its last
       * known state (unknown stays unknown). */
      const refrescarOrden = Effect.fn("TradingEngine.refrescarOrden")(function* (orderId: number, ref: string, cantidad: number) {
        const abiertas = yield* pedirLe(() => ib.getAllOpenOrders())
        const viva = abiertas.ok ? abiertas.value.find((orden) => orden.orderId === orderId && orden.order.orderRef === ref) : undefined
        if (viva !== undefined) {
          ordenesIds.set(orderId, { status: viva.orderStatus?.status ?? viva.orderState.status ?? "Submitted", filled: viva.orderStatus?.filled ?? 0 })
          return
        }
        const ejecuciones = yield* pedirLe(() => ib.getExecutionDetails({ clientId: String(clienteMotor) }))
        if (!ejecuciones.ok) return
        const llenado = ejecuciones.value
          .filter((detalle) => detalle.execution.orderId === orderId && detalle.execution.orderRef === ref)
          .reduce((suma, detalle) => suma + (detalle.execution.shares ?? 0), 0)
        if (llenado <= 0) return
        ordenesIds.set(orderId, { status: llenado >= cantidad ? "Filled" : (ordenesIds.get(orderId)?.status ?? "Submitted"), filled: llenado })
      })

      /** One full close cycle against one open position; the single close and the emergency
       * close-all both run this. Position contracts arrive lean — often without a real
       * exchange, which futures reject with error 200 — so before ordering, a definition
       * without a direct exchange is re-resolved by conId, the very repair the emergency
       * script (cierralotodo.py) proved live against TWS.
       *
       * The cycle's guards, each one added because money depends on it: one close in flight
       * per contract (a second request aborts instead of racing the first into a double
       * order), the position re-read right before the send, the desk's own orders cancelled
       * first (anything foreign aborts the close before a single cancel flies), and the OCA
       * fallback only leaves the gate after a positively confirmed terminal order state. */
      const cerrarUna = Effect.fn("TradingEngine.cerrarUna")(function* (posicion: Trading.Position, cuenta: string) {
        const symbol = posicion.symbol
        if (!enlacePrimaria.conectado) {
        pushLog("warning", "motor", `Close of ${symbol} · no connection to TWS, the close was not sent`, { message_key: "trading.log.close.no_tws", message_params: { symbol } })
          return { ok: false, message: "No connection to TWS: the close was not sent.", message_key: "trading.close.no_tws", message_params: {} }
        }
        // The cycle pinned the account before its first read — every order below names it on
        // the order itself, and no re-read here ever moves to another account mid-cycle.
        if (!(posicion.size > 0)) return { ok: false, message: `The position ${symbol} has no size to close.`, message_key: "trading.close.no_size", message_params: { symbol } }
        let contrato = contratos.value.get(symbol)
        if (!contrato || contrato.conId === undefined) {
          return { ok: false, message: `I don't have the full contract for ${symbol}: refresh the position and retry.`, message_key: "trading.close.no_contract", message_params: { symbol } }
        }
        const conId = contrato.conId
        // One close in flight per contract: a second request aborts with a clear verdict
        // instead of racing the first into double orders. The in-flight mark is dropped by a
        // finalizer, so interruption (panic or shutdown) cannot leave the contract locked.
        if (cierresEnVuelo.has(conId)) {
        pushLog("warning", "motor", `Close of ${symbol} · a close is already running for this contract; not duplicated`, { message_key: "trading.log.close.busy_contract", message_params: { symbol } })
          return { ok: false, message: `A close is already running for ${symbol}: wait for its verdict in the log.`, message_key: "trading.close.busy", message_params: { symbol } }
        }
        cierresEnVuelo.add(conId)
        return yield* Effect.ensuring(
          Effect.gen(function* () {
            if (!contrato || contrato.conId === undefined) {
              return { ok: false, message: `I don't have the full contract for ${symbol}: refresh the position and retry.`, message_key: "trading.close.no_contract", message_params: { symbol } }
            }
            if (!contrato.exchange || contrato.exchange === "SMART") {
              const base = contrato
              const resuelto = yield* pedirLe(async () => {
                const detalles = await ib.getContractDetails({
                  conId: base.conId,
                  symbol: base.symbol,
                  secType: base.secType,
                  lastTradeDateOrContractMonth: base.lastTradeDateOrContractMonth,
                  strike: base.strike,
                  right: base.right,
                  multiplier: base.multiplier,
                  currency: base.currency,
                  exchange: "",
                })
                const buscado = detalles.find((detalle) => detalle.contract.conId === base.conId)
                // The detail carries the price grid (`minTick`); the close's OCA limits
                // derive their offset from it when this call produced one.
                const conIdDetalle = base.conId
                const propio = buscado?.minTick
                if (conIdDetalle !== undefined && propio !== undefined && Number.isFinite(propio) && propio > 0)
                  ticksPorConId.set(conIdDetalle, propio)
                return buscado?.contract
              })
              if (!resuelto.ok) {
                return { ok: false, message: `Could not complete the definition of ${symbol}: ${resuelto.error}`, message_key: "trading.close.def_failed", message_params: { symbol, error: resuelto.error } }
              }
              if (!resuelto.value || resuelto.value.conId === undefined) {
                return { ok: false, message: `TWS did not return the full definition of ${symbol}: close it from TWS.`, message_key: "trading.close.def_incomplete", message_params: { symbol } }
              }
              contrato = contratoParaOrden(resuelto.value)
            }
            // The arrows below receive the narrowed contract through a stable const: a
            // mutable captured let loses its flow narrowing inside closures.
            const ordenador = contrato
            const tick = tickDeContrato(conId, symbol)
              pushLog(
                "info",
                "motor",
                `Close of ${symbol} · orders to account ${cuenta} (tick ${textoPrecio(tick, tick)})`,
                { message_key: "trading.log.close.orders_to_account", message_params: { symbol, account: cuenta, tick: textoPrecio(tick, tick) } },
              )

            // A stray stop or target could fill after the close and reopen the opposite
            // position, so the desk's own open orders on this contract go first. Orders
            // foreign to this desk — a manual stop in TWS, a running bot's guard — abort the
            // close here, before anything is cancelled: a missed close must never cost the
            // position its protections.
            const activasDeEste = (orden: OpenOrder) =>
              orden.contract.conId === conId && !TERMINACIONES.has(orden.orderStatus?.status ?? orden.orderState.status)
            const propiaRef = (orden: OpenOrder) => (orden.order.orderRef ?? "").startsWith("escritorio-cierre")
            const leidas = yield* pedirLe(() => ib.getAllOpenOrders())
            if (!leidas.ok) return { ok: false, message: `Could not read the open orders: ${leidas.error}`, message_key: "trading.close.read_orders_failed", message_params: { error: leidas.error } }
            const pendientes = leidas.value.filter(activasDeEste)
            const ajenas = pendientes.filter((orden) => !propiaRef(orden))
            if (ajenas.length > 0) {
              const quien = [...new Set(ajenas.map((orden) => orden.order.orderRef?.trim() || "orden sin referencia"))].join(", ")
                pushLog(
                  "error",
                  "motor",
                  `Close of ${symbol} · ${ajenas.length} order(s) of the contract are not the desk's (${quien}): nothing foreign was cancelled and the close was not sent`,
                  { message_key: "trading.log.close.foreign_orders", message_params: { symbol, count: ajenas.length, who: quien } },
                )
              return {
                ok: false,
                message: `Not closed: ${symbol} has ${ajenas.length} open order(s) that are not the desk's (${quien}). Cancel them in TWS (or stop the bot that placed them) and retry.`, message_key: "trading.close.foreign_orders", message_params: { symbol, count: ajenas.length, who: quien },
              }
            }
            let canceladas = 0
            if (pendientes.length > 0) {
              for (const orden of pendientes) ib.cancelOrder(orden.orderId)
              yield* Effect.sleep(500)
              const releidas = yield* pedirLe(() => ib.getAllOpenOrders())
              if (!releidas.ok) {
                return { ok: false, message: `Could not verify the cancellation: ${releidas.error}`, message_key: "trading.close.cancel_verify_failed", message_params: { error: releidas.error } }
              }
              const restantes = releidas.value.filter(activasDeEste)
              if (restantes.length > 0) {
                  pushLog(
                    "error",
                    "motor",
                    `Close of ${symbol} · ${restantes.length} own order(s) remain without confirmed cancellation, no order was sent`,
                    { message_key: "trading.log.close.cancel_pending", message_params: { symbol, count: restantes.length } },
                  )
                return {
                  ok: false,
                  message: `Not closed: ${restantes.length} desk order(s) on ${symbol} remain without confirmed cancellation. Cancel them in TWS and retry.`, message_key: "trading.close.cancel_pending", message_params: { symbol, count: restantes.length },
                }
              }
              canceladas = pendientes.length
            }
            const extra = canceladas > 0 ? ` · ${canceladas} orden(es) propia(s) cancelada(s)` : ""
            const veredictoCierre = (mensaje: string, nivel: Trading.LogLevel) => {
        pushLog(nivel, "motor", `Close of ${symbol}${extra} · ${mensaje}`, { message_key: "trading.log.close.progress", message_params: { symbol, extra, message: mensaje } })
            }

            // The close re-reads the live position one last time right before ordering: the
            // reads, the cancels and the sleeps above span seconds, and a TWS fill, a running
            // bot or a human may have closed or changed it meanwhile — ordering a stale size
            // would send the opposite side and open, not close.
            const viva = posicionesDeMotor(cuenta).find((candidata) => candidata.symbol === symbol)
            if (viva === undefined) {
              veredictoCierre("la posición desapareció durante la preparación · nada que cerrar", "info")
              return { ok: true, message: `The position of ${symbol} is no longer open: it closed while preparing the close${extra}.`, message_key: "trading.close.gone_while_prep", message_params: { symbol, extra } }
            }
            if (viva.side !== posicion.side || viva.size !== posicion.size) {
              veredictoCierre("la posición cambió de lado o de tamaño durante la preparación · no se envió orden alguna", "warning")
              return {
                ok: false,
                message: `Not closed: the position of ${symbol} changed side or size while preparing. Check Orders and retry if still open.`, message_key: "trading.close.changed_while_prep", message_params: { symbol },
              }
            }
            const accion = viva.side === "long" ? OrderAction.SELL : OrderAction.BUY
            const cantidad = viva.size

            // The close itself: the opposite side, full size, allowed outside regular hours.
            // The reference carries the contract, the moment and the conId, so a repeated
            // submission is recognisable and never collides with another close's orders.
            // `transmit` is stated on every order: the library sends an unset flag as an empty
            // field, which TWS reads as "hold, don't transmit", and then discards the order
            // (error 202, nothing ever reaches the market).
            const sello = Date.now()
            const ordenMercado: Order = {
              action: accion,
              totalQuantity: cantidad,
              orderType: OrderType.MKT,
              tif: TimeInForce.DAY,
              orderRef: `escritorio-cierre-${conId}-${sello}`,
              outsideRth: true,
              transmit: true,
              account: cuenta,
            }

            let idMercado: number | undefined
            let errorMercado = ""
            const salida = yield* pedirLe(() => ib.placeNewOrder(ordenador, ordenMercado))
            if (salida.ok) {
              idMercado = salida.value
              ordenesPropias.add(salida.value)
            } else errorMercado = salida.error
            let estadoMercado: string | undefined = undefined

            // TWS usually judges an order instantly, but the margin lets a rejection or a fill arrive.
            const refMercado = ordenMercado.orderRef ?? ""
            // A paper or thin market can take seconds to fill a market order (a live run on the
            // paper account filled after ~3 s): the wait runs up to five seconds, and the position
            // leaving TWS's own stream counts as the fill when the order's state lags behind it.
            const posiciónFuera = () => !posicionesDeMotor(cuenta).some((fila) => fila.symbol === symbol && fila.size > 0)
            for (let paso = 0; idMercado !== undefined && paso < 20; paso++) {
              yield* Effect.sleep(250)
              yield* refrescarOrden(idMercado, refMercado, cantidad)
              estadoMercado = estadoDeOrden(idMercado)
              if (estadoMercado !== "Filled" && posiciónFuera()) estadoMercado = "Filled"
              if (estadoMercado !== undefined && TERMINACIONES.has(estadoMercado)) break
            }
            if (idMercado !== undefined && estadoMercado !== "Filled") estadoMercado = estadoDeOrden(idMercado)

            // A refused market order names TWS's own reason in every verdict that follows.
            const rechazoMercado = idMercado === undefined ? undefined : rechazosOrden.get(idMercado)
            if (rechazoMercado !== undefined) {
              errorMercado = rechazoMercado
        pushLog("error", "motor", `Close of ${symbol} · TWS rejected the market order ${idMercado}: ${rechazoMercado}`, { message_key: "trading.log.close.market_rejected", message_params: { symbol, order: idMercado, reason: rechazoMercado } })
            }

            if (estadoMercado === "Filled") {
              veredictoCierre(`ejecutado · ${accion} ${cantidad} (orden ${idMercado})`, "info")
              return {
                ok: true,
                message: `Close executed: ${accion} ${cantidad} ${symbol} (order ${idMercado})${extra}.`, message_key: "trading.close.executed_market", message_params: { action: accion, quantity: cantidad, symbol, order: idMercado, extra },
              }
            }

            // The market order is still alive — or its state is unknown, which may hide a
            // working order: the OCA limits can only go out once the cancellation — or a
            // terminal state — is positively confirmed, or both could fill and open an
            // opposite position. An unknown state aborts with the rest.
            if (idMercado !== undefined && (estadoMercado === undefined || !TERMINACIONES.has(estadoMercado))) {
              ib.cancelOrder(idMercado)
              for (let paso = 0; paso < 20; paso++) {
                yield* refrescarOrden(idMercado, refMercado, cantidad)
                estadoMercado = estadoDeOrden(idMercado)
                if (estadoMercado === "Filled" || posiciónFuera()) {
                  veredictoCierre(`la orden a mercado acabó cubriendo la posición (orden ${idMercado})`, "info")
                  return {
                    ok: true,
                    message: `Close executed: order ${idMercado} of ${symbol}.`, message_key: "trading.close.executed_order", message_params: { order: idMercado, symbol },
                  }
                }
                if (estadoMercado !== undefined && TERMINACIONES.has(estadoMercado)) break
                yield* Effect.sleep(250)
              }
              estadoMercado = estadoDeOrden(idMercado)
              if (estadoMercado !== "Filled" && (estadoMercado === undefined || !TERMINACIONES.has(estadoMercado))) {
                veredictoCierre(
                  `la orden a mercado ${idMercado} no se ejecutó y no se pudo cancelar (estado ${estadoMercado ?? "desconocido"}) · sin límites para evitar un doble cierre`,
                  "error",
                )
                return {
                  ok: false,
                  message: `The market order of ${symbol} did not execute and could not be cancelled (state ${estadoMercado ?? "unknown"}). No limits were sent to avoid a double close; check Orders and TWS.`, message_key: "trading.close.market_not_cancelled", message_params: { symbol, state: estadoMercado ?? "unknown" },
                }
              }
            }

            // The market order is done, and its state is terminal — or absent (a failed send).
            // Whatever it left open goes into two OCA limits a few ticks either side of the
            // last known price: one fills, the other cancels (OCA) and nothing reopens.
            const llenado = idMercado !== undefined ? llenadoDeOrden(idMercado) : 0
            let restante = cantidad - Math.min(cantidad, llenado)
            if (restante <= 0) {
              veredictoCierre("la posición quedó cerrada durante el envío", "info")
              return { ok: true, message: `The position of ${symbol} closed during the send${extra}.`, message_key: "trading.close.closed_during_send", message_params: { symbol, extra } }
            }
            // The wait above spans seconds: only the live position tells the remaining size
            // truth, so a fill or an outside close never gets re-ordered.
            const vivaFinal = posicionesDeMotor(cuenta).find((candidata) => candidata.symbol === symbol)
            if (vivaFinal === undefined) {
              veredictoCierre("la posición desapareció durante la espera · cerrada", "info")
              return { ok: true, message: `The position of ${symbol} closed during the wait${extra}.`, message_key: "trading.close.closed_during_wait", message_params: { symbol, extra } }
            }
            if (vivaFinal.side !== posicion.side) {
              veredictoCierre("la posición cambió de lado durante la espera · sin límites", "error")
              return {
                ok: false,
                message: `No limits sent: the position of ${symbol} changed side during the wait. Check Orders and TWS.`, message_key: "trading.close.side_changed_wait", message_params: { symbol },
              }
            }
            restante = Math.min(restante, vivaFinal.size)
            if (restante <= 0) {
              veredictoCierre("la posición quedó cerrada durante la espera", "info")
              return { ok: true, message: `The position of ${symbol} closed during the wait${extra}.`, message_key: "trading.close.closed_during_wait", message_params: { symbol, extra } }
            }
            const precioActual = vivaFinal.current ?? posicion.current
            if (precioActual === null) {
              const motivo = errorMercado !== "" ? ` (${errorMercado})` : ` (estado ${estadoMercado ?? "desconocido"})`
              veredictoCierre(`TWS no aceptó el cierre a mercado${motivo}, sin precio actual para los límites`, "error")
              return {
                ok: false,
                message: `TWS did not accept the market close of ${symbol}${motivo} and there is no current price to compute the limits. Retry when a quote arrives or close it in TWS.`, message_key: "trading.close.no_price_for_limits", message_params: { symbol, reason: motivo },
              }
            }
            // A few ticks either side of the last price, on the contract's own tick grid: the
            // old ±1 point fallback was four-ish ticks on the index micros but hundreds of
            // ticks on USDJPY (and off every contract's real grid) — the offset derives from
            // the contract so the limits are marketable on the same grid everywhere.
            const salto = tick * 4
            const arriba = enRejilla(precioActual + salto, tick)
            const abajo = enRejilla(precioActual - salto, tick)
            if (!(abajo > 0) || !(arriba > abajo)) {
              veredictoCierre(`no pude calcular dos límites válidos alrededor de ${textoPrecio(precioActual, tick)}`, "error")
              return {
                ok: false,
                message: `I cannot compute two valid limits for ${symbol} around ${textoPrecio(precioActual, tick)}.`, message_key: "trading.close.invalid_limits", message_params: { symbol, price: textoPrecio(precioActual, tick) },
              }
            }
            const grupo = `cierre-${conId}-${sello}`
            const salidaLimites: { price: number; id: number | undefined; error: string }[] = []
            for (const precio of [arriba, abajo]) {
              const limite: Order = {
                action: accion,
                totalQuantity: restante,
                orderType: OrderType.LMT,
                lmtPrice: precio,
                tif: TimeInForce.GTC,
                orderRef: `escritorio-cierre-limite-${conId}-${sello}`,
                outsideRth: true,
                ocaGroup: grupo,
                ocaType: 1,
                transmit: true,
                account: cuenta,
              }
              const salio = yield* pedirLe(() => ib.placeNewOrder(ordenador, limite))
              if (salio.ok) {
                ordenesPropias.add(salio.value)
                salidaLimites.push({ price: precio, id: salio.value, error: "" })
              }
              else {
                salidaLimites.push({ price: precio, id: undefined, error: salio.error })
        pushLog("error", "motor", `Close of ${symbol} · TWS rejected the limit ${textoPrecio(precio, tick)}: ${salio.error}`, { message_key: "trading.log.close.limit_rejected", message_params: { symbol, price: textoPrecio(precio, tick), error: salio.error } })
              }
            }
            yield* Effect.sleep(500)
            for (const intento of salidaLimites)
              if (intento.id !== undefined) yield* refrescarOrden(intento.id, `escritorio-cierre-limite-${conId}-${sello}`, restante)
            const destinoMercado = errorMercado !== "" ? ` (${errorMercado})` : ` (estado ${estadoMercado ?? "desconocido"})`
            // A limit that already reached a terminal state is not working — the only
            // placements worth reporting as accepted are the ones still standing.
            const sigueActiva = (id: number): boolean => {
              const estado = estadoDeOrden(id)
              return estado === undefined || !TERMINACIONES.has(estado)
            }
            const aceptados = salidaLimites.filter((intento) => intento.id !== undefined && sigueActiva(intento.id))
            const rechazados = salidaLimites.filter((intento) => !aceptados.includes(intento))
            if (aceptados.length === 0 && !rechazados.some((intento) => intento.id !== undefined)) {
              veredictoCierre(`el cierre a mercado falló${destinoMercado} y TWS tampoco aceptó los límites`, "error")
              return { ok: false, message: `The market close of ${symbol} failed${destinoMercado} and TWS did not accept the limits either. Check Orders and TWS.`, message_key: "trading.close.market_failed_no_limits", message_params: { symbol, reason: destinoMercado } }
            }
            if (aceptados.length === 0) {
              const estados = rechazados
                .map((intento) => `${textoPrecio(intento.price, tick)}: ${intento.error !== "" ? intento.error : (rechazosOrden.get(intento.id as number) ?? estadoDeOrden(intento.id as number))}`)
                .join(", ")
              veredictoCierre(`el cierre a mercado falló${destinoMercado}; límites rechazados (${estados})`, "error")
              return { ok: false, message: `The market close of ${symbol} failed${destinoMercado} and TWS did not accept the limits (${estados}). Check Orders and TWS.`, message_key: "trading.close.market_failed_limits_rejected", message_params: { symbol, reason: destinoMercado, states: estados } }
            }
            const precios = aceptados.map((intento) => textoPrecio(intento.price, tick)).join(" y ")
            const ids = aceptados.map((intento) => String(intento.id)).join(", ")
            if (aceptados.length === 1) {
              veredictoCierre(
                `el cierre a mercado falló${destinoMercado}; enviado un límite ${accion} ${restante} a ${precios} GTC (orden ${ids})`,
                "warning",
              )
              return {
                ok: true,
                message: `El cierre a mercado falló${destinoMercado}; enviado un límite ${accion} ${restante} ${symbol} a ${precios} GTC (orden ${ids}). Revisa Órdenes.`,
              }
            }
            veredictoCierre(
              `el cierre a mercado falló${destinoMercado}; enviados 2 límites OCA ${accion} ${restante} a ${precios} (${ids}), uno cancela al otro`,
              "warning",
            )
            return {
              ok: true,
              message: `El cierre a mercado falló${destinoMercado}; enviados 2 límites OCA ${accion} ${restante} ${symbol} a ${precios} GTC (órdenes ${ids}). Uno cancela al otro. Revisa Órdenes.`,
            }
          }),
          Effect.sync(() => cierresEnVuelo.delete(conId)),
        )
      })

      /** The request verdict by id: repeating the same close submission inside a minute reads
       * its own earlier answer again instead of racing the first cycle into new orders. */
      const repetirVeredicto = (clave: string): Trading.PositionCloseResult | undefined => {
        for (const [candidata, valor] of cierresRecientes) if (valor.ts < Date.now() - 60_000) cierresRecientes.delete(candidata)
        return cierresRecientes.get(clave)?.salida
      }
      const recordarVeredicto = (clave: string, salida: Trading.PositionCloseResult) => {
        for (const [candidata, valor] of cierresRecientes) if (valor.ts < Date.now() - 60_000) cierresRecientes.delete(candidata)
        cierresRecientes.set(clave, { ts: Date.now(), salida })
      }

      /** Verdicts a cycle never produced itself: a claim absorbed after its window reads
       * as a session that died mid-close, and an exit without a result reads as a cycle the
       * interruption cut off. Both name the follow-up (TWS, Órdenes) — never a guess. */
      const veredictoVestigio = (symbol: string | null): Trading.PositionCloseResult => ({
        ok: false,
        message: symbol === null
          ? "The previous close-all left no verdict: its session died mid-cycle; check TWS and Orders before retrying."
          : `The previous close of ${symbol} left no verdict: its session died mid-cycle; check TWS and Orders before retrying.`,
        message_key: "trading.close.vestigio",
        message_params: symbol === null ? {} : { symbol },
      })
      const veredictoInterrumpido = (symbol: string | null): Trading.PositionCloseResult => ({
        ok: false,
        message: symbol === null
          ? "The close-all was interrupted before its verdict: check TWS and Orders."
          : `The close of ${symbol} was interrupted before its verdict: check TWS and Orders.`,
        message_key: "trading.close.interrupted",
        message_params: symbol === null ? {} : { symbol },
      })
      const veredictoOcupado = (symbol: string | null): Trading.PositionCloseResult => ({
        ok: false,
        message: symbol === null
          ? "A close-all is already running: wait for its verdict in the log."
          : `A close is already running for ${symbol}: wait for its verdict in the log.`,
        message_key: "trading.close.busy",
        message_params: symbol === null ? {} : { symbol },
      })
      const veredictoDbCaida = (symbol: string | null): Trading.PositionCloseResult => ({
        ok: false,
        message: symbol === null
          ? "The close-all was refused: the database is unavailable, so the close was not sent."
          : `The close of ${symbol} was refused: the database is unavailable, so the close was not sent.`,
        message_key: "trading.close.unverified",
        message_params: symbol === null ? {} : { symbol },
      })

      /** Claims the submission's durable row before any close runs. The own id resolves
       * first: a recorded verdict replays ("repetida"); an open row — this same submission
       * still running, or fresh from a session just dead — refuses without reordering
       * ("vestigio"); an own row past its window records the death verdict and frees the
       * lock before refusing (the submission never reorders past it). With no own row the
       * insert races the contract's lock (the mass row carries none): winning ("nueva")
       * grants the contract to this cycle, a fresh holder rejects the race ("ajena"), and
       * a holder past its window is absorbed the same way before the second pass grants it.
       * Database faults degrade to "fallida" — the caller refuses the close to avoid an unguarded cycle. */
      const reclamarCierreDb = (id: string, symbol: string | null, lockKey: string | null = symbol): Effect.Effect<ReclamoCierre, never, never> =>
        Effect.gen(function* () {
          for (let pasada = 0; pasada < 2; pasada++) {
            const propia = yield* db.select().from(TradingCloseTable).where(eq(TradingCloseTable.id, id)).get()
            if (propia !== undefined) {
              if (propia.verdict !== null) {
                try {
                  return { kind: "repetida", salida: JSON.parse(propia.verdict) as Trading.PositionCloseResult } satisfies ReclamoCierre
                } catch {
                  return { kind: "fallida" } satisfies ReclamoCierre
                }
              }
              if (Date.now() - propia.ts < VIGENCIA_RECLAMO_MS) {
                // Fresh: this submission is running right now (this very read is its repeat).
                // A repeat never reorders — its verdict is still to come.
                return { kind: "vestigio", salida: veredictoOcupado(symbol) } satisfies ReclamoCierre
              }
              yield* db
                .update(TradingCloseTable)
                .set({ verdict: JSON.stringify(veredictoVestigio(symbol)), lock: null, ts: Date.now(), time_updated: Date.now() })
                .where(eq(TradingCloseTable.id, id))
                .run()
              return { kind: "vestigio", salida: veredictoVestigio(symbol) } satisfies ReclamoCierre
            }
            const ahora = Date.now()
            const ganada = yield* db
              .insert(TradingCloseTable)
              .values({ id, symbol: symbol ?? "", lock: lockKey, verdict: null, ts: ahora, time_created: ahora, time_updated: ahora })
              .onConflictDoNothing()
              .returning({ id: TradingCloseTable.id })
              .all()
            if (ganada.length > 0) return { kind: "nueva" } satisfies ReclamoCierre
            // Lost: another claim holds this contract's lock (identical ids replay through
            // the own-row read above; the mass row holds none, so only a twin id races it —
            // the next pass's own-row read follows that one's verdict).
            if (symbol === null) continue
            const tenedor = yield* db.select().from(TradingCloseTable).where(eq(TradingCloseTable.lock, lockKey as string)).get()
            if (tenedor === undefined) continue
            if (Date.now() - tenedor.ts < VIGENCIA_RECLAMO_MS) return { kind: "ajena", salida: veredictoOcupado(symbol) } satisfies ReclamoCierre
            yield* db
              .update(TradingCloseTable)
              .set({ verdict: JSON.stringify(veredictoVestigio(symbol)), lock: null, ts: Date.now(), time_updated: Date.now() })
              .where(eq(TradingCloseTable.id, tenedor.id))
              .run()
          }
          // Two passes lost: a rival session re-claims this same id in lockstep with us.
          // Refusing is the only verdict that races nothing.
          return { kind: "ajena", salida: veredictoOcupado(symbol) } satisfies ReclamoCierre
        }).pipe(
          Effect.catch((error) => {
        pushLog("error", "motor", `Could not claim the close in the table (${String(error)}); the close was refused to avoid an unguarded cycle`, { message_key: "trading.log.close.claim_failed", message_params: { error: String(error) } })
            return Effect.succeed<ReclamoCierre>({ kind: "fallida" })
          }),
        )

      /** The claimed close's finalizer, run through `Effect.onExit` so the record never
       * misses: the exit's own verdict writes, and an exit without one (an interruption, a
       * defect) writes the synthetic verdict instead — either way the contract's lock
       * frees. Never fails: a broken database lands in the record while the cycle's own
       * verdict still reaches its caller. */
      const finalizarCierreDb = (id: string, exit: Exit.Exit<Trading.PositionCloseResult, unknown>, symbol: string | null) =>
        db
          .update(TradingCloseTable)
          .set({
            verdict: JSON.stringify(Exit.isSuccess(exit) ? exit.value : veredictoInterrumpido(symbol)),
            lock: null,
            ts: Date.now(),
            time_updated: Date.now(),
          })
          .where(eq(TradingCloseTable.id, id))
          .run()
          .pipe(
            Effect.catch((error) =>
              Effect.sync(() =>
        pushLog("error", "motor", `Could not record the close's verdict in the table: ${String(error)}`, { message_key: "trading.log.close.verdict_failed", message_params: { error: String(error) } }),
              ),
            ),
          )

      /** Why a close found nothing of its own to close. The positions it reads ride the TWS
       * socket, so a closed socket empties them: that is the honest reason then. (An MT5
       * account's rows close in its own terminal before this is ever asked.) */
      const sinPosicionQueCerrar = (symbol: string): Trading.PositionCloseResult => {
        if (!enlacePrimaria.conectado) return { ok: false, message: "No connection to TWS: the close was not sent.", message_key: "trading.close.no_tws", message_params: {} }
        return { ok: false, message: `The position ${symbol} is no longer open.`, message_key: "trading.close.gone", message_params: { symbol } }
      }

      // ------------------------------------------------- MT5 orders, manual orders ---------
      /** Closes every position an MT5 account holds on the symbol, in its own terminal. */
      const cerrarMT5 = (enlace: EnlaceMT5, symbol: string) =>
        Effect.gen(function* () {
        pushLog("info", "motor", `Close of ${symbol} · orders to the MetaTrader 5 terminal (${enlace.login})`, { message_key: "trading.log.close.mt5_orders", message_params: { symbol, login: enlace.login } })
          const salida = yield* Effect.promise(() =>
            ordenMT5(pythonwEjecutable, { accion: "cerrar", login: enlace.login, server: enlace.server, symbol }),
          )
        pushLog(salida.ok ? "info" : "error", "motor", `Close of ${symbol} · ${salida.message}`, { message_key: "trading.log.close.result", message_params: { symbol, message: salida.message } })
          return salida
        })

      /** Wraps `cerrarMT5` with a durable claim keyed by terminal+symbol, so two panic
        * passes (or a panic racing a manual close on the same terminal) never order twice. */
       const cerrarMT5ConReclamo = (enlace: EnlaceMT5, symbol: string) =>
         Effect.gen(function* () {
           const lockKey = `mt5:${enlace.login}@${enlace.server}:${symbol}`
           const idReclamo = `cierre:${symbol}:${selloAnonimo()}`
           const reclamo = yield* reclamarCierreDb(idReclamo, symbol, lockKey)
           if (reclamo.kind === "fallida") return veredictoDbCaida(symbol)
           if (reclamo.kind !== "nueva") {
             if (reclamo.kind === "vestigio") pushLog("warning", "motor", `Close of ${symbol} · its claim lives in the table: not reordered`, { message_key: "trading.log.close.vestigio_claim", message_params: { symbol } })
             else if (reclamo.kind === "ajena") pushLog("warning", "motor", `Close of ${symbol} · another claim holds the contract in the table: not duplicated`, { message_key: "trading.log.close.foreign_claim", message_params: { symbol } })
             return reclamo.salida
           }
           const ciclo = Effect.gen(function* () {
             return yield* cerrarMT5(enlace, symbol)
           })
           return yield* Effect.onExit(ciclo, (exit) => finalizarCierreDb(idReclamo, exit, symbol))
         })

       const closePosition = Effect.fn("TradingEngine.closePosition")(function* (symbol: string, requestId?: string) {
        const clave = requestId === undefined ? null : `cierre:${requestId}`
        // AE-012: account guards run before the idempotent replay, so a read-only IBKR watch
        // or a live MT5 terminal without the symbol never inherits the primary's earlier close verdict.
        const mt5CaidoGuard = [...enlaces.values()].find(
          (enlace) => enlace.broker === "mt5" && String(enlace.login) === cuentaActiva && !enlace.conectado,
        )
        if (mt5CaidoGuard?.broker === "mt5") {
          const salida = {
            ok: false,
            message: `The MetaTrader 5 bridge of account ${mt5CaidoGuard.login} is down${mt5CaidoGuard.motivo === null ? "" : ` (${mt5CaidoGuard.motivo})`}: I cannot see or close its positions now. Nothing was sent.`, message_key: "trading.close.mt5_bridge_down", message_params: { login: mt5CaidoGuard.login, reason: mt5CaidoGuard.motivo },
          }
        pushLog("warning", "motor", `Close of ${symbol} · ${salida.message}`, { message_key: "trading.log.close.warning", message_params: { symbol, message: salida.message } })
          if (clave !== null) recordarVeredicto(clave, salida)
          return salida
        }
        const activaGuard = cuentaActivaEstado()
        if (activaGuard?.enlace.broker === "mt5" && !activaGuard.enlace.posiciones.some((fila) => fila.symbol === symbol)) {
          const salida = { ok: false, message: `That account has no ${symbol}.`, message_key: "trading.close.account_no_symbol", message_params: { symbol } }
        pushLog("warning", "motor", `Close of ${symbol} · ${salida.message}`, { message_key: "trading.log.close.warning", message_params: { symbol, message: salida.message } })
          if (clave !== null) recordarVeredicto(clave, salida)
          return salida
        }
        if (activaGuard !== null && activaGuard.enlace.broker === "ibkr" && activaGuard.enlace.id !== clavePrimario) {
          const salida = { ok: false, message: `The shown account (${activaGuard.id}) is read-only: not closed from here.`, message_key: "trading.close.readonly_account", message_params: { account: activaGuard.id } }
        pushLog("warning", "motor", `Close of ${symbol} · ${salida.message}`, { message_key: "trading.log.close.warning", message_params: { symbol, message: salida.message } })
          if (clave !== null) recordarVeredicto(clave, salida)
          return salida
        }
        if (clave !== null) {
          const repetido = repetirVeredicto(clave)
          if (repetido !== undefined) return repetido
        }
        const idReclamo = clave ?? `cierre:${symbol}:${selloAnonimo()}`
        const activaClaim = cuentaActivaEstado()
         const lockKey =
           activaClaim?.enlace.broker === "mt5"
             ? `mt5:${activaClaim.enlace.login}@${activaClaim.enlace.server}:${symbol}`
             : symbol
         const reclamo = yield* reclamarCierreDb(idReclamo, symbol, lockKey)
        if (reclamo.kind === "fallida") {
          const salida = veredictoDbCaida(symbol)
          if (clave !== null) recordarVeredicto(clave, salida)
          return salida
        }
        if (reclamo.kind !== "nueva") {
        if (reclamo.kind === "vestigio") pushLog("warning", "motor", `Close of ${symbol} · its claim lives in the table: not reordered`, { message_key: "trading.log.close.vestigio_claim", message_params: { symbol } })
        else if (reclamo.kind === "ajena") pushLog("warning", "motor", `Close of ${symbol} · another claim holds the contract in the table: not duplicated`, { message_key: "trading.log.close.foreign_claim", message_params: { symbol } })
          return reclamo.salida
        }
        const ciclo = Effect.gen(function* () {
          // A fallen bridge drops its accounts, so the shown account no longer resolves through
          // them: found by its login instead, it refuses plainly rather than falling through to
          // TWS and answering "no longer open" about a position the terminal may still hold.
          const mt5Caido = [...enlaces.values()].find(
            (enlace) => enlace.broker === "mt5" && String(enlace.login) === cuentaActiva && !enlace.conectado,
          )
          if (mt5Caido?.broker === "mt5") {
            const salida = {
              ok: false,
              message: `The MetaTrader 5 bridge of account ${mt5Caido.login} is down${mt5Caido.motivo === null ? "" : ` (${mt5Caido.motivo})`}: I cannot see or close its positions now. Nothing was sent.`, message_key: "trading.close.mt5_bridge_down", message_params: { login: mt5Caido.login, reason: mt5Caido.motivo },
            }
        pushLog("warning", "motor", `Close of ${symbol} · ${salida.message}`, { message_key: "trading.log.close.warning", message_params: { symbol, message: salida.message } })
            if (clave !== null) recordarVeredicto(clave, salida)
            return salida
          }
          const activa = cuentaActivaEstado()
          if (activa?.enlace.broker === "mt5") {
            if (activa.enlace.posiciones.some((fila) => fila.symbol === symbol)) {
              const salida = yield* cerrarMT5(activa.enlace, symbol)
              if (clave !== null) recordarVeredicto(clave, salida)
              return salida
            }
            const salida = { ok: false, message: `That account has no ${symbol}.`, message_key: "trading.close.account_no_symbol", message_params: { symbol } }
        pushLog("warning", "motor", `Close of ${symbol} · ${salida.message}`, { message_key: "trading.log.close.warning", message_params: { symbol, message: salida.message } })
            if (clave !== null) recordarVeredicto(clave, salida)
            return salida
          }
          if (activa !== null && activa.enlace.broker === "ibkr" && activa.enlace.id !== clavePrimario) {
            const salida = { ok: false, message: `The shown account (${activa.id}) is read-only: not closed from here.`, message_key: "trading.close.readonly_account", message_params: { account: activa.id } }
        pushLog("warning", "motor", `Close of ${symbol} · ${salida.message}`, { message_key: "trading.log.close.warning", message_params: { symbol, message: salida.message } })
            if (clave !== null) recordarVeredicto(clave, salida)
            return salida
          }
          // A closed socket answers before anything else: a TWS loss empties the rows and
          // the close names that cause first. Then the cycle's own account is pinned once —
          // a mid-cycle change of the shown account must not move the re-reads to another
          // seat — and with no account known yet nothing goes out: the verdict says so
          // instead of the mistaken "no longer open" (the rows ride the socket).
          if (!enlacePrimaria.conectado) {
            const salida = { ok: false, message: "No connection to TWS: the close was not sent.", message_key: "trading.close.no_tws", message_params: {} }
            pushLog("warning", "motor", `Close of ${symbol} · no connection to TWS, the close was not sent`, { message_key: "trading.log.close.no_tws", message_params: { symbol } })
            if (clave !== null) recordarVeredicto(clave, salida)
            return salida
          }
          const cuenta = cuentaDeMotor()
          if (cuenta === null) {
            const salida = { ok: false, message: "No account determined: nothing was sent.", message_key: "trading.close.no_account", message_params: {} }
            pushLog("warning", "motor", `Close of ${symbol} · no account determined, nothing was sent`, { message_key: "trading.log.close.no_account", message_params: { symbol } })
            if (clave !== null) recordarVeredicto(clave, salida)
            return salida
          }
          const posicion = posicionesDeMotor(cuenta).find((candidata) => candidata.symbol === symbol)
          const salida = posicion ? yield* cerrarUna(posicion, cuenta) : sinPosicionQueCerrar(symbol)
          if (clave !== null) recordarVeredicto(clave, salida)
          return salida
        })
        return yield* Effect.onExit(ciclo, (exit) => finalizarCierreDb(idReclamo, exit, symbol))
      })

      /** The emergency close-all, ported from the script that rescued a stuck position: every
       * open position runs the full cycle in turn, one failure never stops the rest, and the
       * verdict lists each symbol's outcome for manual follow-up. The sweep stays inside the
       * engine's own account — `posicionesDeMotor()` — the way the order's own `account:` names
       * it: another account's row never joins the batch. The snapshot was a photo —
       * each turn re-reads the live row, a bot's mid-cycle newcomer gets a second pass's
       * turn, and the final verdict names whatever still reads open: the engine transmits
       * closes, TWS closes. The mass claim (no single contract to lock) plus a per-symbol
       * claim per pass make the whole sweep read-only against another session's sweep or a
       * single close already holding a contract. */
      const closeAllPositionsInterno = Effect.fn("TradingEngine.closeAllPositions")(function* (requestId?: string, conGuardas: boolean = true) {
        const clave = requestId === undefined ? null : `cierre-todo:${requestId}`
        // AE-012, as the single close: the shown account decides before the idempotent replay,
        // so an MT5 view or a read-only watch never inherits the primary's earlier close-all
        // verdict — and no endpoint path (tool, HTTP) can sweep positions it is not looking at.
        // The panic reaches this sweep with `conGuardas = false`: its job is everything on
        // the trading connection, so the view guards step aside — and a shown MT5 or watch
        // account rides no link of the primary's, so cuentaDeMotor still sweeps the primary's.
        const activaGuard = conGuardas ? cuentaActivaEstado() : null
        if (activaGuard?.enlace.broker === "mt5") {
          const salida = {
            ok: false,
            message: "The shown account is MetaTrader 5: this close-all sweeps the trading connection's account only. Close its rows one by one or use Panic, which closes every linked MetaTrader 5 account.",
            message_key: "trading.close.all_mt5_view",
            message_params: {},
          }
          pushLog("warning", "motor", `Close all · ${salida.message}`, { message_key: "trading.log.close_all.warning", message_params: { message: salida.message } })
          if (clave !== null) recordarVeredicto(clave, salida)
          return salida
        }
        if (activaGuard !== null && activaGuard.enlace.broker === "ibkr" && activaGuard.enlace.id !== clavePrimario) {
          const salida = { ok: false, message: `The shown account (${activaGuard.id}) is read-only: not closed from here.`, message_key: "trading.close.readonly_account", message_params: { account: activaGuard.id } }
          pushLog("warning", "motor", `Close all · ${salida.message}`, { message_key: "trading.log.close_all.warning", message_params: { message: salida.message } })
          if (clave !== null) recordarVeredicto(clave, salida)
          return salida
        }
        if (clave !== null) {
          const repetido = repetirVeredicto(clave)
          if (repetido !== undefined) return repetido
        }
        const idReclamo = clave ?? `cierre-todo:${selloAnonimo()}`
        const reclamo = yield* reclamarCierreDb(idReclamo, null)
        if (reclamo.kind === "fallida") {
          const salida = veredictoDbCaida(null)
          if (clave !== null) recordarVeredicto(clave, salida)
          return salida
        }
        if (reclamo.kind !== "nueva") {
        pushLog("warning", "motor", "Close all · its claim lives in the table: not reordered", { message_key: "trading.log.close_all.vestigio_claim", message_params: {} })
          return reclamo.salida
        }
        /** One symbol's full cycle behind its own claim: a rival holder (another session's
         * sweep, a single close already on this contract) skips the symbol with a verdict
         * the report carries, never orders over it. */
        const cerrarConReclamo = Effect.fn("TradingEngine.cerrarConReclamo")(function* (viva: Trading.Position, cuenta: string) {
          const reclamoSimbolo = yield* reclamarCierreDb(`${idReclamo}:${viva.symbol}`, viva.symbol)
          if (reclamoSimbolo.kind === "fallida") return veredictoDbCaida(viva.symbol)
          if (reclamoSimbolo.kind !== "nueva") {
        pushLog("warning", "motor", `Close all ${viva.symbol} · another claim holds the contract in the table: not duplicated`, { message_key: "trading.log.close_all.foreign_claim", message_params: { symbol: viva.symbol } })
            return reclamoSimbolo.salida
          }
          return yield* Effect.onExit(cerrarUna(viva, cuenta), (exit) => finalizarCierreDb(`${idReclamo}:${viva.symbol}`, exit, viva.symbol))
        })
        const ejecutar = Effect.gen(function* () {
          if (!enlacePrimaria.conectado) {
        pushLog("warning", "motor", "Close all · no connection to TWS, the close was not sent", { message_key: "trading.log.close_all.no_tws", message_params: {} })
            return { ok: false, message: "No connection to TWS: the close was not sent.", message_key: "trading.close.no_tws", message_params: {} }
          }
          // The sweep's account is pinned once here — after the socket's own cause — so a
          // mid-sweep change of the shown account must not move the re-reads to another
          // seat: every read and order below belongs to the account this sweep was ordered
          // against. With no account known yet, nothing is sent (an accountless order
          // would land on TWS's default account).
          const cuenta = cuentaDeMotor()
          if (cuenta === null) {
            pushLog("warning", "motor", "Close all · no account determined, nothing was sent", { message_key: "trading.log.close_all.no_account", message_params: {} })
            return { ok: false, message: "No account determined: nothing was sent.", message_key: "trading.close.no_account", message_params: {} }
          }
          const objetivo = posicionesDeMotor(cuenta).filter((pos) => pos.size > 0)
          if (objetivo.length === 0) {
        pushLog("info", "motor", "Close all · no open positions", { message_key: "trading.log.close_all.no_positions", message_params: {} })
            return { ok: true, message: "No open positions: nothing to close.", message_key: "trading.close.no_positions", message_params: {} }
          }
          const nombres = objetivo.map((pos) => pos.symbol).join(", ")
        pushLog("warning", "motor", `Close all · processing ${objetivo.length} position(s): ${nombres}`, { message_key: "trading.log.close_all.processing", message_params: { count: objetivo.length, symbols: nombres } })
          const veredictos: { symbol: string; salida: Trading.PositionCloseResult }[] = []
          for (const viva of objetivo) {
            // The list above was a photo: re-read the live row right before this one's turn.
            const real = posicionesDeMotor(cuenta).find((candidata) => candidata.symbol === viva.symbol)
            if (real === undefined || !(real.size > 0)) {
              veredictos.push({ symbol: viva.symbol, salida: { ok: true, message: `${viva.symbol}: already closed while waiting for its turn.`, message_key: "trading.close.closed_while_waiting_turn", message_params: { symbol: viva.symbol } } })
              continue
            }
            veredictos.push({ symbol: real.symbol, salida: yield* cerrarConReclamo(real, cuenta) })
          }
          // A bot opening mid-cycle evaded the first list: a second pass gives the newcomer
          // its turn (symbols already given a verdict never repeat); anything the bot still
          // opens after this pass sits in the report below rather than in another cycle.
          for (const nueva of posicionesDeMotor(cuenta).filter(
            (pos) => pos.size > 0 && !veredictos.some((veredicto) => veredicto.symbol === pos.symbol),
          )) {
            veredictos.push({ symbol: nueva.symbol, salida: yield* cerrarConReclamo(nueva, cuenta) })
          }
          const planos = veredictos.map((veredicto) => veredicto.salida.message).join(" ")
          const fallos = veredictos.filter((veredicto) => !veredicto.salida.ok)
          // The verdict counts closes TWS confirmed by absence: whatever still reads open
          // names itself, so a "transmitted" claim never passes for a "closed" one.
          const saltadas = posicionesDeMotor(cuenta).filter((pos) => pos.size > 0).map((pos) => pos.symbol)
          const restantes = saltadas.length > 0 ? ` Tras el ciclo, el motor todavía ve abiertas: ${saltadas.join(", ")}.` : ""
          if (fallos.length === 0) {
        pushLog("info", "motor", `Close all · ${veredictos.length} position(s) requested to TWS`, { message_key: "trading.log.close_all.requested", message_params: { count: veredictos.length } })
            return { ok: true, message: `Close requested for ${veredictos.length} position(s): ${planos}${restantes}`, message_key: "trading.close.all_requested", message_params: { count: veredictos.length, planos, restantes } }
          }
        pushLog(
            "error",
            "motor",
            `Close all · ${fallos.length} of ${veredictos.length} position(s) left unclosed: ${fallos.map((veredicto) => veredicto.symbol).join(", ")}`,
            { message_key: "trading.log.close_all.partial", message_params: { failed: fallos.length, total: veredictos.length, symbols: fallos.map((veredicto) => veredicto.symbol).join(", ") } },
          )
          return {
            ok: false,
            message: `Cierre solicitado: ${fallos.length} de ${veredictos.length} position(s) did not close (${
              fallos.map((veredicto) => veredicto.symbol).join(", ")
            }). ${planos}${restantes}`, message_key: "trading.close.all_partial", message_params: { failed: fallos.length, total: veredictos.length, symbols: fallos.map((v) => v.symbol).join(", "), planos, restantes },
          }
        })
        const conMemoria = Effect.tap(
          ejecutar,
          (salida) => (clave === null ? Effect.void : Effect.sync(() => recordarVeredicto(clave, salida))),
        )
        return yield* Effect.onExit(conMemoria, (exit) => finalizarCierreDb(idReclamo, exit, null))
      })

      /** Public close-all: always runs the view guards (AE-012). There is no way for a caller
       * to skip them — Panic uses the internal sweep instead. */
      const closeAllPositions = (requestId?: string) => closeAllPositionsInterno(requestId, true)

      /** The panic button: every running bot stops (the same pid-guarded kill path the user's
       * stop takes), every pending scheduled task cancels, and then the emergency close-all
       * runs over the IBKR positions and every linked MT5 account closes its own in its
       * terminal. Nothing re-arms itself: the systems stay stopped until the user starts them.
       * The summary only counts the bots it truly stopped. */
      const panic = Effect.fn("TradingEngine.panic")(function* () {
        pushLog("warning", "motor", "Panic · stopping every running bot, cancelling pending tasks and clearing open positions", { message_key: "trading.log.panic.start", message_params: {} })
        const { detenidos, fallos } = yield* detenerTodos("panic")
        const pendientes = yield* db.select().from(TradingTaskTable).where(eq(TradingTaskTable.status, "pending")).all().pipe(Effect.orDie)
        for (const fila of pendientes) {
          const stamp = Date.now()
          yield* db
            .update(TradingTaskTable)
            .set({ status: "cancelled", resolved_at: stamp, time_updated: stamp })
            .where(eq(TradingTaskTable.id, fila.id))
            .run()
            .pipe(Effect.orDie)
          pushLog("info", "motor", `Panic · pending task cancelled (${fila.kind})`, { message_key: "trading.log.panic.task_cancelled", message_params: { kind: fila.kind } })
        }
        if (pendientes.length > 0) yield* refreshTasks
        // The sweep skips the view guards (internal): a panic with an MT5 or read-only account
        // showing still closes everything the trading connection owns.
        const cierre = yield* closeAllPositionsInterno(undefined, false)
        // Every linked MT5 account closes its own positions, symbol by symbol, in its terminal.
        const cierresMT5: Trading.PositionCloseResult[] = []
        for (const enlace of enlaces.values()) {
          if (enlace.broker !== "mt5" || !enlace.conectado) continue
          for (const symbol of new Set(enlace.posiciones.map((fila) => fila.symbol))) cierresMT5.push(yield* cerrarMT5ConReclamo(enlace, symbol))
        }
        const mt5 = cierresMT5.length === 0 ? "" : ` MetaTrader 5: ${cierresMT5.map((salida) => salida.message).join(" · ")}`
        // Positions Panic does not close: IBKR accounts other than the engine's own, still open.
        // The params carry the still-open symbols and their count — the app words the line in its
        // own language; the raw message keeps the English phrase as every verdict's fallback.
        const cuentaMotor = cuentaDeMotor()
        const sobrantes = [...posicionesIbkr.entries()]
          .filter(([cuenta]) => cuenta !== cuentaMotor)
          .flatMap(([, filas]) => filas)
          .filter((pos) => pos.size > 0)
        const simbolosSobrantes = [...new Set(sobrantes.map((pos) => pos.symbol))]
        const leftover = simbolosSobrantes.length > 0 ? ` Still open in accounts Panic does not close: ${simbolosSobrantes.join(", ")}.` : ""
        const resumen = `Panic: ${detenidos.length} bot(s) stopped${
          fallos.length > 0 ? `, ${fallos.length} could not be stopped (${fallos.join(", ")})` : ""
        }${pendientes.length > 0 ? `, ${pendientes.length} task(s) cancelled` : ""}. ${cierre.message}${mt5}${leftover}`
        pushLog("warning", "motor", resumen, { message_key: "trading.panic.summary", message_params: { stopped: detenidos.length, failed: fallos.length, cancelled: pendientes.length, close: cierre.message, mt5: cierresMT5.map((salida) => salida.message).join(" · "), leftover_symbols: simbolosSobrantes.join(", "), leftover_count: simbolosSobrantes.length } })
        return { stopped: detenidos, close: cierre, message: resumen, message_key: "trading.panic.summary", message_params: { stopped: detenidos.length, failed: fallos.length, cancelled: pendientes.length, close: cierre.message, mt5: cierresMT5.map((salida) => salida.message).join(" · "), leftover_symbols: simbolosSobrantes.join(", "), leftover_count: simbolosSobrantes.length } }
      })

      /** Moves the pool to the folder the user picked: refused while a bot runs (its process
       * would be orphaned from the panel) or when the folder holds no `NN_name` systems; else
       * the pick is persisted and the pool reloads from it on the spot. */
      const poolSelect = Effect.fn("TradingEngine.poolSelect")(function* (dir: string) {
        const carpeta = dir.trim()

        if (carpeta === "") return yield* new InvalidTaskError({ message: "Pick a folder." })

        if (sistemas.some((def) => (bots.get(def.id)?.startedAt ?? null) !== null))
          return yield* new InvalidTaskError({ message: "Stop the running systems before switching the systems folder." })

        const carpetas = yield* Effect.promise(() => escanearCarpetas(carpeta))

        if (carpetas.length === 0)
          return yield* new InvalidTaskError({ message: `No systems in ${carpeta}: each system is a folder named NN_name holding its bot.py.` })

        const stamp = Date.now()
        yield* db
          .insert(TradingMetaTable)
          .values({ id: "carpeta-sistemas", value: carpeta, time_created: stamp, time_updated: stamp })
          .onConflictDoUpdate({ target: TradingMetaTable.id, set: { value: carpeta, time_updated: stamp } })
          .run()
          .pipe(Effect.orDie)
        carpetaPool.value = carpeta
        yield* Effect.promise(() => escanearArranque())
        pushLog("info", "motor", `Systems folder chosen: ${carpeta}`, { message_key: "trading.log.pool.chosen", message_params: { folder: carpeta } })

        return { dir: carpeta, systems: sistemas.length }
      })

      // The boot tries to take the tick's lease without clobbering a live holder: a server that
      // starts while another process is still ticking leaves the lease where it is and stays idle
      // for duties, so two processes never run the tick at once. A silent holder (over 30 s) is
      // taken over here — a restarted server resumes its duties at once, not at its first tick —
      // and a fresh row makes this server the holder. Every tick re-rents through `rentaBucle`
      // afterwards; this row write is the boot's head start, not a separate guarantee.
      const bootClaim = Date.now()
      const insertados = yield* db
        .insert(TradingMetaTable)
        .values({ id: "bucle-motor", value: TITULAR_BUCLE, time_created: bootClaim, time_updated: bootClaim })
        .onConflictDoNothing()
        .returning({ id: TradingMetaTable.id })
        .all()
        .pipe(Effect.orDie)
      if (insertados.length === 0) {
        const filas = yield* db.select().from(TradingMetaTable).where(eq(TradingMetaTable.id, "bucle-motor")).all().pipe(Effect.orDie)
        const fila = filas[0]
        if (fila !== undefined && fila.value !== TITULAR_BUCLE) {
          if (bootClaim - fila.time_updated > 30_000) {
            const tomados = yield* db
              .update(TradingMetaTable)
              .set({ value: TITULAR_BUCLE, time_updated: bootClaim })
              .where(and(eq(TradingMetaTable.id, "bucle-motor"), eq(TradingMetaTable.value, fila.value)))
              .returning({ id: TradingMetaTable.id })
              .all()
              .pipe(Effect.orDie)
            if (tomados.length === 0) {
              pushLog("info", "motor", "Another process won the tick lease; this server stays idle for duties.")
            }
          }
          if (bootClaim - fila.time_updated <= 30_000) {
            pushLog("info", "motor", "Tick lease held by another process; this server stays idle for duties.")
          }
        }
      }

      // Housekeeping: recorded verdicts age out after a day. Open claims never delete — a
      // stranded one is information (a close ran, verdict unknown) until the next close's
      // window passes and claims it over.
      yield* db
        .delete(TradingCloseTable)
        .where(and(isNotNull(TradingCloseTable.verdict), lte(TradingCloseTable.ts, Date.now() - VIGENCIA_VEREDICTO_MS)))
        .run()
        .pipe(
          Effect.catch((error) =>
        Effect.sync(() => pushLog("error", "motor", `Could not purge the closes table: ${String(error)}`, { message_key: "trading.log.close_table.purge_failed", message_params: { error: String(error) } })),
          ),
        )

      // The persisted folder (a pick or the one-time migration), when present, replaces the configured value.
      if (options.systemsDir === undefined) {
        const elegida = (yield* db.select().from(TradingMetaTable).where(eq(TradingMetaTable.id, "carpeta-sistemas")).all().pipe(Effect.orDie))[0]
        if (elegida) carpetaPool.value = elegida.value
      }

      yield* Effect.promise(() => escanearArranque())

      // Nothing kills the engine's loop for good: a boot fault or a tick fault (a database
      // hiccup, a filesystem error) lands in the record and the loop keeps its beat.
      const run: Effect.Effect<never> = reconcileAtBoot.pipe(
        Effect.catchCause((causa) =>
        Effect.sync(() => pushLog("error", "motor", `Engine startup failed: ${Cause.pretty(causa).slice(0, 500)}`, { message_key: "trading.log.engine.startup_failed", message_params: { cause: Cause.pretty(causa).slice(0, 500) } })),
        ),
        Effect.andThen(
          Effect.forever(
            tick().pipe(
              Effect.catchCause((causa) =>
                Effect.sync(() =>
        pushLog("error", "motor", `Engine loop failed and will retry: ${Cause.pretty(causa).slice(0, 500)}`, { message_key: "trading.log.engine.loop_failed", message_params: { cause: Cause.pretty(causa).slice(0, 500) } }),
                ),
              ),
              Effect.andThen(Effect.sleep("5 seconds")),
            ),
          ),
        ),
      )

      /** One account's wire view: its link carries the account (the panel uses it to pair
       * account and link chips), and the "IBKR demo/live" suffix reads its own id's DU
       * prefix plus its link's port — the same wording the single-account era showed. */
      const toSchemaAccountDe = (enlace: EnlaceIBKR, id: string, estado: EstadoCuenta): Trading.Account => ({
        id,
        type: `${estado.tipo ?? "cuenta"} · IBKR ${id.startsWith("DU") ? "demo" : "live"} (${enlace.port})`,
        cash: estado.efectivo,
        equity: estado.equity,
        pnl_day: estado.pnlDia,
        pnl_realized: estado.pnlRealizado,
        available_funds: estado.fondos,
        buying_power: estado.compraPoder,
        margin_used: estado.margen,
        excess_liquidity: estado.liquidez,
        updated_at: estado.actualizada,
        link: enlace.id,
      })

      /** An MT5 account's wire view: the terminal's trade mode and server name the type,
       * and `demo` hands the sidebar's dot the truth straight (no DU prefix to read). */
      const toSchemaAccountMT5 = (enlace: EnlaceMT5, id: string, estado: EstadoCuenta): Trading.Account => ({
        id,
        type: `MetaTrader 5 ${estado.tipo ?? "cuenta"} (${enlace.server})`,
        cash: estado.efectivo,
        equity: estado.equity,
        pnl_day: estado.pnlDia,
        pnl_realized: estado.pnlRealizado,
        available_funds: estado.fondos,
        buying_power: estado.compraPoder,
        margin_used: estado.margen,
        excess_liquidity: estado.liquidez,
        updated_at: estado.actualizada,
        link: enlace.id,
        /** The trade mode names the account kind; null until the bridge named one. */
        demo: estado.tipo === null ? null : estado.tipo !== "real",
      })

      /** The account view of the last received values (null until an account id arrives):
       * the dashboard's active account — the remembered selection, else the primary's first. */
      const toSchemaAccount = (): Trading.Account | null => {
        const activa = cuentaActivaEstado()
        if (activa === null) return null
        if (activa.enlace.broker === "mt5") return toSchemaAccountMT5(activa.enlace, activa.id, activa.estado)
        return toSchemaAccountDe(activa.enlace, activa.id, activa.estado)
      }

      /** The links' wire view, the primary first (map insertion order keeps that). An MT5
       * watch arrives identity-first: its login and server, no TWS address to name. */
      const toSchemaLink = (enlace: Enlace): Trading.Link => {
        const base = { id: enlace.id, label: enlace.etiqueta, broker: enlace.broker, connected: enlace.conectado }
        if (enlace.broker === "mt5") return { ...base, mt5_login: enlace.login, mt5_server: enlace.server }
        return { ...base, host: enlace.host, port: enlace.port }
      }

      /** Every account across the links, primary's first, ordered as discovered. */
      const toSchemaAccounts = (): Trading.Account[] =>
        [...enlaces.values()].flatMap((enlace) =>
          enlace.broker === "mt5"
            ? [...enlace.cuentas.entries()].map((par) => toSchemaAccountMT5(enlace, par[0], par[1]))
            : [...enlace.cuentas.entries()].map((par) => toSchemaAccountDe(enlace, par[0], par[1])),
        )

      /** Switches the dashboard's active account. The input must name an account one of the
       * engine's links has discovered; the selection persists and rides every snapshot. */
      const accountSelect = Effect.fn("TradingEngine.accountSelect")(function* (accountID: string) {
        const enlaceActiva = [...enlaces.values()].find((enlace) => enlace.cuentas.has(accountID))
        if (enlaceActiva === undefined) return yield* new InvalidTaskError({ message: `Unknown account: ${accountID}` })
        cuentaActiva = accountID
        // Selecting an account is the user consenting to that link's socket: bring it up
        // right away instead of leaving it to the 5 s tick. IBApiNext's connect only acts
        // when its state is Disconnected, so an attempt already in flight can never be
        // duplicated; the fixed client id keeps the re-connect id from drifting. An MT5
        // watch has no socket to consent to — its bridge chases the terminal on its own.
        if (enlaceActiva.broker === "ibkr" && !enlaceActiva.conectado)
          yield* Effect.sync(() => enlaceActiva.ib.connect(enlaceActiva.cliente))
        const stamp = Date.now()
        yield* db
          .insert(TradingMetaTable)
          .values({ id: "cuenta_activa", value: accountID, time_created: stamp, time_updated: stamp })
          .onConflictDoUpdate({ target: TradingMetaTable.id, set: { value: accountID, time_updated: stamp } })
          .run()
          .pipe(Effect.orDie)
        pushLog("info", "motor", `Active account: ${accountID} (${enlaceActiva.id})`, { message_key: "trading.log.account.active", message_params: { account: accountID, link: enlaceActiva.id } })
        return toSchemaAccount()
      })

      /** The user's own label, trimmed and capped: an enormous label breaks rows, pickers
       * and log lines alike. */
      const etiquetaDe = (label: string | undefined): string | null => {
        const texto = (label ?? "").trim().slice(0, 80)
        return texto === "" ? null : texto
      }

      /** Registers a watch: an extra IBKR TWS address chased as its own socket, or an MT5
       * registration whose sidecar bridge reads the terminal's account (the bridge attaches
       * to a terminal that is already running and never starts it). Duplicates are refused. The live
       * port takes the engine's gate too: the interface's dialog passes `live`, and a
       * direct API call must pass it as well — reading real balances still deserves
       * consent. */
      const linkAdd = Effect.fn("TradingEngine.linkAdd")(function* (input: LinkAddInput) {
        const broker = input.broker ?? "ibkr"
        if (broker === "mt5") {
          if (input.host !== undefined || input.port !== undefined || input.mt5Login === undefined || input.mt5Server === undefined)
            return yield* new InvalidTaskError({ message: "An MT5 link arrives with its login and server alone (no TWS address)." })
          if (!Number.isSafeInteger(input.mt5Login) || input.mt5Login < 1)
            return yield* new InvalidTaskError({ message: "An MT5 link needs its login (a positive whole number)." })
          const server = input.mt5Server.trim()
          if (server === "" || server.includes("@") || server.length > 80)
            return yield* new InvalidTaskError({ message: "An MT5 link needs its server name (up to 80 characters, no '@': the link id builds on it)." })
          const id = `mt5-${input.mt5Login}@${server}`
          if (enlaces.has(id)) return yield* new InvalidTaskError({ message: `Link ${id} is already registered.` })
          const enlace = yield* enlazarMT5(input.mt5Login, server, etiquetaDe(input.label), true)
          return toSchemaLink(enlace)
        }
        if (broker !== "ibkr")
          return yield* new InvalidTaskError({ message: `${broker} links arrive with that platform's read link (pending).` })
        if (input.mt5Login !== undefined || input.mt5Server !== undefined)
          return yield* new InvalidTaskError({ message: "An IBKR link takes no MT5 identity." })
        if (input.port === undefined)
          return yield* new InvalidTaskError({ message: "A TWS link needs its API port." })
        if (!Number.isSafeInteger(input.port) || input.port < 1 || input.port > 65_535)
          return yield* new InvalidTaskError({ message: "port must be a TCP port (1-65535)." })
        // TWS's live port gates itself: 7496 is the real-money API; its demo sibling (7497)
        // registers without a confirmation.
        if (PUERTOS_REALES.has(input.port) && input.live !== true)
          return yield* new InvalidTaskError({
            message: `Port ${input.port} is ${input.port === 4001 ? "IB Gateway" : "TWS"}'s live API: this request carried no confirmation. Repeat it with live: true once the user has confirmed.`,
          })
        // The link id builds on the host, so it keeps a label's discipline: trimmed, a plain
        // address, at most 80 characters.
        const hostEnlace = input.host === undefined ? host : input.host.trim()
        if (!hostTwsPermitido(hostEnlace)) return yield* new InvalidTaskError({ message: MENSAJE_HOST_TWS })
        const id = `${hostEnlace}:${input.port}`
        // The panel's own TWS address always collides in the map: the primary socket sits
        // there from boot (the Conectar button's door), so the plain duplicate guard would
        // dead-end the user with "already registered" while nothing is — this address can
        // never have a row either (a row reloading silently its own id at boot, and the
        // panel's link is never removable). The confirmation rode the request the way the
        // Conectar button carries it, so the ask is answered: the panel's own connect
        // starts now and nothing persists.
        if (id === clavePrimario) {
        pushLog("info", "motor", `Link ${id} is the panel's own address · no row to register: its connection starts from the Connect button's socket`, { message_key: "trading.log.link.self", message_params: { id } })
          yield* connect
          return toSchemaLink(enlacePrimaria)
        }
        if (enlaces.has(id)) return yield* new InvalidTaskError({ message: `Link ${id} is already registered.` })
        const enlace = yield* enlazar(hostEnlace, input.port, etiquetaDe(input.label), true)
        return toSchemaLink(enlace)
      })

      /** An MT5 watch from nothing to reading: the row saved and the sidecar bridge chasing
       * the terminal — the bridge attaches to a terminal that is already running (nothing
       * here ever starts it) and retries its read every 5 s. `persistir` writes the DB row
       * (a boot reload has one). */
      const enlazarMT5 = Effect.fn("TradingEngine.enlazarMT5")(function* (login: number, server: string, etiqueta: string | null, persistir: boolean) {
        const id = `mt5-${login}@${server}`
        const enlace = enlaceMt5Nueva(id, login, server, etiqueta)
        enlaces.set(id, enlace)
        if (persistir) {
          const stamp = Date.now()
          yield* db
            .insert(TradingLinkTable)
            .values({ id, host: "", port: 0, label: etiqueta, broker: "mt5", mt5_login: login, mt5_server: server, time_created: stamp, time_updated: stamp })
            .run()
            .pipe(Effect.orDie)
        }
        yield* Effect.sync(() => arrancarPuenteMT5(enlace))
        pushLog("info", "motor", `MT5 link ${id} ${persistir ? "registered" : "reloaded from the table"} · the Python bridge watches the terminal (retry every 5 s)`, { message_key: "trading.log.mt5.link_registered", message_params: { id, persisted: persistir } })
        return enlace
      })

      /** Spawns one sidecar bridge and restarts it while its link lives. The python handle
       * rides the link's own state; a bridge's exit event only reschedules the bridge it
       * still owns, so a removal (or the engine's shutdown nulling first) never respawns. */
      const arrancarPuenteMT5 = (enlace: EnlaceMT5) => {
        const id = enlace.id
        const child = spawn(pythonwEjecutable, ["-c", PUENTE_PY], {
          windowsHide: true,
          stdio: ["ignore", "pipe", "ignore"],
        })
        enlace.child = child
        if (child.stdout === null) {
        pushLog("error", "motor", `MT5 bridge ${id}: the Python bridge produced no output`, { message_key: "trading.log.mt5.no_output", message_params: { id } })
          return
        }
        const lineas = createInterface({ input: child.stdout, crlfDelay: Infinity })
        lineas.on("line", (linea) =>
          guard(`puente mt5 ${id}`, () => {
            const leyendo = leerPuente(linea)
            if (Option.isNone(leyendo)) {
        if (linea.trim() !== "") pushLog("warning", "motor", `MT5 bridge ${id}: line not understood`, { message_key: "trading.log.mt5.line_unknown", message_params: { id } })
              return
            }
            cuentaMT5Linea(enlace, leyendo.value)
          }),
        )
        /** One respawn in 5 s (30 s after a failed launch: a missing Python cannot fix itself
         * every 5 s), tracked so the shutdown finalizer can clear it. */
        const reprogramar = (ms: number) => {
          clearTimeout(reintentosPuente.get(id))
          reintentosPuente.set(
            id,
            setTimeout(() => {
              reintentosPuente.delete(id)
              if (apagadoMT5) return
              if (enlaces.has(id) && enlace.child === null) arrancarPuenteMT5(enlace)
            }, ms),
          )
        }
        child.on("error", (error) => {
          // A launch that never started may fire no exit at all: the link would stay without
          // a bridge for good. The error owns the retry then.
          if (enlace.motivo !== `spawn:${String(error)}`) {
            enlace.motivo = `spawn:${String(error)}`
            pushLog("error", "motor", `MT5 bridge ${id}: could not start the Python bridge (${pythonwEjecutable}): ${String(error)} · install Python and run \`pip install MetaTrader5\``, { message_key: "trading.log.mt5.bridge_start_failed", message_params: { id, error: String(error) } })
          }
          if (enlace.child !== child) return
          enlace.child = null
          reprogramar(30_000)
        })
        child.on("exit", (code) => {
          if (enlace.child !== child) return
          enlace.child = null
          if (enlace.conectado) {
            enlace.conectado = false
            // A fallen bridge can also be a closed terminal: a stale balance row reads as
            // live money, so the watch drops its own accounts until one arrives again.
            enlace.cuentas.clear()
            enlace.posiciones = []
            enlace.cierres = []
        pushLog("warning", "motor", `MT5 bridge ${id} down (code ${code ?? "unknown"}) · retrying every 5 s`, { message_key: "trading.log.mt5.bridge_down", message_params: { id, code: code ?? "unknown" } })
          }
          reprogramar(5_000)
        })
      }

      /** One bridge position onto the dashboard's position row. The percentage is the price's
       * own move in the position's favour (MT5 sends no contract multiplier to compute a
       * return on margin from). */
      const posicionMT5 = (posicion: NonNullable<Extract<typeof LineaPuenteMT5.Type, { type: "cuenta" }>["positions"]>[number]): Trading.Position => {
        const entrada = safeNumber(posicion.entry)
        const actual = safeNumber(posicion.current)
        const movimiento = entrada === null || actual === null || entrada === 0 ? null : ((actual - entrada) / entrada) * 100
        return {
          symbol: posicion.symbol,
          side: posicion.side,
          size: safeNumber(posicion.size) ?? 0,
          entry: entrada,
          current: actual,
          pnl: safeNumber(posicion.pnl),
          pnl_pct: movimiento === null ? null : posicion.side === "long" ? movimiento : -movimiento,
        }
      }

      /** One parsed bridge line's verdict: the watch's own login fills its account, a
       * terminal logged in as someone else says so in the record instead of feeding the
       * wrong account, and an unreached terminal (or none logged in) keeps the watch empty. */
      const cuentaMT5Linea = (enlace: EnlaceMT5, dato: typeof LineaPuenteMT5.Type) => {
        const id = enlace.id
        if (dato.type === "cuenta") {
          if (dato.login !== enlace.login || dato.server !== enlace.server) {
            const motivo = `El terminal está en la cuenta ${dato.login} (${dato.server}), no en la ${enlace.login}`
            if (motivo !== enlace.motivo) {
              enlace.motivo = motivo
        pushLog("warning", "motor", `MT5 bridge ${id}: ${motivo}`, { message_key: "trading.log.mt5.bridge_reason", message_params: { id, reason: motivo } })
            }
            return
          }
          enlace.motivo = null
          const idCuenta = String(dato.login)
          const previa = enlace.cuentas.get(idCuenta) !== undefined
          enlace.cuentas.set(idCuenta, {
            tipo: MODO_MT5[dato.trade_mode] ?? null,
            efectivo: safeNumber(dato.balance),
            equity: safeNumber(dato.equity),
            fondos: safeNumber(dato.margin_free),
            compraPoder: null,
            margen: safeNumber(dato.margin_used),
            liquidez: null,
            pnlDia: safeNumber(dato.pnl_day),
            pnlRealizado: safeNumber(dato.pnl_realized ?? null),
            actualizada: Date.now(),
            linkID: id,
          })
          enlace.posiciones = (dato.positions ?? []).map((posicion) => posicionMT5(posicion))
          enlace.cierres = (dato.closes ?? [])
            .map((cierre) => ({
              system: `MT5 ${idCuenta}`,
              ts: cierre.ts,
              pnl: safeNumber(cierre.pnl),
              message: `${cierre.symbol} · ${cierre.volume ?? "—"} @ ${cierre.price ?? "—"}`,
            }))
            .sort((a, b) => b.ts - a.ts)
          if (!previa)
            pushLog("info", "motor", `Account ${idCuenta} discovered on ${id} · MetaTrader 5 ${MODO_MT5[dato.trade_mode] ?? "account"}`, { message_key: "trading.log.mt5.account_discovered", message_params: { account: idCuenta, link: id, mode: MODO_MT5[dato.trade_mode] ?? "account" } })
          if (!enlace.conectado) {
            enlace.conectado = true
            pushLog("info", "motor", `MT5 bridge ${id} reading terminal (${dato.server})`, { message_key: "trading.log.mt5.bridge_reading", message_params: { id, server: dato.server } })
          }
          return
        }
        if (enlace.conectado) {
          enlace.conectado = false
          enlace.cuentas.clear()
          enlace.posiciones = []
          enlace.cierres = []
        }
        if (dato.motivo !== enlace.motivo) {
          enlace.motivo = dato.motivo
        pushLog("info", "motor", `MT5 bridge ${id}: ${dato.motivo}`, { message_key: "trading.log.mt5.bridge_info", message_params: { id, reason: dato.motivo } })
        }
      }

      // The stored links come back chasing: each registration's row is enough — the user
      // gave permission once, and a balance watch needs no further booting gate. An MT5 row
      // without its identity pair in the table can not be relinked; it refuses loudly.
      const filasEnlaces = yield* db.select().from(TradingLinkTable).orderBy(asc(TradingLinkTable.time_created)).all().pipe(Effect.orDie)
      for (const fila of filasEnlaces) {
        if (fila.id === clavePrimario || enlaces.has(fila.id)) continue
        if (fila.broker === "mt5") {
          if (fila.mt5_login === null || fila.mt5_login === undefined || fila.mt5_server === null || fila.mt5_server === undefined) {
        pushLog("warning", "motor", `MT5 link ${fila.id} has no login/server pair in the table: not reloaded`, { message_key: "trading.log.mt5.link_missing_pair", message_params: { id: fila.id } })
            continue
          }
          yield* enlazarMT5(fila.mt5_login, fila.mt5_server, etiquetaDe(fila.label ?? undefined), false)
          continue
        }
        const etiqueta = etiquetaDe(fila.label ?? undefined)
        if (!hostTwsPermitido(fila.host)) {
          const enlace = enlaceNueva(fila.id, fila.host, fila.port, etiqueta, 0, true)
          enlaces.set(fila.id, enlace)
          pushLog("warning", "motor", `Link ${fila.id} has a host not allowed (${fila.host}): loaded as blocked (AE-005)`, { message_key: "trading.log.link.blocked", message_params: { id: fila.id, host: fila.host } })
          continue
        }
        if (!Number.isSafeInteger(fila.port) || fila.port < 1 || fila.port > 65_535) {
          pushLog("warning", "motor", `Link ${fila.id} has an invalid port (${fila.port}): not reloaded`, { message_key: "trading.log.link.port_invalid", message_params: { id: fila.id, port: fila.port } })
          continue
        }
        yield* enlazar(fila.host, fila.port, etiqueta, false)
      }

      // The remembered accounts rejoin their links' lists before any live read: the facts
      // stay unset until the link Rediscovers them (TWS accepts, the bridge attaches), but
      // the accounting ids are there right away — the sidebar lists them and the user can
      // switch while the link is still between sessions. The remembered active selection
      // rides this too: its seed makes the panel show the account's own row already.
      const filasRecordadas = yield* db.select().from(TradingAccountTable).orderBy(asc(TradingAccountTable.time_created)).all().pipe(Effect.orDie)
      for (const fila of filasRecordadas) {
        const enlace = enlaces.get(fila.link_id)
        if (enlace === undefined) continue // a gone link's row: the next tick forgets it
        recordadas.set(fila.id, { linkID: fila.link_id, tipo: fila.tipo ?? null })
        if (!enlace.cuentas.has(fila.id))
          enlace.cuentas.set(fila.id, { ...vacioEstado(enlace), tipo: fila.tipo ?? null })
      }

      /** Withdraws a registered link: the IBKR socket drops (or the MT5 sidecar is stopped),
       * the row leaves the table and its accounts stop listing. The remembered selection
       * drops with it when the account it names has left every link. */
      const linkRemove = Effect.fn("TradingEngine.linkRemove")(function* (linkID: string) {
        if (linkID === clavePrimario) return yield* new InvalidTaskError({ message: "The panel's own TWS link cannot be removed." })
        const enlace = enlaces.get(linkID)
        if (enlace === undefined) {
          // A row may exist in the table even when the link is not in memory (e.g. a blocked
          // or not-loaded link): allow removing it by id. If no row exists, it is unknown.
          const filas = yield* db.select().from(TradingLinkTable).where(eq(TradingLinkTable.id, linkID)).all().pipe(Effect.orDie)
          if (filas.length === 0) return yield* new InvalidTaskError({ message: `Unknown link: ${linkID}` })
          yield* db.delete(TradingLinkTable).where(eq(TradingLinkTable.id, linkID)).run().pipe(Effect.orDie)
          for (const [id, recordada] of recordadas) if (recordada.linkID === linkID) recordadas.delete(id)
          yield* db.delete(TradingAccountTable).where(eq(TradingAccountTable.link_id, linkID)).run().pipe(Effect.orDie)
          if (cuentaActiva !== null) {
            const elegida = cuentaActiva
            const viva = [...enlaces.values()].some((restante) => restante.cuentas.has(elegida))
            if (!viva) {
              cuentaActiva = null
              yield* db.delete(TradingMetaTable).where(eq(TradingMetaTable.id, "cuenta_activa")).run().pipe(Effect.orDie)
            }
          }
          pushLog("info", "motor", `Link ${linkID} removed`, { message_key: "trading.log.link.removed", message_params: { id: linkID } })
          return [...enlaces.values()].map(toSchemaLink)
        }
        if (enlace.broker === "mt5") {
          // Nulled first so the process's exit event finds no owner and never respawns.
          const child = enlace.child
          enlace.child = null
          child?.kill()
        } else if (!enlace.bloqueado) {
          yield* Effect.sync(() => enlace.ib.disconnect())
        }
        enlaces.delete(linkID)
        yield* db.delete(TradingLinkTable).where(eq(TradingLinkTable.id, linkID)).run().pipe(Effect.orDie)
        // The link's remembered accounts forget themselves with it: nothing should keep
        // listing (or re-restoring) accounts the user asked the engine to stop watching.
        for (const [id, recordada] of recordadas) if (recordada.linkID === linkID) recordadas.delete(id)
        yield* db.delete(TradingAccountTable).where(eq(TradingAccountTable.link_id, linkID)).run().pipe(Effect.orDie)
        if (cuentaActiva !== null) {
          const elegida = cuentaActiva
          const viva = [...enlaces.values()].some((restante) => restante.cuentas.has(elegida))
          if (!viva) {
            cuentaActiva = null
            yield* db.delete(TradingMetaTable).where(eq(TradingMetaTable.id, "cuenta_activa")).run().pipe(Effect.orDie)
          }
        }
        pushLog("info", "motor", `Link ${linkID} removed`, { message_key: "trading.log.link.removed", message_params: { id: linkID } })
        return [...enlaces.values()].map(toSchemaLink)
      })

      /** The wizard's search: every account this computer's MetaTrader 5 terminals have on
       * record — the disk answers on its own, zero side effects — plus, only behind the
       * explicit probe, one live reading. A registered link already feeding its terminal
       * stands in for the probe (the spawned probe would attach to the same terminal it is
       * reading); nobody is feeding, the one-shot probe runs, and it opens the closed
       * terminal, which is why the live reading stays behind the wizard's own button. Read-only:
       * registering happens in linkAdd, never here. */
      /** The IBKR port search: the address given (the wizard's check before registering, on
       * the engine's own host when only a port arrives), else the four defaults on the engine's
       * host, all knocked in parallel. The address keeps linkAdd's discipline. */
      const ibkrDetect = Effect.fn("TradingEngine.ibkrDetect")(function* (input: { host?: string; port?: number }) {
        const hostPrueba = input.host === undefined ? host : input.host.trim()
        if (!hostTwsPermitido(hostPrueba)) return yield* new InvalidTaskError({ message: MENSAJE_HOST_TWS })
        if (input.port !== undefined && (!Number.isSafeInteger(input.port) || input.port < 1 || input.port > 65_535))
          return yield* new InvalidTaskError({ message: "port must be a TCP port (1-65535)." })
        const candidatos =
          input.port === undefined
            ? PUERTOS_IBKR.map((puerto) => ({ port: puerto.port, live: puerto.live }))
            : [
                (() => {
                  const conocido = PUERTOS_IBKR.find((puerto) => puerto.port === input.port)
                  return { port: input.port, live: conocido?.live ?? false }
                })(),
              ]
        return yield* Effect.promise(() =>
          Promise.all(
            candidatos.map(async (candidato): Promise<Trading.IbkrPort> => ({
              host: hostPrueba,
              port: candidato.port,
              live: candidato.live,
              open: await puertoAbierto(hostPrueba, candidato.port),
            })),
          ),
        )
      })

      const mt5Detect = Effect.fn("TradingEngine.mt5Detect")(function* (probe?: boolean) {
        const raiz = carpetaMetaQuotes(process.env.APPDATA ?? "")
        const disco = yield* Effect.promise(() => leerCuentasDisco(raiz))
        const porClave = new Map<string, Trading.Mt5Detected>()
        for (const fila of disco)
          porClave.set(`${fila.login}@${fila.server}`, {
            login: fila.login,
            server: fila.server,
            name: null,
            active: fila.active,
            live: false,
          })
        const ordenadas = () => [...porClave.values()].sort((a, b) => (a.active === b.active ? a.login - b.login : a.active ? -1 : 1))
        // Disk alone answers without touching the desktop: a closed terminal stays closed
        // until the user presses the live search (M-04).
        if (probe !== true) return ordenadas()
        const puente = [...enlaces.values()].find((enlace): enlace is EnlaceMT5 => enlace.broker === "mt5" && enlace.conectado)
        const vivo: DatoVivo | null =
          puente !== undefined
            ? { login: puente.login, server: puente.server, name: null }
            : yield* Effect.promise(() => sondearCuenta(pythonwEjecutable))
        if (vivo !== null) {
          const clave = `${vivo.login}@${vivo.server}`
          const previa = porClave.get(clave)
          porClave.set(clave, {
            login: vivo.login,
            server: vivo.server,
            name: vivo.name,
            active: previa?.active ?? false,
            live: true,
          })
        }
        // The terminal's own last login leads; ties read as the discovery's order.
        return ordenadas()
      })

      /** What the dashboard reads beside the account it shows: an MT5 account brings its own
       * terminal's positions and today's closes; anything else reads the trading connection's
       * positions and the bots' trades, as the desk always did. The curve is always the shown
       * account's own. */
      const lecturaVista = () => {
        const activa = cuentaActivaEstado()
        // The curve ends on the account's live figures, so it never trails the numbers above
        // it while a slow tick spaces the 15 s samples out.
        const muestras = activa === null ? [] : (curvas.get(activa.id) ?? [])
        const vivo =
          activa === null || (activa.estado.equity === null && activa.estado.pnlDia === null)
            ? []
            : [{ ts: Date.now(), equity: activa.estado.equity, pnl_day: activa.estado.pnlDia }]
        const curva = [...muestras, ...vivo]
        if (activa?.enlace.broker === "mt5") return { positions: activa.enlace.posiciones, trades: activa.enlace.cierres, equity: curva }
        // An IBKR account reads its own positions; the trading connection's flat list stands
        // in only until its first per-account update arrives.
        const propias = activa === null ? undefined : posicionesIbkr.get(activa.id)
        const filas = propias ?? (activa?.enlace.id === clavePrimario ? positions.value : [])
        return { positions: activa === null ? filas : conPreciosIbkr(activa.id, filas), trades: trades.value, equity: curva }
      }

      /** Every open position the engine can see, across every account and every connected
       * link: the desktop's quit gate (and any reader of the whole exposure) reads this, not
       * the shown account's `positions` — a multi-account login or a watching MT5 terminal
       * must not close the app over open rows this snapshot never named. */
      const abiertas = () =>
        [
          // The per-account map is the whole login's truth once its updates ran; the flat
          // list stands in only before the first per-account update arrives.
          ...(posicionesIbkr.size > 0 ? [...posicionesIbkr.values()].flat() : positions.value),
          ...[...enlaces.values()]
            .filter((enlace): enlace is EnlaceMT5 => enlace.broker === "mt5" && enlace.conectado)
            .flatMap((enlace) => enlace.posiciones),
        ].filter((pos) => pos.size > 0)

      /** The subset of `abiertas()` that Panic would actually close right now: the engine's
       * own account (the active one when it belongs to the primary link, else the primary
       * link's first account) with size > 0 plus every connected MetaTrader 5 link's rows
       * with size > 0. Watch accounts are excluded — Panic never closes them. Kept in sync
       * with the sweep in `panic` (closeAllPositionsInterno without guards + the MT5 loop). */
      const cerrables = () => [
        ...posicionesDeMotor(cuentaDeMotor()).filter((pos) => pos.size > 0),
        ...[...enlaces.values()]
          .filter((enlace): enlace is EnlaceMT5 => enlace.broker === "mt5" && enlace.conectado)
          .flatMap((enlace) => enlace.posiciones.filter((pos) => pos.size > 0)),
      ]

      return {
        snapshot: () => {
          const vista = lecturaVista()

          return {
            version: VERSION,
            // A socket TWS is about to refuse (taken client id) is no link: it only flickers.
            connected: enlacePrimaria.conectado && enlacePrimaria.ocupado === null,
            ...(enlacePrimaria.ocupado === null ? {} : { client_in_use: enlacePrimaria.cliente }),
            account: toSchemaAccount(),
            systems: sistemas.map(toSchemaSystem),
            positions: [...vista.positions],
            open_positions: [...abiertas()],
            closable_positions: [...cerrables()],
            logs: [...logs.value],
            tasks: [...tasks.value],
            trades: [...vista.trades],
            equity: [...vista.equity],
            accounts: toSchemaAccounts(),
            links: [...enlaces.values()].map(toSchemaLink),
            systems_dir: carpetaPool.value,
            ...(programas.tws === null
              ? {}
              : {
                  programs: {
                    tws: ESTADO_PROGRAMA[programas.tws],
                    ...(programas.mt5 === null ? {} : { mt5: ESTADO_PROGRAMA[programas.mt5] }),
                  },
                }),
          }
        },
        activate: (systemID) => arrancar(systemID, "user"),
        pause: (systemID) => detener(systemID, "user"),
        closePosition,
        closeAllPositions,
        connect: () => connect,
        disconnect: () => disconnect,
        accountSelect,
        linkAdd,
        linkRemove,
        mt5Detect,
        ibkrDetect,
        panic,
        poolSelect,
        taskList: () => Effect.gen(function* () { if (tasks.value.length === 0) yield* refreshTasks; return [...tasks.value] }),
        taskAdd,
        taskCancel,
        run,
      } satisfies Interface
    }),
  )

export const engineLayer = layer()

// The boot reloads only links it already validated, so a refusal there is a defect, never a
// startup error every service that depends on the engine would have to carry.
export const node = makeGlobalNode({ service: Service, layer: engineLayer.pipe(Layer.orDie), deps: [Database.node] })
