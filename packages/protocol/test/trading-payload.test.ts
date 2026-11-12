import { expect, test } from "bun:test"
import { Schema } from "effect"
import { LinkAddPayload } from "../src/groups/trading.js"

const decode = Schema.decodeUnknownSync(LinkAddPayload)

test("LinkAddPayload keeps an MT5 registration portable: a link with no port is legal on the wire", () => {
  // The honest MT5 branch of the add-dialog relies on this: the transport carries the
  // request as-is and the engine — not the schema — refuses a link whose platform has
  // no read side yet. `optional(...)` must omit the absent keys, not fold undefined in.
  const decoded = decode({ broker: "mt5", label: "CT-5" })
  expect(decoded.broker).toBe("mt5")
  expect(decoded.port).toBeUndefined()
  expect(Object.keys(decoded)).not.toContain("port")
})

test("LinkAddPayload carries the MT5 identity the registered watch reads: login plus server", () => {
  // The detected-account pick rides these two fields next to the registration; both are
  // optional (an engine predating the MT5 bridge simply never sees them set) and stay off
  // the wire entirely when absent — the IBKR-shaped registration must not gain keys.
  const decoded = decode({ broker: "mt5", label: "CT-5", mt5Login: 5058203356, mt5Server: "MetaQuotes-Demo" })
  expect(decoded.broker).toBe("mt5")
  expect(decoded.mt5Login).toBe(5058203356)
  expect(decoded.mt5Server).toBe("MetaQuotes-Demo")
  const plain = decode({})
  expect(Object.keys(plain)).not.toContain("mt5Login")
  expect(Object.keys(plain)).not.toContain("mt5Server")
})

test("LinkAddPayload stays the IBKR TWS registration when nothing extra is asked", () => {
  // No broker means the TWS socket the endpoint has always dialed; the added field must
  // be invisible in that encoded shape.
  const decoded = decode({})
  expect(Object.keys(decoded)).not.toContain("broker")
  expect(Object.keys(decoded)).not.toContain("port")
  expect(decode({ host: "127.0.0.1", port: 7496 })).toEqual({ host: "127.0.0.1", port: 7496 })
})

test("LinkAddPayload bounds its host like its label: an address, not an endless string", () => {
  // The engine's link id builds on the host the same way it builds on the MT5 server, so
  // the wire refuses the same fat payload a fat label once smuggled through (the pattern
  // behind the cap is the engine's own check — the schema carries the length).
  expect(decode({ host: "127.0.0.1" })).toEqual({ host: "127.0.0.1" })
  expect(decode({ host: "a".repeat(80) })).toEqual({ host: "a".repeat(80) })
  expect(() => decode({ host: "a".repeat(81) })).toThrow()
})
