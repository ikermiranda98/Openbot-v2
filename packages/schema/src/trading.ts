export * as Trading from "./trading.js"

import { Schema } from "effect"
import { ascending } from "./identifier.js"
import { optional, statics } from "./schema.js"

/** An account is null: the engine never invents balances it did not receive from IBKR. */
export const Account = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  cash: Schema.NullOr(Schema.Number),
  equity: Schema.NullOr(Schema.Number),
  pnl_day: Schema.NullOr(Schema.Number),
  pnl_realized: Schema.NullOr(Schema.Number),
  /** AvailableFunds account-summary tag (USD); null until IBKR sends the tag.
   * Optional: an engine predating this field simply omits it. */
  available_funds: optional(Schema.NullOr(Schema.Number)),
  /** Whether the account itself carries demo money. MT5 sets it straight from the
   * terminal's trade mode; IBKR accounts omit it (their DU-prefix rule stands). */
  demo: optional(Schema.NullOr(Schema.Boolean)),
  /** BuyingPower account-summary tag (USD); null until IBKR sends the tag. */
  buying_power: optional(Schema.NullOr(Schema.Number)),
  /** MaintMarginReq account-summary tag (USD); null until IBKR sends the tag. */
  margin_used: optional(Schema.NullOr(Schema.Number)),
  /** ExcessLiquidity account-summary tag (USD); null until IBKR sends the tag. */
  excess_liquidity: optional(Schema.NullOr(Schema.Number)),
  /** Epoch ms of the newest account fact (summary tag or portfolio update); null until seen. */
  updated_at: optional(Schema.NullOr(Schema.Number)),
  /** The engine link the account lives on (its "host:port"); null when the engine's own
   * state carries no link id. Optional: an engine predating this field simply omits it. */
  link: optional(Schema.NullOr(Schema.String)),
}).annotate({ identifier: "Trading.Account" })
export interface Account extends Schema.Schema.Type<typeof Account> {}

/**
 * One broker platform a link (or its accounts) belongs to: an IBKR TWS watch today, with
 * NinjaTrader ("nt") and MetaTrader 5 ("mt5") watches to come.
 */
export const Broker = Schema.Literals(["ibkr", "nt", "mt5"]).annotate({ identifier: "Trading.Broker" })
export type Broker = Schema.Schema.Type<typeof Broker>

/**
 * One registered watch: an IBKR TWS link is a host:port whose socket the engine keeps
 * watching (its own reconnect chase runs until TWS accepts); an MT5 watch names the
 * terminal identity instead and the engine's Python bridge reads it. Links read
 * balances only; they never place orders. The panel's own primary link (the Conectar
 * flow) is one of them, with no label.
 */
export const Link = Schema.Struct({
  /** "host:port" for IBKR, "mt5-<login>@<server>" for MT5. Deduplicated per key. */
  id: Schema.String,
  /** The TWS address. Optional: an MT5 watch dials no host of its own. */
  host: optional(Schema.String),
  /** The TWS API port. Optional: an MT5 watch dials no port of its own. */
  port: optional(Schema.Number),
  /** The user's own name for the link; null when none was given (the primary's case).
   * At most 80 characters: the engine trims and caps it at its own gate too. */
  label: Schema.NullOr(Schema.String.check(Schema.isMaxLength(80))),
  /** The broker platform the link speaks (IBKR TWS so far). Optional: an engine predating
   * this field simply omits it — and every link of those engines is an IBKR one. */
  broker: optional(Broker),
  /** MT5 watches only: the MetaTrader 5 terminal identity the engine's bridge reads.
   * Optional: an IBKR (or predating-engine) link carries none. */
  mt5_login: optional(Schema.Number),
  /** MT5 watches only: the server the terminal logs into. Optional likewise. */
  mt5_server: optional(Schema.String),
  /** true while the link is feeding balances (its socket up, or its bridge's account arriving). */
  connected: Schema.Boolean,
}).annotate({ identifier: "Trading.Link" })
export interface Link extends Schema.Schema.Type<typeof Link> {}

/** One MetaTrader 5 account this computer's terminals recognize: from an install's own
 * records (its terminal folders' config and logs) and, when the terminal answers, from
 * the live account itself. The add-account wizard lists these to pick from. */
export const Mt5Detected = Schema.Struct({
  login: Schema.Number,
  server: Schema.String,
  /** The terminal's own account name ("Joe Rogan"); null outside a live answer. */
  name: Schema.NullOr(Schema.String),
  /** true when the config's own last login names this account, the natural pick. */
  active: Schema.Boolean,
  /** true when the live terminal answered (it may have been opened by the search). */
  live: Schema.Boolean,
}).annotate({ identifier: "Trading.Mt5Detected" })
export interface Mt5Detected extends Schema.Schema.Type<typeof Mt5Detected> {}

/** One IBKR API address on this computer and whether something answers there: TWS listens on
 * its socket port only while its API accepts connections, so an open port means "the API is on
 * and waiting". A plain TCP knock — no handshake, no client id, nothing registered — so the
 * search never shows up as a session in TWS. */
export const IbkrPort = Schema.Struct({
  host: Schema.String,
  port: Schema.Number,
  /** true on the live (real-money) default, 7496; false on its paper sibling 7497 and on any
   * other port (the engine cannot tell what a custom port serves). */
  live: Schema.Boolean,
  /** true when something accepted the TCP connection within the knock's short deadline. */
  open: Schema.Boolean,
}).annotate({ identifier: "Trading.IbkrPort" })
export interface IbkrPort extends Schema.Schema.Type<typeof IbkrPort> {}


export const System = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** Live bot process in the pool folder; the engine's own "active" is kept in sync with it. */
  running: Schema.Boolean,
  active: Schema.Boolean,
  /** The bot's process id while running (engine-launched or detected at boot); null otherwise. */
  pid: Schema.NullOr(Schema.Number),
  /** Epoch ms when the engine (re)attached to the running bot; null while it is not running. */
  started_at: Schema.NullOr(Schema.Number),
  symbol: Schema.String,
  timeframe: Schema.String,
  /** The bot's unrealized PnL from its own registro.log portfolio updates; null until seen today. */
  pnl_day: Schema.NullOr(Schema.Number),
  /** The bot's configured TWS CLIENT_ID from its config.py; null when the line is missing.
   * Optional: an engine predating this field simply omits it. */
  client_id: optional(Schema.NullOr(Schema.Number)),
  /** The config's session-close hour ("HH:MM:SS", New York's close); null when the line is absent. */
  close_hour: optional(Schema.NullOr(Schema.String)),
  /** Epoch ms of the bot's newest own record row today; null when it has not logged today. */
  last_activity_at: optional(Schema.NullOr(Schema.Number)),
  /** The system's one-paragraph idea from its own reglas.json; null when the file is absent. */
  description: optional(Schema.NullOr(Schema.String)),
  /** The system's rules as key→text pairs in file order; null when reglas.json is absent. */
  rules: optional(Schema.NullOr(Schema.Record(Schema.String, Schema.String))),
}).annotate({ identifier: "Trading.System" })
export interface System extends Schema.Schema.Type<typeof System> {}

export const Position = Schema.Struct({
  symbol: Schema.String,
  side: Schema.Literals(["long", "short"]),
  size: Schema.Number,
  entry: Schema.NullOr(Schema.Number),
  current: Schema.NullOr(Schema.Number),
  pnl: Schema.NullOr(Schema.Number),
  pnl_pct: Schema.NullOr(Schema.Number),
}).annotate({ identifier: "Trading.Position" })
export interface Position extends Schema.Schema.Type<typeof Position> {}

/** The full close cycle's outcome; `message` is the engine's own plain-language verdict (English fallback;
 * `message_key`/`message_params` carry the i18n key and its interpolation params when available). */
export const PositionCloseResult = Schema.Struct({
  ok: Schema.Boolean,
  message: Schema.String,
  /** i18n key for the verdict, e.g. `trading.close.*`; absent for legacy/untranslated entries. */
  message_key: optional(Schema.String),
  /** Interpolation params for `message_key`; absent when none are needed. */
  message_params: optional(Schema.Record(Schema.String, Schema.Unknown)),
}).annotate({ identifier: "Trading.PositionCloseResult" })
export interface PositionCloseResult extends Schema.Schema.Type<typeof PositionCloseResult> {}

export const LogLevel = Schema.Literals(["info", "warning", "error"]).annotate({
  identifier: "Trading.LogLevel",
})
export type LogLevel = typeof LogLevel.Type

export const Log = Schema.Struct({
  ts: Schema.Number,
  level: LogLevel,
  /** The system the entry belongs to, or "motor" for engine-wide events. */
  system: Schema.String,
  /** Plain-language verdict in English (fallback when no translation is available). */
  message: Schema.String,
  /** i18n key for the entry, e.g. `trading.log.*`; absent for legacy/untranslated entries
   * (bot-originated rows and technical identifiers stay verbatim). */
  message_key: optional(Schema.String),
  /** Interpolation params for `message_key`; absent when none are needed. */
  message_params: optional(Schema.Record(Schema.String, Schema.Unknown)),
  /** The few entries that mark a position lifecycle beat (a bot going into or out of a
   * position, or its entry signal); absent for every other line. */
  event: optional(
    Schema.Literals(["open", "close", "signal"]).annotate({ identifier: "Trading.LogEvent" }),
  ),
}).annotate({ identifier: "Trading.Log" })
export interface Log extends Schema.Schema.Type<typeof Log> {}

export const TaskID = Schema.String.check(Schema.isStartingWith("trd_")).pipe(
  Schema.brand("Trading.TaskID"),
  Schema.annotate({ identifier: "Trading.TaskID" }),
  statics((schema) => ({
    create: () => schema.make("trd_" + ascending()),
  })),
)
export type TaskID = typeof TaskID.Type

/** What a scheduled task does when it fires: `start-systems` starts the named systems'
 * bot processes, `stop-systems` stops them — the same honest start/stop paths the
 * dashboard's chips take. Tasks never place orders. */
export const TaskKind = Schema.Literals(["start-systems", "stop-systems"]).annotate({
  identifier: "Trading.TaskKind",
})
export type TaskKind = typeof TaskKind.Type

/**
 * `pending`: still waiting on `run_at`. `ran`: fired and every system's step confirmed.
 * `missed`: fell due while the app was closed and was skipped. `cancelled`: withdrawn by
 * the user. `failed`: fired, but at least one system's start or stop did not land.
 */
export const TaskStatus = Schema.Literals(["pending", "ran", "missed", "cancelled", "failed"]).annotate({
  identifier: "Trading.TaskStatus",
})
export type TaskStatus = typeof TaskStatus.Type

export const Task = Schema.Struct({
  id: TaskID,
  kind: TaskKind,
  /** System IDs the task acts on, all validated to exist in the pool; empty means every system. */
  system_ids: Schema.Array(Schema.String),
  /** The run time as epoch ms on the server machine's local (PC) clock. */
  run_at: Schema.Number,
  status: TaskStatus,
  /** Epoch ms when the task fired, was marked missed or was cancelled; null while pending. */
  resolved_at: Schema.NullOr(Schema.Number),
  time_created: Schema.Number,
  time_updated: Schema.Number,
}).annotate({ identifier: "Trading.Task" })
export interface Task extends Schema.Schema.Type<typeof Task> {}

/**
 * One closed trade, harvested from the bot's own registro.log rows. `ts` is the bot's own
 * log timestamp (epoch ms on the PC clock); `message` is that row verbatim, with the bot's
 * bracketed gross USD figure parsed into `pnl` (null when the row carries none).
 */
export const Trade = Schema.Struct({
  system: Schema.String,
  ts: Schema.Number,
  pnl: Schema.NullOr(Schema.Number),
  message: Schema.String,
}).annotate({ identifier: "Trading.Trade" })
export interface Trade extends Schema.Schema.Type<typeof Trade> {}

/** One sampled point of the account's equity curve. Both values stay null until IBKR reports them. */
export const EquityPoint = Schema.Struct({
  ts: Schema.Number,
  equity: Schema.NullOr(Schema.Number),
  pnl_day: Schema.NullOr(Schema.Number),
}).annotate({ identifier: "Trading.EquityPoint" })
export interface EquityPoint extends Schema.Schema.Type<typeof EquityPoint> {}


/** The panic button's outcome: the systems stopped (if any were running) plus the close-all verdict. */
/** The systems folder a pick switched the engine to, and how many systems it found there. */
export const PoolSelectResult = Schema.Struct({
  dir: Schema.String,
  systems: Schema.Number,
}).annotate({ identifier: "Trading.PoolSelectResult" })
export interface PoolSelectResult extends Schema.Schema.Type<typeof PoolSelectResult> {}

export const PanicResult = Schema.Struct({
  stopped: Schema.Array(Schema.String),
  close: PositionCloseResult,
  message: Schema.String,
  message_key: optional(Schema.String),
  message_params: optional(Schema.Record(Schema.String, Schema.Unknown)),
}).annotate({ identifier: "Trading.PanicResult" })
export interface PanicResult extends Schema.Schema.Type<typeof PanicResult> {}

/** A desktop program the engine needs: running, opened by the engine and still loading,
 * installed but closed, or not installed on this computer. */
export const ProgramState = Schema.Literals(["running", "opening", "closed", "missing"]).annotate({
  identifier: "Trading.ProgramState",
})
export type ProgramState = Schema.Schema.Type<typeof ProgramState>

/** The programs the engine opens on its own: TWS always, MetaTrader 5 while an MT5 account
 * is linked. */
export const Programs = Schema.Struct({
  tws: ProgramState,
  mt5: optional(ProgramState),
}).annotate({ identifier: "Trading.Programs" })

export const Snapshot = Schema.Struct({
  version: Schema.String,
  /** true while the engine's primary TWS socket (the panel's own Conectar link, on the
   * engine's configured address) is up; account and positions are empty otherwise. */
  connected: Schema.Boolean,
  /** The engine's own TWS client id while TWS refuses it as already taken by another API
   * program (a second Openbot on the same TWS, say); absent while the id is free. */
  client_in_use: optional(Schema.Number),
  account: Schema.NullOr(Account),
  systems: Schema.Array(System),
  positions: Schema.Array(Position),
  /** Every open position the engine can see — all of the trading connection's accounts plus
   * every connected MetaTrader 5 link's — for readers that must watch the real exposure (the
   * desktop's quit gate) rather than the shown account's rows alone; absent only from
   * snapshots of an engine predating this field. */
  open_positions: optional(Schema.Array(Position)),
  /** The subset of `open_positions` the Panic button would actually close right now — the
   * engine's own account (the active one when it belongs to the primary link, else the
   * primary link's first account) with size > 0 plus every connected MetaTrader 5 link's
   * rows with size > 0. Watch accounts are excluded: Panic does not close them. Absent
   * only from snapshots of an engine predating this field. */
  closable_positions: optional(Schema.Array(Position)),
  logs: Schema.Array(Log),
  /** Recent scheduled tasks, newest first. */
  tasks: Schema.Array(Task),
  /** Closed trades harvested from the bots' logs, newest first, capped to the most recent 200. */
  trades: optional(Schema.Array(Trade)),
  /** The account's equity curve, oldest first, sampled every 15 s from the account data, capped to 1000 points. */
  equity: optional(Schema.Array(EquityPoint)),
  /** Every account the engine's links have discovered, linked through `link`; absent only
   * from snapshots of an engine predating this field. */
  accounts: optional(Schema.Array(Account)),
  /** The engine's links, the panel's primary one first; absent only from snapshots of an
   * engine predating this field. */
  links: optional(Schema.Array(Link)),
  /** The folder the engine reads its systems from; absent only from snapshots of an engine
   * predating this field. */
  systems_dir: optional(Schema.String),
  /** TWS's and MetaTrader 5's state on this computer; absent only from snapshots of an
   * engine predating this field. */
  programs: optional(Programs),
}).annotate({ identifier: "Trading.Snapshot" })
export interface Snapshot extends Schema.Schema.Type<typeof Snapshot> {}
