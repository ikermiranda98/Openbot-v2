export * as Ghost from "./ghost.js"

import { Schema } from "effect"
import { optional } from "./schema.js"

/** One rotation attempt: whether the WARP exit moved onto a `/64` this day had not
 * used yet and the machine still reaches opencode.ai over IPv6, carrying the exact
 * address the probe saw when it did. `address` is absent on a failed attempt. */
export const RotateResult = Schema.Struct({
  ok: Schema.Boolean,
  address: optional(Schema.String),
}).annotate({ identifier: "Ghost.RotateResult" })
export interface RotateResult extends Schema.Schema.Type<typeof RotateResult> {}

/** Where a rotation came from: the ring's globe (manual), its own threshold watch (auto) or
 * the gateway's limit error (limit). The engine only records it in the run's history. */
export const RotateOrigin = Schema.Literals(["manual", "auto", "limit"]).annotate({
  identifier: "Ghost.RotateOrigin",
})
export type RotateOrigin = Schema.Schema.Type<typeof RotateOrigin>

/** One release of the WARP exit: ok reads true only once the pin is verifiably gone and the
 * machine's own address serves OpenCode again — the tunnel hung up, or no warp-cli was left
 * to hang it up with. Every refusal (ok false, WARP left untouched) is an ordinary outcome
 * the caller retries after its next status read: a rotation already running, the ghost flag
 * off, an unreadable hosts file (a pin may stand that nothing would then serve), a pin the
 * hosts refuse to drop, or a disconnect that never landed. Only the free day's renewal asks
 * for it. */
export const ReleaseResult = Schema.Struct({
  ok: Schema.Boolean,
}).annotate({ identifier: "Ghost.ReleaseResult" })
export interface ReleaseResult extends Schema.Schema.Type<typeof ReleaseResult> {}

/** The rotation's input: who asked. An empty body still reads as manual. */
export const RotateInput = Schema.Struct({
  origin: optional(RotateOrigin),
}).annotate({ identifier: "Ghost.RotateInput" })
export interface RotateInput extends Schema.Schema.Type<typeof RotateInput> {}

/** Between-rotation facts about WARP and this engine, one read per open page: the tunnel's
 * own client state, whether a rotation is running, and what the day has landed so far. `pin`
 * marks the hosts pin the rotation program itself writes — the one fact that tells a tunnel
 * the program owns (it may outlive its app) from a WARP someone else connected. */
export const Status = Schema.Struct({
  warp: Schema.Literals(["connected", "disconnected", "unavailable", "missing"]),
  rotating: Schema.Boolean,
  attempts: Schema.Finite,
  attempt: optional(Schema.Finite),
  rotations: Schema.Finite,
  current: optional(Schema.String),
  pin: optional(Schema.Boolean),
}).annotate({ identifier: "Ghost.Status" })
export interface Status extends Schema.Schema.Type<typeof Status> {}

/** One finished rotation: who asked, whether a fresh /64 landed and with what, how many
 * ladder attempts it took and how long the whole run lasted. */
export const Run = Schema.Struct({
  at: Schema.Finite,
  origin: RotateOrigin,
  ok: Schema.Boolean,
  from: optional(Schema.String),
  to: optional(Schema.String),
  attempts: Schema.Finite,
  durationMs: Schema.Finite,
}).annotate({ identifier: "Ghost.Run" })
export interface Run extends Schema.Schema.Type<typeof Run> {}
