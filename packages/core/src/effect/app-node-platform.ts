import { LLMClient, RequestExecutor } from "@opencode/ai/route"
import { Effect, Layer } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { Socket } from "effect/socket"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { httpClient } from "@opencode/util/effect/app-node-platform"
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

const executor = RequestExecutor.layer.pipe(Layer.provide(withoutBunTimeout))

// Every finished free request passes through here: one row per response the gateway counts,
// read by SessionStats so the free-allowance ring measures this desk's whole traffic instead
// of only the steps that leave a session message.
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
).pipe(Layer.provide(executor))

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
