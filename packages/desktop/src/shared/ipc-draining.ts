import { Schema } from "effect"
import { RpcMiddleware } from "effect/rpc"

export const DrainingNotAllowed = Schema.TaggedStruct("DrainingNotAllowed", {
  message: Schema.String,
})

export const DRAINING_ALLOWED_RPCS = new Set(["StorageUpdate"])

export class DrainingMiddleware extends RpcMiddleware.Service<DrainingMiddleware>()(
  "opencode/desktop/DrainingMiddleware",
  { error: DrainingNotAllowed },
) {}

export function isRpcAllowedWhileDraining(rpc: string | { readonly _tag: string }): boolean {
  const tag = typeof rpc === "string" ? rpc : rpc._tag
  return DRAINING_ALLOWED_RPCS.has(tag)
}

// Re-export Context for convenience is not needed; keep service usage explicit.