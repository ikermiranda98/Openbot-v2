import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Image } from "@opencode/core/image"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/core/schema"
import { Permission } from "@opencode/core/permission"
import { Session } from "@opencode/core/session"
import { Tool } from "@opencode/core/tool"
import { TradingTools } from "@opencode/core/tool/plugin/trading"
import { TradingEngine } from "@opencode/core/trading"
import type { Trading } from "@opencode/schema/trading"
import { testEffect } from "./lib/effect"
import { imagePassthrough } from "./lib/image"
import { permissionLayer } from "./lib/permission"
import { executeTool, registerToolPlugin, toolIdentity } from "./lib/tool"

const desk = Session.ID.make("ses_trading_desk")
const other = Session.ID.make("ses_trading_other")

const it = testEffect(
  AppNodeBuilder.build(Tool.node, [
    Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") })),
    Image.node.replace(imagePassthrough),
    Permission.node.replace(permissionLayer()),
  ]),
)

const TRADING_LINK = "127.0.0.1:7497"

/** The tools under one permission policy (every assert is recorded, `allow` decides it) with
 * the dashboard showing an account on `shown` — the trading connection unless told otherwise. */
const setup = (allow: boolean, shown = TRADING_LINK) =>
  Effect.gen(function* () {
    const asked: Permission.AssertInput[] = []
    const closes: string[] = []
    yield* registerToolPlugin(TradingTools.Plugin).pipe(
      Effect.provide(
        Layer.mock(Session.Service)({
          // SAFETY: the tools read only `metadata` off the session; the rest of Info is never touched.
          get: (sessionID) => Effect.succeed({ metadata: sessionID === desk ? { "opencode.trading": true } : {} } as unknown as Session.Info),
          revert: {
            stage: () => Effect.die("unused"),
            clear: () => Effect.die("unused"),
            commit: () => Effect.die("unused"),
          },
        }),
      ),
      Effect.provide(
        Layer.mock(TradingEngine.Service)({
          // SAFETY: the close guard reads only the shown account's link and the links' order.
          snapshot: () => ({ account: { id: "acct", link: shown }, links: [{ id: TRADING_LINK }] }) as unknown as Trading.Snapshot,
          closePosition: (symbol) => Effect.sync(() => (closes.push(symbol), { ok: true, message: `Cierre enviado: ${symbol}` })),
        }),
      ),
      Effect.provide(
        permissionLayer({
          assert: (input) =>
            Effect.suspend(() => {
              asked.push(input)
              return allow
                ? Effect.void
                : Effect.fail(new Permission.BlockedError({ rules: [], permission: input.action, resources: [...input.resources] }))
            }),
        }),
      ),
    )
    return { registry: yield* Tool.Service, asked, closes }
  })

/** One Code Mode close, the way the model reaches the tools; returns the text the model reads. */
const close = (registry: Tool.Interface, sessionID: Session.ID) =>
  executeTool(registry, {
    sessionID,
    ...toolIdentity,
    call: { type: "tool-call", id: "call-close", name: "execute", input: { code: 'return await tools.trading.position_close({ symbol: "MNQZ6" })' } },
  }).pipe(Effect.map((result) => result.content?.map((part) => (part.type === "text" ? part.text : "")).join("") ?? ""))

describe("TradingTools", () => {
  // The money-moving contract: outside the desk's own chat nothing reaches the engine, and in
  // it an order passes the native prompt first — never with an "always" pattern to save.
  it.effect("an order asks every time, only in the desk's chat, and never reaches the engine when refused", () =>
    Effect.gen(function* () {
      const fuera = yield* setup(true)
      expect(yield* close(fuera.registry, other)).toContain("The trading tools only work in the trading desk's own chat")
      expect(fuera.asked).toEqual([])
      expect(fuera.closes).toEqual([])

      const dentro = yield* setup(true)
      expect(yield* close(dentro.registry, desk)).toContain("Cierre enviado: MNQZ6")
      expect(dentro.asked.map((input) => ({ action: input.action, resources: input.resources, save: input.save }))).toEqual([
        { action: "trading_position_close", resources: ["MNQZ6"], save: undefined },
      ])
      expect(dentro.closes).toEqual(["MNQZ6"])

      const negada = yield* setup(false)
      expect(yield* close(negada.registry, desk)).toContain("Permission denied: trading_position_close")
      expect(negada.closes).toEqual([])

      // A watched account on screen (an MT5 terminal) shows positions the close can't reach:
      // the tool refuses before it even asks.
      const vigilada = yield* setup(true, "mt5-5058203356@MetaQuotes-Demo")
      expect(yield* close(vigilada.registry, desk)).toContain("only reads: its positions can't be closed from the desk")
      expect(vigilada.asked).toEqual([])
      expect(vigilada.closes).toEqual([])
    }),
  )
})
