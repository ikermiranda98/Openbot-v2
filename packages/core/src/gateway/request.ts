export * as GatewayRequest from "./request.js"

import { Effect } from "effect"
import type { HttpClientRequest } from "effect/http"
import { Database } from "../database/database.js"
import { GatewayRequestTable } from "./sql.js"

const inferenceURL = "https://opencode.ai/inference/"
const freeAuthorization = "Bearer public"

/** Records one request the gateway's free counter holds: any finished free response except the
 * gateway's own refusal (a 429 is the limit speaking, not another request behind it). A failure
 * to store the count must never fail the model call. */
export const record = (
  db: Database.Interface["db"],
  request: HttpClientRequest.HttpClientRequest,
  status: number,
) =>
  status === 429 || !isFreeGatewayRequest(request)
    ? Effect.void
    : db
        .insert(GatewayRequestTable)
        .values({
          created: Date.now(),
          project_id: header(request, "x-opencode-project") ?? null,
        })
        .run()
        .pipe(Effect.catchCause(() => Effect.void))

// The paid Zen routes share the host but not the free counter: only the anonymous tier's
// `Bearer public` (and only a model call, never a read) is one of the gateway's requests.
function isFreeGatewayRequest(request: HttpClientRequest.HttpClientRequest) {
  if (request.method !== "POST") return false
  if (!request.url.startsWith(inferenceURL)) return false
  return header(request, "authorization") === freeAuthorization
}

function header(request: HttpClientRequest.HttpClientRequest, name: string) {
  return Object.entries(request.headers).find(([key]) => key.toLowerCase() === name)?.[1]
}
