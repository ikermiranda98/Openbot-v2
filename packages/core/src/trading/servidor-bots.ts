// The bots' local API: what OpenBot's `ib_async` stand-in calls instead of TWS. It listens on
// 127.0.0.1 only, on a free port, and every request names its system by the token the engine
// handed that bot at launch (header `X-OpenBot-Bot`). Answers are JSON; a refusal is
// `{ "error": "…" }` with 409 (401 for a wrong token), which the stand-in turns into the
// errors `ib_async` itself would raise or log.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { Schema } from "effect"
import type { Traductor } from "./bots-mt5.js"

const Contrato = Schema.Struct({
  secType: Schema.optional(Schema.String),
  symbol: Schema.optional(Schema.String),
  currency: Schema.optional(Schema.String),
  exchange: Schema.optional(Schema.String),
  conId: Schema.optional(Schema.Number),
})

const Velas = Schema.Struct({
  conId: Schema.Number,
  end: Schema.optional(Schema.NullOr(Schema.Number)),
  duration: Schema.String,
  barSize: Schema.String,
})

const Orden = Schema.Struct({
  orderId: Schema.optional(Schema.Number),
  clientId: Schema.optional(Schema.Number),
  conId: Schema.Number,
  action: Schema.String,
  orderType: Schema.String,
  totalQuantity: Schema.Number,
  auxPrice: Schema.optional(Schema.Number),
  lmtPrice: Schema.optional(Schema.Number),
  tif: Schema.optional(Schema.String),
  ocaGroup: Schema.optional(Schema.String),
})

const Cancelar = Schema.Struct({ orderId: Schema.Number })

const decodificar = {
  contrato: Schema.decodeUnknownSync(Schema.fromJsonString(Contrato)),
  velas: Schema.decodeUnknownSync(Schema.fromJsonString(Velas)),
  orden: Schema.decodeUnknownSync(Schema.fromJsonString(Orden)),
  cancelar: Schema.decodeUnknownSync(Schema.fromJsonString(Cancelar)),
}

const cuerpo = (req: IncomingMessage) =>
  new Promise<string>((resolver, rechazar) => {
    const trozos: Buffer[] = []
    req.on("data", (trozo: Buffer) => trozos.push(trozo))
    req.on("end", () => resolver(Buffer.concat(trozos).toString("utf8")))
    req.on("error", rechazar)
  })

const responder = (res: ServerResponse, codigo: number, datos: unknown) => {
  const texto = JSON.stringify(datos)
  res.writeHead(codigo, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(texto) })
  res.end(texto)
}

export interface ServidorBots {
  readonly url: string
  readonly cerrar: () => Promise<void>
}

/** Starts the bots' API on a free loopback port. */
export const iniciarServidorBots = (traductor: Traductor, sistemaDeToken: (token: string) => string | null) =>
  new Promise<ServidorBots>((resolver, rechazar) => {
    const servidor = createServer((req, res) => {
      void (async () => {
        const token = req.headers["x-openbot-bot"]
        const sistema = typeof token === "string" && token.length >= 16 ? sistemaDeToken(token) : null
        if (sistema === null) return responder(res, 401, { error: "token de bot inválido" })
        const ruta = `${req.method ?? "GET"} ${(req.url ?? "").split("?")[0]}`
        const texto = req.method === "POST" ? await cuerpo(req) : ""
        switch (ruta) {
          case "GET /bot/hello":
            return responder(res, 200, traductor.hello(sistema))
          case "POST /bot/qualify":
            return responder(res, 200, await traductor.qualify(sistema, decodificar.contrato(texto)))
          case "POST /bot/bars": {
            const v = decodificar.velas(texto)
            return responder(res, 200, await traductor.bars(sistema, v.conId, v.end ?? null, v.duration, v.barSize))
          }
          case "POST /bot/order":
            return responder(res, 200, await traductor.place(sistema, decodificar.orden(texto)))
          case "POST /bot/cancel":
            return responder(res, 200, await traductor.cancel(sistema, decodificar.cancelar(texto).orderId))
          case "GET /bot/orders":
            return responder(res, 200, traductor.ordenesDe(sistema))
          case "GET /bot/fills":
            return responder(res, 200, traductor.ejecucionesDe(sistema))
          case "GET /bot/positions":
            return responder(res, 200, traductor.positions(sistema))
          case "GET /bot/account":
            return responder(res, 200, traductor.accountSummary(sistema))
          default:
            return responder(res, 404, { error: `ruta desconocida: ${ruta}` })
        }
      })().catch((error: unknown) => {
        if (!res.headersSent) responder(res, 409, { error: error instanceof Error ? error.message : String(error) })
      })
    })
    servidor.on("error", rechazar)
    servidor.listen(0, "127.0.0.1", () => {
      const direccion = servidor.address() as AddressInfo
      resolver({
        url: `http://127.0.0.1:${direccion.port}`,
        cerrar: () => new Promise<void>((cerrado) => servidor.close(() => cerrado())),
      })
    })
  })
