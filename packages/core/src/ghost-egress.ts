export * as GhostEgress from "./ghost-egress.js"

import { Context, Effect, Layer, Option } from "effect"
import { Agent, request as httpsRequest } from "node:https"
import { Readable } from "node:stream"
import { makeGlobalNode } from "@opencode/util/effect/app-node"

// The ghost egress is the bat's pin, moved inside the process. The hosts pin forced the app over
// IPv6 by deleting the A records; that needs an administrator and a fresh DNS read. Here the
// provider transport itself asks for the gateway by its own name over a socket opened to the
// pinned Cloudflare IPv6, so no resolver, no hosts file and no elevation take part. The pool is
// the rotation: a fresh /64 only reaches the app when its next connection is a new one, so the
// engine points this egress at a verified address and drops every socket the old exit was using.
// The app keeps running — its reloaded history, its open tabs and its in-flight reads — while the
// traffic that matters leaves by the new bucket.

/** One verified exit: the address the traffic is opened to, and the WARP egress it leaves by. */
export type Exit = { readonly address: string; readonly exit: string }

/** The gateway whose requests the ghost carries: the pin's own subject, and `opencode.ai` only. */
const GATEWAY = "opencode.ai"

const TRACE_PATH = "/cdn-cgi/trace"
const PROBE_TIMEOUT_MS = 8_000
const MAX_REDIRECTS = 5

// Keep-alive is what makes the rotation meaningful: the sockets a request lands on outlive it, so
// the engine can hand the next request a new exit by discarding the whole pool. The caps are a
// provider client's own order of magnitude, not a browser's.
const POOL = { keepAlive: true, maxSockets: 32, maxFreeSockets: 8 }

/** Bun's `typeof fetch` adds `preconnect`, which nothing here calls. */
type AnyInit = RequestInit & { timeout?: number | boolean }
export type Fetch = (input: Request | string | URL, init?: AnyInit) => Promise<Response>

type Send = {
  readonly method: string
  readonly headers: Headers
  readonly body?: Uint8Array
  readonly signal?: AbortSignal
  readonly agent: Agent
}

const isGateway = (url: URL) => {
  if (url.protocol !== "https:" || (url.port !== "" && url.port !== "443")) return false
  const host = url.hostname.toLowerCase()
  return host === GATEWAY || host.endsWith(`.${GATEWAY}`)
}

const traceOf = (clave: string, cuerpo: string) => {
  const line = cuerpo.split(/\r?\n/).find((line) => line.toLowerCase().startsWith(`${clave}=`))
  return line?.slice(clave.length + 1).trim()
}

/** One request opened by address, named by the gateway: the TLS handshake carries the gateway's
 * SNI and Host, so the edge serves its certificate and routes the request as ever, while the
 * socket's own source address is whatever the fresh /64 gives it. */
const send = (address: string, target: URL, init: Send) =>
  new Promise<Response>((resolve, reject) => {
    const headers = Object.fromEntries(init.headers)
    const req = httpsRequest(
      {
        host: address,
        port: 443,
        servername: target.hostname,
        path: `${target.pathname}${target.search}`,
        method: init.method,
        headers,
        agent: init.agent,
        // The Host header was set from the gateway's own name above, so the request keeps its
        // routing even though the socket is opened to the address literal.
      },
      (res) => {
        const outgoing = new Headers()
        for (const [name, value] of Object.entries(res.headers)) {
          if (value === undefined) continue
          if (Array.isArray(value)) for (const item of value) outgoing.append(name, item)
          else outgoing.set(name, value)
        }
        const status = res.statusCode ?? 502
        const sinCuerpo = status === 204 || status === 205 || status === 304 || init.method === "HEAD"
        const body = sinCuerpo ? null : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>)
        resolve(new Response(body, { status, statusText: res.statusMessage ?? "", headers: outgoing }))
      },
    )
    const abort = () => req.destroy(new Error("The operation was aborted"))
    if (init.signal?.aborted) abort()
    init.signal?.addEventListener("abort", abort, { once: true })
    req.on("close", () => init.signal?.removeEventListener("abort", abort))
    req.on("error", reject)
    req.end(init.body)
  })

/** The answer the engine waits for: the same path the app's next request takes, proved over
 * IPv6, inside WARP, and by a socket this run opened. Anything else is no landing at all. */
const probe = (address: string, agent: Agent) =>
  Effect.tryPromise({
    try: () =>
      new Promise<Exit>((resolve, reject) => {
        const req = httpsRequest(
          {
            host: address,
            port: 443,
            servername: GATEWAY,
            path: TRACE_PATH,
            method: "GET",
            headers: { host: GATEWAY },
            agent,
          },
          (res) => {
            let body = ""
            res.setEncoding("utf8")
            res.on("data", (chunk) => (body += chunk))
            res.on("end", () => {
              const ip = traceOf("ip", body)
              const warp = traceOf("warp", body)
              const family = req.socket?.remoteFamily
              if (res.statusCode !== 200 || ip === undefined || warp !== "on" || family !== "IPv6") {
                reject(
                  new Error(
                    `egress ${address}: status=${res.statusCode} warp=${warp ?? "?"} family=${family ?? "?"}`,
                  ),
                )
                return
              }
              resolve({ address, exit: ip })
            })
          },
        )
        req.setTimeout(PROBE_TIMEOUT_MS, () => req.destroy(new Error(`egress ${address}: timeout`)))
        req.on("error", reject)
        req.end()
      }),
    catch: (cause) => cause,
  }).pipe(Effect.option)

export interface Interface {
  /** Wraps the platform's own fetch: the gateway rides the ghost egress when one is pointed,
   * every other host passes straight through untouched. */
  readonly wrap: (base: Fetch) => Fetch
  /** Points the gateway's traffic at the first address that proves a fresh IPv6 exit, opening a
   * new pool as it goes. A candidate that cannot prove itself is dropped, and none leaves the
   * egress cleared: the caller answers ok:false instead of promising a rotation that cannot
   * serve the app. */
  readonly point: (addresses: readonly string[]) => Effect.Effect<Option.Option<Exit>>
  /** Hands the machine back its own address: the gateway returns to the platform fetch and the
   * pool is dropped, so nothing keeps riding an exit whose day is over. */
  readonly release: Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/GhostEgress") {}

// The pool and the pointed address live at module scope: the egress is one process-wide resource
// — one set of sockets, one exit — and the boot and location graphs must see the same one, since
// the rotation runs in the first while the provider's transport was built in the second.
let target: string | undefined = undefined
let pool = new Agent(POOL)

const rebind = () => {
  pool.destroy()
  pool = new Agent(POOL)
}

export const layer = Layer.succeed(
  Service,
  Service.of({
    wrap: (base) => async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      const pointed = target
      // `point` and `release` swap the field, not the wrapped function, so a transport the AI SDK
      // built before the first rotation still sees every later one.
      if (pointed === undefined || !isGateway(url)) return base(input, init)

      const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init)
      const body =
        request.method === "GET" || request.method === "HEAD" ? undefined : new Uint8Array(await request.arrayBuffer())
      const headers = new Headers(request.headers)
      headers.delete("host")
      headers.set("host", url.hostname)
      if (body !== undefined) headers.set("content-length", String(body.byteLength))

      let current = url
      let method = request.method
      let payload = body

      for (let salto = 0; salto <= MAX_REDIRECTS; salto++) {
        const response = await send(pointed, current, {
          method,
          headers,
          body: payload,
          signal: request.signal,
          agent: pool,
        })
        const redirige = [301, 302, 303, 307, 308].includes(response.status) && request.redirect !== "manual"
        const location = redirige ? response.headers.get("location") : null

        if (location === null) return response

        const next = new URL(location, current)
        // A redirect out of the gateway is no longer the ghost's business: it leaves by the
        // transport the rest of the app uses, so a login or a docs hop behaves normally.
        if (!isGateway(next)) {
          return base(next, { method, headers, body: payload, signal: request.signal })
        }
        if (response.status === 303) {
          method = "GET"
          payload = undefined
          headers.delete("content-length")
        }
        current = next
      }

      throw new Error(`egress ${pointed}: too many redirects`)
    },
    point: (addresses) =>
      Effect.gen(function* () {
        const candidatos = [...new Set(addresses.filter((address) => address.includes(":")))]
        for (const address of candidatos) {
          target = address
          rebind()
          const trace = yield* probe(address, pool)
          if (Option.isSome(trace)) return trace
        }
        target = undefined
        rebind()
        return Option.none<Exit>()
      }),
    release: Effect.sync(() => {
      target = undefined
      rebind()
    }),
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
