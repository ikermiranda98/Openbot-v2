import { LLMClient, RequestExecutor } from "@opencode/ai/route"
import { Effect, Layer, Option } from "effect"
import { FetchHttpClient, HttpClient, HttpClientError } from "effect/http"
import { Socket } from "effect/socket"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { httpClient } from "@opencode/util/effect/app-node-platform"
import { ClientTls } from "#client-tls"
import { Database } from "../database/database.js"
import { GatewayRequest } from "../gateway/request.js"
import { WebSocketConstructor } from "./websocket-constructor.js"

// Bun's fetch ends a request after five quiet minutes, before provider routes' own header and chunk timeouts.
const withoutBunTimeout = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    return HttpClient.transformResponse(
      client,
      Effect.provideService(FetchHttpClient.RequestInit, { timeout: false } as BunFetchRequestInit),
    )
  }),
)

// Presents the model's client certificate (provider `settings.tls`) on its HTTPS requests, through this runtime's
// certificate-capable fetch. The TLS handshake only sends it to servers that request one.
const withClientCertificate = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    return HttpClient.transform(client, (effect, request) =>
      Effect.gen(function* () {
        const tls = yield* RequestExecutor.CurrentTls
        if (!tls || !request.url.startsWith("https:")) return yield* effect
        const sender = ClientTls.sender(tls)
        if (!sender)
          return yield* new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              description: "Client certificates aren't supported on this runtime",
            }),
          })
        const init: RequestInit = Option.getOrElse(yield* Effect.serviceOption(FetchHttpClient.RequestInit), () => ({}))
        return yield* HttpClient.execute(request).pipe(
          Effect.provide(FetchHttpClient.layer),
          Effect.provideService(FetchHttpClient.Fetch, sender.fetch),
          Effect.provideService(FetchHttpClient.RequestInit, {
            ...init,
            ...sender.init,
            // A followed redirect keeps the TLS options, so it would present the certificate to whatever host the
            // server names.
            redirect: init.redirect === "manual" ? "manual" : "error",
          }),
        )
      }),
    )
  }),
)

// Every finished free request passes through here: one row per response the gateway counts,
// read by SessionStats so the free-allowance ring measures this desk's whole traffic instead
// of only the steps that leave a session message. It wraps upstream's executor, which keeps
// its Bun timeout override and client certificates.
const gatewayRequests = Layer.unwrap(
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const inner = yield* RequestExecutor.Service
    const record = (request: Parameters<RequestExecutor.HttpMiddleware>[0], handler: Parameters<RequestExecutor.HttpMiddleware>[1]) =>
      handler(request).pipe(Effect.tap((response) => GatewayRequest.record(db, request, response.status)))

    return Layer.succeed(
      RequestExecutor.Service,
      RequestExecutor.Service.of({
        execute: (request, next) =>
          inner.execute(
            request,
            next === undefined ? record : (input, handler) => record(input, (forwarded) => next(forwarded, handler)),
          ),
      }),
    )
  }),
).pipe(Layer.provide(RequestExecutor.layer.pipe(Layer.provide(withoutBunTimeout), Layer.provide(withClientCertificate))))

export const requestExecutor = makeGlobalNode({
  service: RequestExecutor.Service,
  layer: gatewayRequests,
  deps: [httpClient, Database.node],
})

export const llmClient = makeGlobalNode({ service: LLMClient.Service, layer: LLMClient.layer, deps: [requestExecutor] })

export const webSocketConstructor = makeGlobalNode({
  service: Socket.WebSocketConstructor,
  layer: WebSocketConstructor.layer,
  deps: [],
})

export * as LayerNodePlatform from "./app-node-platform.js"
