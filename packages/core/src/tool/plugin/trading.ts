export * as TradingTools from "./trading.js"

import { ToolFailure } from "@opencode/ai/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Trading } from "@opencode/schema/trading"
import { Effect, Schema } from "effect"
import type { Agent } from "../../agent.js"
import { Permission } from "../../permission.js"
import { Session } from "../../session.js"
import { TradingEngine } from "../../trading.js"

// The trading desk's own tools: the dedicated trading chat reads the engine and acts on it
// through these instead of raw HTTP. Reads run freely; every write passes the app's native
// permission prompt first, and the ones that send orders (a close, the close-all, the panic)
// never offer "always" — each one asks. They answer only inside the desk's own chat (the
// session the trading route marks), so the rest of the app's sessions can't move money.

/** The trading route's session mark (`TRADING_METADATA_MARK` in the app). */
const TRADING_MARK = "opencode.trading"

const NAMESPACE = "trading"

const Empty = Schema.Struct({})

const SystemInput = Schema.Struct({
  systemID: Schema.String.annotate({ description: 'The system id from trading_state, e.g. "01".' }),
})

const SymbolInput = Schema.Struct({
  symbol: Schema.String.annotate({ description: "The open position's symbol from trading_state, e.g. MNQZ6." }),
})

const TaskInput = Schema.Struct({
  kind: Trading.TaskKind.annotate({ description: '"start-systems" or "stop-systems".' }),
  systemIDs: Schema.optional(Schema.Array(Schema.String)).annotate({ description: "Systems to act on; omit or leave empty for every system." }),
  delayMinutes: Schema.optional(Schema.Number).annotate({ description: "Whole minutes from now. Give this or atTime, never both." }),
  atTime: Schema.optional(Schema.String).annotate({ description: 'A local "HH:MM" on the PC clock (tomorrow when already past today).' }),
})

const TaskCancelInput = Schema.Struct({
  taskID: Trading.TaskID.annotate({ description: "A pending task's id (trd_...) from trading_state." }),
})

const AccountInput = Schema.Struct({
  accountID: Schema.String.annotate({ description: "An account id from trading_state's accounts." }),
})

export const Plugin = {
  id: "opencode.tool.trading",
  effect: Effect.fn("TradingTools.Plugin")(function* (ctx: Context) {
    const engine = yield* TradingEngine.Service
    const permission = yield* Permission.Service
    const sessions = yield* Session.Service

    const failure = (message: string) => new ToolFailure({ message, error: new Error(message) })

    // The desk's chat only: any other session gets an honest refusal instead of the engine.
    const desk = (sessionID: Session.ID) =>
      sessions.get(sessionID).pipe(
        Effect.mapError((error) => new ToolFailure({ message: error.message, error })),
        Effect.flatMap((session) =>
          session.metadata?.[TRADING_MARK] === true
            ? Effect.void
            : Effect.fail(failure("The trading tools only work in the trading desk's own chat (the Trading section's chat panel).")),
        ),
      )

    // One native permission prompt per write. `save` offers "always" for that action on that
    // resource; the order paths pass none, so every close and every panic asks again.
    // A rule's deny or a decline with feedback comes back as the tool's failure (the model reads
    // why and carries on); a plain decline travels on as the runtime's own defect.
    const ask = (
      context: { sessionID: Session.ID; agent?: Agent.ID; messageID: string; id: string },
      action: string,
      resources: string[],
      metadata: Record<string, unknown>,
      save?: string[],
    ) =>
      permission
        .assert({
          action,
          resources,
          save,
          metadata,
          sessionID: context.sessionID,
          agent: context.agent,
          source: { type: "tool", messageID: context.messageID, id: context.id },
        })
        .pipe(Effect.mapError((error) => new ToolFailure({ message: error.message, error })))

    const json = (value: unknown) => JSON.stringify(value, null, 2)

    // The state's positions are the shown account's own (an MT5 terminal's when one is shown),
    // but a close only ever reaches the trading connection's account. While a watched account
    // is on screen, closing would act on positions the model is not looking at: refuse.
    const vistaOpera = Effect.suspend(() => {
      const estado = engine.snapshot()
      const primaria = estado.links?.[0]?.id
      return estado.account === null || primaria === undefined || estado.account.link === primaria
        ? Effect.void
        : Effect.fail(
            failure(
              `The shown account (${estado.account.id}) only reads: its positions can't be closed from the desk. Closes act on the trading connection's account; ask the user to select it first.`,
            ),
          )
    })

    yield* ctx.tool.transform((editor) => {
      editor.namespace({
        name: NAMESPACE,
        description:
          "The trading desk's engine: read its state (accounts, links, systems, positions, tasks, trades) and act on it. Writes ask the user through the app's permission prompt; orders always ask. This is not financial advice.",
      })

      editor.add({
        name: "state",
        description:
          "Read the trading engine's live state: the connection, the shown account and every discovered account (demo or live), the links (the first one trades, the rest only read), the systems with their running flags and day P/L, the shown account's open positions, today's closed trades and equity curve (an MT5 account brings its own terminal's), and the scheduled tasks. The desk sets no loss limit of its own: the bots manage their own risk. Read it fresh before answering any state question.",
        input: Empty,
        output: Trading.Snapshot,
        options: { namespace: NAMESPACE },
        execute: (_, context) =>
          desk(context.sessionID).pipe(
            Effect.map(() => {
              const snapshot = engine.snapshot()
              // The model reads the whole state but only the recent tail of the log ring.
              const view = { ...snapshot, logs: snapshot.logs.slice(-20) }

              return { output: view, content: json(view) }
            }),
          ),
      })

      editor.add({
        name: "system_start",
        description: "Start one trading system's bot: it begins trading its own strategy against IBKR. Asks the user first.",
        input: SystemInput,
        output: Trading.System,
        options: { namespace: NAMESPACE },
        execute: (input, context) =>
          Effect.gen(function* () {
            yield* desk(context.sessionID)
            yield* ask(context, "trading_system_start", [input.systemID], input, [input.systemID])
            const system = yield* engine.activate(input.systemID).pipe(Effect.mapError((error) => failure(error.message)))

            return { output: system, content: json(system) }
          }),
      })

      editor.add({
        name: "system_stop",
        description: "Stop one trading system's bot. Open positions stay open. Asks the user first.",
        input: SystemInput,
        output: Trading.System,
        options: { namespace: NAMESPACE },
        execute: (input, context) =>
          Effect.gen(function* () {
            yield* desk(context.sessionID)
            yield* ask(context, "trading_system_stop", [input.systemID], input, [input.systemID])
            const system = yield* engine.pause(input.systemID).pipe(Effect.mapError((error) => failure(error.message)))

            return { output: system, content: json(system) }
          }),
      })

      editor.add({
        name: "task_add",
        description:
          "Schedule starting or stopping systems later, on the PC clock. Tasks only fire while the app is open; one due while it is closed is skipped (missed). Asks the user first.",
        input: TaskInput,
        output: Trading.Task,
        options: { namespace: NAMESPACE },
        execute: (input, context) =>
          Effect.gen(function* () {
            yield* desk(context.sessionID)
            yield* ask(context, "trading_task_add", [input.kind], input)
            const task = yield* engine.taskAdd(input).pipe(Effect.mapError((error) => failure(error.message)))

            return { output: task, content: json(task) }
          }),
      })

      editor.add({
        name: "task_cancel",
        description: "Cancel a pending scheduled task so it never fires. Asks the user first.",
        input: TaskCancelInput,
        output: Trading.Task,
        options: { namespace: NAMESPACE },
        execute: (input, context) =>
          Effect.gen(function* () {
            yield* desk(context.sessionID)
            yield* ask(context, "trading_task_cancel", [input.taskID], input)
            const task = yield* engine.taskCancel(input.taskID).pipe(Effect.mapError((error) => failure(error.message)))

            return { output: task, content: json(task) }
          }),
      })

      editor.add({
        name: "position_close",
        description:
          "Close one open position with real orders: the desk's own orders on the contract cancel, the live position is re-read, the opposite market order goes out (an OCA limit pair if it cannot execute). A running system on the same contract may reopen it. Always asks the user. Repeat the engine's verdict message to the user.",
        input: SymbolInput,
        output: Trading.PositionCloseResult,
        options: { namespace: NAMESPACE },
        execute: (input, context) =>
          Effect.gen(function* () {
            yield* desk(context.sessionID)
            yield* vistaOpera
            yield* ask(context, "trading_position_close", [input.symbol], input)
            // The call's own id is the submission id: a retried call replays its verdict.
            const verdict = yield* engine.closePosition(input.symbol, `chat:${context.id}`)

            return { output: verdict, content: verdict.message }
          }),
      })

      editor.add({
        name: "positions_close_all",
        description:
          "Close every open position with real orders, one after the other; one failure never stops the rest. Running systems may reopen positions. Always asks the user. Repeat the engine's verdict message to the user.",
        input: Empty,
        output: Trading.PositionCloseResult,
        options: { namespace: NAMESPACE },
        execute: (_, context) =>
          Effect.gen(function* () {
            yield* desk(context.sessionID)
            yield* vistaOpera
            yield* ask(context, "trading_positions_close_all", ["*"], {})
            const verdict = yield* engine.closeAllPositions(`chat:${context.id}`)

            return { output: verdict, content: verdict.message }
          }),
      })

      editor.add({
        name: "panic",
        description:
          "The emergency stop: every running system stops, its waiting tasks stand down, then every open position closes with real orders. Nothing re-arms afterwards. Only on the user's explicit emergency request; always asks.",
        input: Empty,
        output: Trading.PanicResult,
        options: { namespace: NAMESPACE },
        execute: (_, context) =>
          Effect.gen(function* () {
            yield* desk(context.sessionID)
            yield* ask(context, "trading_panic", ["*"], {})
            const result = yield* engine.panic()

            return { output: result, content: result.message }
          }),
      })

      editor.add({
        name: "connect",
        description: "Bring the trading connection's TWS socket up (the engine retries every 5 s until TWS accepts). Only when the user asks to connect. Asks the user first.",
        input: Empty,
        output: Schema.NullOr(Trading.Account),
        options: { namespace: NAMESPACE },
        execute: (_, context) =>
          Effect.gen(function* () {
            yield* desk(context.sessionID)
            yield* ask(context, "trading_connect", ["*"], {}, ["*"])
            const account = yield* engine.connect()

            return { output: account, content: json(account) }
          }),
      })

      editor.add({
        name: "disconnect",
        description: "Drop the trading connection's TWS socket; running bots keep running. Asks the user first.",
        input: Empty,
        output: Schema.NullOr(Trading.Account),
        options: { namespace: NAMESPACE },
        execute: (_, context) =>
          Effect.gen(function* () {
            yield* desk(context.sessionID)
            yield* ask(context, "trading_disconnect", ["*"], {}, ["*"])
            const account = yield* engine.disconnect()

            return { output: account, content: json(account) }
          }),
      })

      editor.add({
        name: "account_select",
        description:
          "Switch the account the dashboard shows. If it lives on the trading connection, the desk's orders go to it from then on. Asks the user first.",
        input: AccountInput,
        output: Schema.NullOr(Trading.Account),
        options: { namespace: NAMESPACE },
        execute: (input, context) =>
          Effect.gen(function* () {
            yield* desk(context.sessionID)
            yield* ask(context, "trading_account_select", [input.accountID], input, [input.accountID])
            const account = yield* engine.accountSelect(input.accountID).pipe(Effect.mapError((error) => failure(error.message)))

            return { output: account, content: json(account) }
          }),
      })
    })
  }),
}
