import { integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { Trading } from "@opencode/schema/trading"
import { Timestamps } from "../database/schema.sql.js"

export const TradingTaskTable = sqliteTable("trading_task", {
  id: text().$type<Trading.TaskID>().primaryKey(),
  kind: text().$type<Trading.TaskKind>().notNull(),
  /** System IDs the task acts on, deduplicated and validated against the pool at creation; empty means every system. */
  system_ids: text({ mode: "json" }).$type<string[]>().notNull(),
  /** Epoch ms on the server machine's local (PC) clock. */
  run_at: integer().notNull(),
  status: text().$type<Trading.TaskStatus>().notNull().default("pending"),
  /** Epoch ms when the task fired, was marked missed or was cancelled; null while pending. */
  resolved_at: integer(),
  ...Timestamps,
})

/** One closed trade: the bot's own registro.log row (its "FUERA … (±X USD brutos)" verdict or
 * a close-tagged row). The key is `id` — "system:ts:<short sha1 of message>" — so a replayed
 * log tail re-inserts nothing (same identity, conflict no-op) and two different closes in
 * the same millisecond never collide. */
export const TradingTradeTable = sqliteTable("trading_trade", {
  /** Deterministic identity "system:ts:<sha1(message)[0..12]>"; 0 stands for rows written
   * before this key existed. */
  id: text().primaryKey(),
  system: text().notNull(),
  ts: integer().notNull(),
  /** The bot's stated gross USD result; null when the row carries no figure. */
  pnl: real(),
  message: text().notNull(),
  ...Timestamps,
})

/** One registered link beyond the panel's own primary: the watch's identity and the
 * user's label, so the links survive engine restarts. IBKR rows carry the TWS host:port
 * (their "id"); MT5 rows carry no TWS address ("" and 0) — the terminal identity rides
 * the mt5 columns instead. */
export const TradingLinkTable = sqliteTable("trading_link", {
  /** "host:port" for IBKR, "mt5-<login>@<server>" for MT5; unique per identity. */
  id: text().primaryKey(),
  /** The TWS host; "" when the link dials none (MT5). */
  host: text().notNull(),
  /** The TWS API port; 0 when the link dials none (MT5). */
  port: integer().notNull(),
  /** The user's own name for the link; null when none was given. */
  label: text(),
  /** The platform family the link speaks. */
  broker: text().$type<Trading.Broker>().notNull().default("ibkr"),
  /** MT5 rows: the MetaTrader 5 login the terminal account carries. */
  mt5_login: integer(),
  /** MT5 rows: the server the terminal logs in as. */
  mt5_server: text(),
  ...Timestamps,
})

/** The engine's small key/value store (one row per key): the remembered active account
 * ("cuenta_activa"), kept across restarts until the account leaves every link. */
export const TradingMetaTable = sqliteTable("trading_meta", {
  id: text().primaryKey(),
  value: text().notNull(),
  ...Timestamps,
})

/** One remembered account: the id one of the engine's links last discovered, kept across
 * restarts so the sidebar keeps listing it — and the user can switch back to it — while
 * its link is between sessions (TWS closed, a bridge chasing its terminal). Facts stay
 * unset until the link reads them live; the row rides its link's life: removed with the
 * link, refreshed whenever any link rediscoverers the id. */
export const TradingAccountTable = sqliteTable("trading_account", {
  /** The account id itself ("5058203356", "DU123…"). */
  id: text().primaryKey(),
  /** The link that last carried the account ("host:port" or "mt5-<login>@<server>"). */
  link_id: text().notNull(),
  /** The account's last-known kind ("demo"/"real" for MT5, TWS's AccountType tag for IBKR);
   * null when seen only as a row without facts. */
  tipo: text(),
  ...Timestamps,
})

/** One close submission. Its id replays an already-recorded verdict across engine restarts,
 * so an HTTP-level repeat of the same request reads its own earlier answer instead of
 * racing the first cycle into new orders; `lock` holds the contract's symbol while the
 * close runs, and the unique index makes a second claim of the same contract lose its
 * insert — SQLite counts NULLs as distinct, so verdict rows (lock null) and the close-all
 * mass row never collide over it. */
export const TradingCloseTable = sqliteTable(
  "trading_close",
  {
    /** The submission's claim: "cierre:<requestId>" (a panel click naming its submission),
     * "cierre:<symbol>:<sello>" (the engine's own anonymous close) or "cierre-todo:…"
     * (the close-all mass, plus its per-symbol children as "cierre-todo:…:<symbol>"). */
    id: text().primaryKey(),
    /** The symbol the verdict names; "" on the mass row (its per-symbol children carry the symbols). */
    symbol: text().notNull(),
    /** The contract under claim while the close runs; null once the verdict records. */
    lock: text(),
    /** The verdict — a `Trading.PositionCloseResult` JSON-encoded on recording — and SQL
     * NULL while the claim is open: the distinction (not a sentinel string) is what boot
     * housekeeping purges by, and what a repeat reads its replay from. */
    verdict: text().$type<string | null>(),
    /** Epoch ms of the claim's last move: its opening, its takeover or its verdict recording. */
    ts: integer().notNull(),
    ...Timestamps,
  },
  (table) => [uniqueIndex("trading_close_lock_idx").on(table.lock)],
)
