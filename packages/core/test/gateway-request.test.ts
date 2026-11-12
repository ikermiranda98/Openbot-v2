import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { HttpClientRequest } from "effect/http"
import { Database } from "@opencode/core/database/database"
import { GatewayRequest } from "@opencode/core/gateway/request"
import { GatewayRequestTable } from "@opencode/core/gateway/sql"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Database.node])))

const request = (input: {
  method?: "POST" | "GET"
  url?: string
  authorization?: string
  project?: string
}) => {
  const make = input.method === "GET" ? HttpClientRequest.get : HttpClientRequest.post
  let value = make(input.url ?? "https://opencode.ai/inference/v1/chat/completions")

  if (input.authorization) value = HttpClientRequest.setHeader(value, "authorization", input.authorization)
  if (input.project) value = HttpClientRequest.setHeader(value, "x-opencode-project", input.project)
  return value
}

describe("GatewayRequest", () => {
  it.effect("records finished free requests and leaves out every other one, the gateway's own refusal first", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const free = request({ authorization: "Bearer public", project: "prj_desk" })

      yield* GatewayRequest.record(db, free, 200)
      // A dispatched failure on the free route is still a request behind the gateway's counter.
      yield* GatewayRequest.record(db, free, 500)
      // Its refusal is the limit speaking, not another request behind it.
      yield* GatewayRequest.record(db, free, 429)
      // The paid Zen routes share the host but not the free counter.
      yield* GatewayRequest.record(db, request({ authorization: "Bearer secret" }), 200)
      // A read never reaches the counter.
      yield* GatewayRequest.record(db, request({ authorization: "Bearer public", method: "GET" }), 200)
      yield* GatewayRequest.record(
        db,
        request({ authorization: "Bearer public", url: "https://opencode.ai/zen/v1/chat/completions" }),
        200,
      )

      const rows = yield* db.select().from(GatewayRequestTable).all()

      expect(rows).toHaveLength(2)
      expect(rows.map((row) => row.project_id)).toEqual(["prj_desk", "prj_desk"])
    }),
  )
})
