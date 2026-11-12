import { Trading } from "@opencode/schema/trading"
import { Schema } from "effect"
import { HttpApiEndpoint, OpenApi } from "effect/http-api"
import { InvalidRequestError, TradingSystemNotFoundError, TradingTaskNotFoundError } from "../errors.js"

const EXPERIMENTAL = "Experimental: may change without compatibility guarantees."
const annotations = (identifier: string, summary: string, description: string) =>
  OpenApi.annotations({
    identifier: `experimental.trading.${identifier}`,
    summary,
    description: `${description} ${EXPERIMENTAL}`,
    // The routes share the `server.experimental` group with the persistent PTY prototype; tag them on their own.
    transform: (operation) => ({ ...operation, tags: ["experimental"] }),
  })

export const PositionCloseParams = { symbol: Schema.String }
export const PositionClosePayload = Schema.Struct({
  /** Idempotency key: repeating the same submission with it inside a minute returns the
   * first attempt's verdict again instead of racing that cycle into new orders. */
  requestId: Schema.optional(Schema.String),
})
export type PositionClosePayload = typeof PositionClosePayload.Type
const params = { systemID: Schema.String }
const taskParams = { taskID: Trading.TaskID }

export const TaskAddPayload = Schema.Struct({
  kind: Trading.TaskKind,
  /** System IDs to act on; empty or omitted means every system in the pool. */
  systemIDs: Schema.optional(Schema.Array(Schema.String)),
  /** Minutes from now on the server's local (PC) clock; mutually exclusive with `atTime`. */
  delayMinutes: Schema.optional(Schema.Number),
  /** The next local wall-clock time "HH:MM" (PC clock; tomorrow when it is past today already); mutually exclusive with `delayMinutes`. */
  atTime: Schema.optional(Schema.String),
}).annotate({ identifier: "Trading.TaskAddPayload" })
export type TaskAddPayload = typeof TaskAddPayload.Type

export const PoolSelectPayload = Schema.Struct({
  /** An absolute folder holding the systems, one `NN_name` subfolder with its `bot.py` each. */
  dir: Schema.String,
}).annotate({ identifier: "Trading.PoolSelectPayload" })
export type PoolSelectPayload = typeof PoolSelectPayload.Type

export const LinkAddPayload = Schema.Struct({
  /** The TWS host; omitted means the engine's own host. The engine trims it and keeps
   * a plain address of at most 80 characters: the link id builds on it. */
  host: Schema.optional(Schema.String.check(Schema.isMaxLength(80))),
  /** The TWS API port (the live port is 7496; its demo sibling is 7497). An MT5 link omits
   * it. */
  port: Schema.optional(Schema.Number),
  /** The user's own name for the link; at most 80 characters (the engine trims and caps). */
  label: Schema.optional(Schema.String.check(Schema.isMaxLength(80))),
  /** The platform the registration asks for; omitted means an IBKR TWS socket. Platforms
   * whose read link the engine doesn't carry yet (NT) refuse the registration honestly. */
  broker: Schema.optional(Trading.Broker),
  /** IBKR registrations on the live port only: the explicit confirmation that this
   * registration may watch the live account — the interface's dialog passes it after the
   * user confirms, and a direct API call must pass it the same way. */
  live: Schema.optional(Schema.Boolean),
  /** MT5 registrations only: the MetaTrader 5 login the terminal account carries. Of no
   * effect on any other broker (the engine refuses the mix). */
  mt5Login: Schema.optional(Schema.Number),
  /** MT5 registrations only: the server the terminal logs in as; given with `mt5Login`.
   * At most 80 characters, without '@' (the engine's link id builds on it). */
  mt5Server: Schema.optional(Schema.String.check(Schema.isMaxLength(80))),
}).annotate({ identifier: "Trading.LinkAddPayload" })
export type LinkAddPayload = typeof LinkAddPayload.Type

export const Mt5DetectPayload = Schema.Struct({
  /** true when the search may also read the live terminal's logged-in account — the
   * spawned probe opens a closed MetaTrader 5, so it only runs behind the wizard's
   * explicit button. Omitted or false reads the disk records alone. */
  probe: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "Trading.Mt5DetectPayload" })
export type Mt5DetectPayload = typeof Mt5DetectPayload.Type

export const IbkrDetectPayload = Schema.Struct({
  /** The address to test, as the add-account wizard has it typed. Omitted, the search knocks
   * on this computer's two IBKR defaults (7497, 7496 on 127.0.0.1). */
  host: Schema.optional(Schema.String.check(Schema.isMaxLength(80))),
  /** The API port to test; given with or without `host` (host defaults to 127.0.0.1). */
  port: Schema.optional(Schema.Number),
}).annotate({ identifier: "Trading.IbkrDetectPayload" })
export type IbkrDetectPayload = typeof IbkrDetectPayload.Type

const linkParams = { linkID: Schema.String }

/** Lives in the `server.experimental` group (see `groups/experimental.ts`). */
export const TradingEndpoints = [
  HttpApiEndpoint.get("trading.snapshot", "/api/experimental/trading/snapshot", {
    success: Schema.Struct({ data: Trading.Snapshot }),
    error: [InvalidRequestError],
  }).annotateMerge(
    annotations(
      "snapshot",
      "Read the trading engine snapshot",
      "Read the engine's whole state: its links and discovered accounts, the active account, the pool's systems, open positions and the recent event log. Read-only; it never places orders.",
    ),
  ),
  HttpApiEndpoint.post("trading.system.activate", "/api/experimental/trading/system/:systemID/activate", {
    params,
    success: Schema.Struct({ data: Trading.System }),
    error: [InvalidRequestError, TradingSystemNotFoundError],
  }).annotateMerge(
    annotations(
      "system.activate",
      "Activate a trading system",
      "Start the named system's bot process (or adopt one already running in the pool folder). Starting a bot is not an order: this desk's only order paths are the close endpoints.",
    ),
  ),
  HttpApiEndpoint.post("trading.system.pause", "/api/experimental/trading/system/:systemID/pause", {
    params,
    success: Schema.Struct({ data: Trading.System }),
    error: [InvalidRequestError, TradingSystemNotFoundError],
  }).annotateMerge(
    annotations(
      "system.pause",
      "Pause a trading system",
      "Stop the named system's bot process with the engine's pid-guarded kill — only a process whose command line is the system's own bot.py can ever be terminated, and a stop the engine cannot confirm is reported rather than claimed.",
    ),
  ),
  HttpApiEndpoint.post("trading.position.close", "/api/experimental/trading/position/:symbol/close", {
    params: PositionCloseParams,
    payload: PositionClosePayload,
    success: Schema.Struct({ data: Trading.PositionCloseResult }),
    error: [InvalidRequestError],
  }).annotateMerge(
    annotations(
      "position.close",
      "Close a trading position",
      "Run the full close cycle for one position of the account: the desk's own open orders on the contract cancel first (anything foreign to the desk aborts the close before a single cancel flies), the live position is re-read, the opposite market order goes out allowed outside regular hours and, when it cannot execute, two OCA GTC limit orders a few ticks aside on the contract's own tick grid go out once the market order's terminal state is positively confirmed (one fills, the other cancels; nothing reopens). Always called behind the user's explicit confirmation in the dashboard; it never invents orders when TWS refuses. A request that carries requestId returns the earlier verdict when repeated within a minute.",
    ),
  ),
  HttpApiEndpoint.post(
    "trading.position.closeAll",
    "/api/experimental/trading/positions/close-all",
    {
      payload: PositionClosePayload,
      success: Schema.Struct({ data: Trading.PositionCloseResult }),
      error: [InvalidRequestError],
    },
  ).annotateMerge(
    annotations(
      "positions.closeAll",
      "Close all open positions",
      "The emergency counterpart of the single close: run the full close cycle over every open position of the account in turn — the desk's own orders cancel first, the live position is re-read before the send, and the OCA fallback only leaves the gate after a positively confirmed terminal order state. The shown account gates the sweep like the single close: a MetaTrader 5 view or a read-only watch is refused before anything is judged or replayed — MetaTrader 5 rows close one by one or through Panic, which closes every linked MetaTrader 5 account. One failure never stops the rest; the message lists each symbol's verdict and names whatever still reads open afterwards. Always called behind the user's explicit confirmation in the dashboard. A request that carries requestId returns the earlier verdict when repeated within a minute.",
    ),
  ),
  HttpApiEndpoint.get(
    "trading.task.list",
    "/api/experimental/trading/task", {
    success: Schema.Struct({ data: Schema.Array(Trading.Task) }),
    error: [InvalidRequestError],
  }).annotateMerge(
    annotations(
      "task.list",
      "List scheduled trading tasks",
      "List the engine's scheduled tasks (start/stop systems), newest first, including pending, ran, missed and cancelled ones.",
    ),
  ),
  HttpApiEndpoint.post("trading.task.add", "/api/experimental/trading/task", {
    payload: TaskAddPayload,
    success: Schema.Struct({ data: Trading.Task }),
    error: [InvalidRequestError, TradingSystemNotFoundError],
  }).annotateMerge(
    annotations(
      "task.add",
      "Schedule a trading task",
      "Schedule one of the engine's tasks: start or stop systems at a run time on the server's local PC clock, given as a wait in minutes or a local HH:MM. Tasks are persisted; a task that falls due while the app is closed is marked missed instead of firing late.",
    ),
  ),
  HttpApiEndpoint.post("trading.task.cancel", "/api/experimental/trading/task/:taskID/cancel", {
    params: taskParams,
    success: Schema.Struct({ data: Trading.Task }),
    error: [InvalidRequestError, TradingTaskNotFoundError],
  }).annotateMerge(
    annotations(
      "task.cancel",
      "Cancel a scheduled trading task",
      "Cancel a pending scheduled task so it never fires. Already resolved tasks (ran, missed or cancelled) cannot be cancelled.",
    ),
  ),
  HttpApiEndpoint.post("trading.connect", "/api/experimental/trading/connect", {
    success: Schema.Struct({ data: Schema.NullOr(Trading.Account) }),
    error: [InvalidRequestError],
  }).annotateMerge(
    annotations(
      "connect",
      "Connect the engine to TWS",
      "Link the engine's TWS socket up; nothing connects at boot or on any automation's behalf. The socket retries every 5 s until TWS accepts, and the account, positions and P/L start flowing afterwards. Returns the account (null while the balances have not arrived yet).",
    ),
  ),
  HttpApiEndpoint.post("trading.disconnect", "/api/experimental/trading/disconnect", {
    success: Schema.Struct({ data: Schema.NullOr(Trading.Account) }),
    error: [InvalidRequestError],
  }).annotateMerge(
    annotations(
      "disconnect",
      "Disconnect the engine from TWS",
      "Drop the engine's TWS socket and stop the reconnect chase; account, positions and P/L drain until the next connect. The pool's running bots are untouched. Returns null.",
    ),
  ),
  HttpApiEndpoint.post("trading.panic", "/api/experimental/trading/panic", {
    success: Schema.Struct({ data: Trading.PanicResult }),
    error: [InvalidRequestError],
  }).annotateMerge(
    annotations(
      "panic",
      "Trigger the trading panic stop",
      "Stop every running bot immediately (the engine's pid-guarded kill path) and then run the emergency close-all over every open IBKR position, and close every linked MetaTrader 5 account's positions in its own terminal, whether or not any bot was running. Nothing is re-armed afterwards; the systems stay stopped until reactivated. Always called behind the user's explicit confirmation in the dashboard.",
    ),
  ),
  HttpApiEndpoint.post("trading.pool.select", "/api/experimental/trading/pool", {
    payload: PoolSelectPayload,
    success: Schema.Struct({ data: Trading.PoolSelectResult }),
    error: [InvalidRequestError],
  }).annotateMerge(
    annotations(
      "pool.select",
      "Pick the systems folder",
      "Point the engine at the folder its systems live in (one `NN_name` subfolder with its `bot.py` each) and reload the pool from it. Refused while a system runs, or when the folder holds no systems. The pick is remembered across restarts and wins over the engine's configured default.",
    ),
  ),
  HttpApiEndpoint.post("trading.account.select", "/api/experimental/trading/account/:accountID/select", {
    params: { accountID: Schema.String },
    success: Schema.Struct({ data: Schema.NullOr(Trading.Account) }),
    error: [InvalidRequestError],
  }).annotateMerge(
    annotations(
      "account.select",
      "Select the dashboard's active account",
      "Switch the account `snapshot.account` shows: every account field, the KPI strip and the equity curve follow the selection. The input must name an account one of the engine's links has discovered. The selection is remembered across restarts while the account appears again in any link.",
    ),
  ),
  HttpApiEndpoint.post("trading.link.add", "/api/experimental/trading/link", {
    payload: LinkAddPayload,
    success: Schema.Struct({ data: Trading.Link }),
    error: [InvalidRequestError],
  }).annotateMerge(
    annotations(
      "link.add",
      "Register a balance watch link",
      "Register a chart-reading watch: an IBKR TWS address whose socket the engine opens (retries every 5 s until TWS accepts), or an MT5 registration naming its MetaTrader 5 identity (login + server) whose account the engine's Python bridge reads while its terminal runs. An address that already names the panel's own session is answered by starting that session's connect (the Conectar button's socket) and persists nothing; other identities register for real. Links discover their logins' accounts and list them beside the primary's; they never place orders. Already-registered identities are refused; an absent broker means an IBKR TWS socket, and NT is still refused honestly. The live TWS port (7496) needs live: true — the explicit confirmation that this registration may watch a real account. Labels arrive with at most 80 characters. Registered identities persist across restarts.",
    ),
  ),
  HttpApiEndpoint.post("trading.mt5.detect", "/api/experimental/trading/mt5/detect", {
    payload: Mt5DetectPayload,
    success: Schema.Struct({ data: Schema.Array(Trading.Mt5Detected) }),
    error: [InvalidRequestError],
  }).annotateMerge(
    annotations(
      "mt5.detect",
      "Search this computer's MetaTrader 5 accounts",
      "Search this computer's MetaTrader 5 terminals for their accounts: the install's own records (its terminal folders' config and logs) read off disk alone, with no side effects; the probe additionally reads the live terminal's logged-in account, opening a closed terminal so the bridge can read it. Read-only; it never registers a link.",
    ),
  ),
  HttpApiEndpoint.post("trading.ibkr.detect", "/api/experimental/trading/ibkr/detect", {
    payload: IbkrDetectPayload,
    success: Schema.Struct({ data: Schema.Array(Trading.IbkrPort) }),
    error: [InvalidRequestError],
  }).annotateMerge(
    annotations(
      "ibkr.detect",
      "Search this computer's IBKR API ports",
      "Knock on IBKR API ports with a plain TCP connection and report which ones answer: TWS listens on its socket port only while its API accepts connections. Without an address it tries the two defaults on 127.0.0.1 (7497 TWS paper, 7496 TWS live); with one, it tests that address alone — the wizard's check before registering. No handshake and no client id: nothing connects, registers or shows up in TWS. Read-only.",
    ),
  ),
  HttpApiEndpoint.delete("trading.link.remove", "/api/experimental/trading/link/:linkID", {
    params: linkParams,
    success: Schema.Struct({ data: Schema.Array(Trading.Link) }),
    error: [InvalidRequestError],
  }).annotateMerge(
    annotations(
      "link.remove",
      "Remove a registered TWS link",
      "Withdraw a registered link: its socket drops and its accounts stop listing. The panel's own primary link is never removable. Returns the remaining links.",
    ),
  ),
] as const
