import { Ghost } from "@opencode/schema/ghost"
import { Schema } from "effect"
import { HttpApiEndpoint, OpenApi } from "effect/http-api"
import { InvalidRequestError } from "../errors.js"

const EXPERIMENTAL = "Experimental: may change without compatibility guarantees."
const annotations = (identifier: string, summary: string, description: string) =>
  OpenApi.annotations({
    identifier: `experimental.ghost.${identifier}`,
    summary,
    description: `${description} ${EXPERIMENTAL}`,
    // The routes share the `server.experimental` group with the persistent PTY prototype; tag them on their own.
    transform: (operation) => ({ ...operation, tags: ["experimental"] }),
  })

/** Lives in the `server.experimental` group (see `groups/experimental.ts`). */
export const GhostEndpoints = [
  HttpApiEndpoint.post("ghost.rotate", "/api/experimental/ghost/rotate", {
    payload: Ghost.RotateInput,
    success: Schema.Struct({ data: Ghost.RotateResult }),
    error: [InvalidRequestError],
  }).annotateMerge(
    annotations(
      "rotate",
      "Rotate this machine's WARP exit /64",
      "Run the ghost engine's full rotation cycle once: take the shared ghost lock, hang Cloudflare WARP up and land it on a /64 this day's memory has not used yet (re-registering after a dead tunnel), then, when no live ghost session is already managing the exit, pin opencode.ai's IPv6 to a curl-verified candidate and finish with the egress check — the answer only reads ok after the app's own CDN trace answers over IPv6. It shares the desktop bat's lock, memory and event files, so the button and the bat never rotate at once or double-count a used /64, and it never closes or restarts the app.",
    ),
  ),
  HttpApiEndpoint.post("ghost.release", "/api/experimental/ghost/release", {
    success: Schema.Struct({ data: Ghost.ReleaseResult }),
    error: [InvalidRequestError],
  }).annotateMerge(
    annotations(
      "release",
      "Release this machine's WARP exit",
      "Drop the exit when the free day renewed for this machine's own address: the hosts pin comes off and Cloudflare WARP hangs up, so the app rides its own address again — a later limit error rotates back the same way. A rotation running right now keeps its exit (release retires through the shared lock) and the caller retries quietly.",
    ),
  ),
  HttpApiEndpoint.get("ghost.status", "/api/experimental/ghost/status", {
    success: Schema.Struct({ data: Ghost.Status }),
    error: [InvalidRequestError],
  }).annotateMerge(
    annotations(
      "status",
      "Read the ghost engine's WARP state",
      "Read what this machine's engine and Cloudflare WARP answer right now: the tunnel's client state, whether a rotation is running in the engine, and the day's landed /64s with the current one. It writes nothing and never rotates, so an open page may poll it.",
    ),
  ),
  HttpApiEndpoint.get("ghost.history", "/api/experimental/ghost/history", {
    success: Schema.Struct({ data: Schema.Array(Ghost.Run) }),
    error: [InvalidRequestError],
  }).annotateMerge(
    annotations(
      "history",
      "List the ghost engine's finished rotations",
      "List this engine's finished rotations, oldest first: who asked, whether a fresh /64 landed (with the previous and the landed bucket), the ladder's attempts and how long the run lasted. It reads the engine's own run log only.",
    ),
  ),
] as const
