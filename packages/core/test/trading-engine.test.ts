import { describe, expect, setSystemTime } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer, type AddressInfo, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import { Effect, Fiber } from "effect"
import { Database } from "@opencode/core/database/database"
import { InvalidTaskError, MENSAJE_HOST_TWS, TaskNotFoundError, TradingEngine } from "@opencode/core/trading"
import { TradingAccountTable, TradingCloseTable, TradingLinkTable, TradingMetaTable } from "@opencode/core/trading/sql"
import { Trading } from "@opencode/schema/trading"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node]), []))

/** One engine boot over the shared database (a real `layer()` build, an empty temp pool).
 * The boot scan stops at its first warning — no pool systems to resolve, no pythonw probe,
 * no TWS socket: the interface's own "nothing connects at boot" is what makes this
 * testable without a fake IB adapter. Two boots in one body read the same database, so
 * the restart contracts run for real: the second engine restores what the first persisted. */
const arrancar = (pool: string, port?: number) =>
  Effect.gen(function* () {
    return yield* TradingEngine.Service
  }).pipe(
    Effect.provide(TradingEngine.layer({ systemsDir: pool, ...(port === undefined ? {} : { port }) })),
  )

const conPool = <A, E, R>(prueba: (pool: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "opencode-trading-"))),
    prueba,
    (pool) => Effect.tryPromise(() => rm(pool, { recursive: true, force: true })).pipe(Effect.ignore),
  )

/** One TWS API message as the wire frames it: a big-endian length, then NUL-ended fields. */
const trama = (campos: string[]) => {
  const cuerpo = Buffer.from(campos.map((campo) => `${campo}\0`).join(""))
  const largo = Buffer.alloc(4)
  largo.writeUInt32BE(cuerpo.length)
  return Buffer.concat([largo, cuerpo])
}

/** A fake TWS on a free local port: it answers the API handshake with a server version, then
 * hands the socket to `tras` for whatever the case needs. */
const twsFalso = (tras: (socket: Socket) => void) =>
  Effect.promise(() => {
    const servidor = createServer((socket) => {
      socket.on("error", () => {})
      socket.once("data", () => {
        socket.write(trama(["193", "20261105 03:55:06 CET"]))
        tras(socket)
      })
    })
    return new Promise<{ puerto: number; cerrar: () => Promise<void> }>((resolve) =>
      servidor.listen(0, "127.0.0.1", () =>
        resolve({
          puerto: (servidor.address() as AddressInfo).port,
          cerrar: () => new Promise<void>((cerrado) => servidor.close(() => cerrado())),
        }),
      ),
    )
  })

/** Waits (real time, bounded) until a record line passes the check. */
const esperarLinea = (engine: TradingEngine.Interface, pasa: (linea: string) => boolean) =>
  Effect.promise(async () => {
    const limite = Date.now() + 10_000
    while (!engine.snapshot().logs.some((fila) => pasa(fila.message)) && Date.now() < limite) await Bun.sleep(50)
  })

/** One claim row, read raw. The tests assert the stored token (the verdict is JSON text,
 * null while open) rather than any mirror of the engine's memory. */
const readClaim = (id: string) =>
  Effect.gen(function* () {
    const base = yield* Database.Service
    return (yield* base.db.select().from(TradingCloseTable).where(eq(TradingCloseTable.id, id)).get()) ?? null
  })

/** Crafts one claim row with full control over the clocks and shapes the claim logic read. */
const seedClaim = (claim: { id: string; symbol: string; lock: string | null; verdict: Trading.PositionCloseResult | null; ts: number }) =>
  Effect.gen(function* () {
    const base = yield* Database.Service
    yield* base.db
      .insert(TradingCloseTable)
      .values({
        id: claim.id,
        symbol: claim.symbol,
        lock: claim.lock,
        verdict: claim.verdict === null ? null : JSON.stringify(claim.verdict),
        ts: claim.ts,
        time_created: claim.ts,
        time_updated: claim.ts,
      })
      .run()
  })

/** One fake TWS serving a single account (A) holding one MNQZ6 long: the sweep target the
 * panic tests close. A placed order's frame counts in `cuenta.ordenes`, answers Filled, and
 * from then on the position stream carries no row — TWS retires a filled row itself. */
const twsDePosicion = () => {
  const cuenta = { ordenes: 0 }
  return Effect.map(
    twsFalso((socket) => {
      let pendiente = Buffer.alloc(0)
      let identrego = "60001"
      let idSiguiente = 60_001
      let cerrado = false
      socket.on("data", (pedazo: Buffer) => {
        pendiente = Buffer.concat([pendiente, pedazo])
        for (;;) {
          if (pendiente.length < 4) return
          const largo = pendiente.readUInt32BE(0)
          if (pendiente.length < 4 + largo) return
          const campos = pendiente.subarray(4, 4 + largo).toString("utf8").split("\0")
          pendiente = pendiente.subarray(4 + largo)
          const id = campos[0]
          if (id === "71") socket.write(trama(["9", "1", String(idSiguiente++)]))
          else if (id === "17") socket.write(trama(["15", "1", "A"]))
          else if (id === "62") {
            const reqId = campos[2]
            socket.write(trama(["63", "1", reqId, "A", "AccountType", "Individual", "USD"]))
            socket.write(trama(["64", "1", reqId]))
          } else if (id === "61") {
            // The MNQZ6 future row: strike, right and multiplier in wire order, then trading
            // class, size and cost — the shape the R7 close read stands on.
            if (!cerrado)
              socket.write(trama(["61", "3", "A", "711712", "MNQZ6", "FUT", "20261218", "", "", "2", "GLOBEX", "USD", "MNQZ6", "MNQ", "1", "37000"]))
            socket.write(trama(["62", "1"]))
          } else if (id === "16") socket.write(trama(["53", "1"]))
          else if (id === "7") socket.write(trama(["55", "1", campos[2]]))
          else if (id === "8") {
            identrego = String(idSiguiente++)
            socket.write(trama(["9", "1", identrego]))
          } else if (id === "3") {
            cuenta.ordenes += 1
            cerrado = true
            // Order status carries no version token at server version 193.
            socket.write(trama(["3", identrego, "Filled", "1", "0", "0", "777", "0", "", "0", "", "0"]))
            socket.write(trama(["61", "3", "A", "711712", "MNQZ6", "FUT", "20261218", "", "", "2", "GLOBEX", "USD", "MNQZ6", "MNQ", "0", "37000"]))
            socket.write(trama(["62", "1"]))
          }
        }
      })
    }),
    (tws) => ({ ...tws, cuenta }),
  )
}

describe("TradingEngine", () => {
  it.effect("scheduled tasks persist, cancel only while pending, and refuse impossible schedules", () =>
    conPool((pool) =>
      Effect.gen(function* () {
        const primero = yield* arrancar(pool)
        const tarea = yield* primero.taskAdd({ kind: "start-systems", delayMinutes: 5 })
        expect(tarea.status).toBe("pending")
        expect(tarea.system_ids).toEqual([])
        expect(tarea.run_at).toBeGreaterThan(Date.now() + 4 * 60_000)

        expect((yield* primero.taskCancel(tarea.id)).status).toBe("cancelled")
        const repetida = yield* Effect.flip(primero.taskCancel(tarea.id))
        expect(repetida.message).toBe("Only pending tasks can be cancelled.")

        // The brand has no literal constructor — `create()` mints a fresh valid id,
        // guaranteed absent from the table, which is exactly what TaskNotFound wants.
        const fantasma = Trading.TaskID.create()
        const desconocida = yield* Effect.flip(primero.taskCancel(fantasma))
        if (!(desconocida instanceof TaskNotFoundError)) return yield* Effect.die(desconocida)
        expect(desconocida.taskID).toBe(fantasma)

        const ambos = yield* Effect.flip(primero.taskAdd({ kind: "stop-systems", delayMinutes: 5, atTime: "09:30" }))
        expect(ambos.message).toBe("Give either delayMinutes or atTime, not both.")
        const ninguno = yield* Effect.flip(primero.taskAdd({ kind: "stop-systems" }))
        expect(ninguno.message).toBe("Give delayMinutes or atTime.")
        const cero = yield* Effect.flip(primero.taskAdd({ kind: "stop-systems", delayMinutes: 0 }))
        expect(cero.message).toBe("delayMinutes must be a positive number of minutes.")
        const imposible = yield* Effect.flip(primero.taskAdd({ kind: "stop-systems", atTime: "25:99" }))
        expect(imposible.message).toBe('atTime must be a local "HH:MM" time.')

        // The cancelled verdict is the persisted state: the next boot's list shows the
        // task gone pending forever, not re-armed by the restart.
        const segundo = yield* arrancar(pool)
        expect((yield* segundo.taskList()).map((t) => ({ id: t.id, status: t.status }))).toEqual([
          { id: tarea.id, status: "cancelled" },
        ])
      }),
    ),
  )

  // C-02: the close's claim is durable. A submission whose verdict never made it back —
  // an engine restart between the request and the response — replays what the first
  // engine recorded instead of racing into a second order.
  it.effect("the systems folder moves to the user's pick only when it holds systems", () =>
    conPool((pool) =>
      Effect.gen(function* () {
        const engine = yield* arrancar(pool)
        expect(engine.snapshot().systems_dir).toBe(pool)

        // A folder with no NN_name systems is refused and the pool stays where it was.
        const vacía = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "opencode-trading-empty-")))
        const rechazo = yield* engine.poolSelect(vacía).pipe(Effect.flip)
        expect(rechazo.message).toContain("No systems in")
        expect(engine.snapshot().systems_dir).toBe(pool)

        // A folder holding one system becomes the pool, reloaded on the spot.
        const otra = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "opencode-trading-pick-")))
        yield* Effect.promise(async () => {
          await mkdir(join(otra, "07_prueba"))
          await writeFile(join(otra, "07_prueba", "bot.py"), "")
        })
        expect(yield* engine.poolSelect(otra)).toEqual({ dir: otra, systems: 1 })
        expect(engine.snapshot().systems_dir).toBe(otra)
        expect(engine.snapshot().systems.map((system) => system.id)).toEqual(["07"])

        yield* Effect.promise(() => Promise.all([rm(vacía, { recursive: true, force: true }), rm(otra, { recursive: true, force: true })]))
      }),
    ),
  )

  it.effect("a close claim records its verdict and replays it across boots", () =>
    conPool((pool) =>
      Effect.gen(function* () {
        const primero = yield* arrancar(pool)
        const salida = yield* primero.closePosition("MNQ", "reclamo-1")
        expect(salida).toEqual({ ok: false, message: "No connection to TWS: the close was not sent.", message_key: "trading.close.no_tws", message_params: {} })
        const fila = yield* readClaim("cierre:reclamo-1")
        expect(fila && { id: fila.id, symbol: fila.symbol, lock: fila.lock, verdict: fila.verdict }).toEqual({
          id: "cierre:reclamo-1",
          symbol: "MNQ",
          lock: null,
          verdict: JSON.stringify(salida),
        })

        const segundo = yield* arrancar(pool)
        expect(yield* segundo.closePosition("MNQ", "reclamo-1")).toEqual(salida)

        // The replay reads the recorded verdict, it does not re-run the cycle: a verdict
        // no live run could re-produce (a fake "ok" against no position at all) comes
        // back from the table exactly. Without the table this returns the fresh-run
        // refusal instead, so the test fails on persistence undone.
        yield* seedClaim({
          id: "cierre:guardado",
          symbol: "MNQ",
          lock: null,
          verdict: { ok: true, message: "Veredicto grabado por la sesión anterior: este sí." },
          ts: Date.now(),
        })
        expect(yield* segundo.closePosition("MNQ", "guardado")).toEqual({
          ok: true,
          message: "Veredicto grabado por la sesión anterior: este sí.",
        })
      }),
    ),
  )

  // C-02: the lock arbitrates two closes competing for the same contract across
  // processes. A fresh claim refuses without reordering; a claim past its window is a
  // dead session's leftover — absorbed with the synthetic death verdict, lock freed,
  // and a same-id repeat never reorders past it either way.
  it.effect("the claim arbitrates contracts and takes dead claims over", () =>
    conPool((pool) =>
      Effect.gen(function* () {
        const engine = yield* arrancar(pool)
        yield* seedClaim({ id: "cierre:trabajo", symbol: "MNQ", lock: "MNQ", verdict: null, ts: Date.now() })

        const ocupada = yield* engine.closePosition("MNQ", "reclamo-ajena")
        expect(ocupada).toEqual({ ok: false, message: "A close is already running for MNQ: wait for its verdict in the log.", message_key: "trading.close.busy", message_params: { symbol: "MNQ" } })
        const tenedor = yield* readClaim("cierre:trabajo")
        expect(tenedor && { lock: tenedor.lock, verdict: tenedor.verdict }).toEqual({ lock: "MNQ", verdict: null })

        yield* seedClaim({ id: "cierre:viejo", symbol: "M2K", lock: "M2K", verdict: null, ts: Date.now() - 6 * 60_000 })
        const salida = yield* engine.closePosition("M2K", "reclamo-toma")
        expect(salida).toEqual({ ok: false, message: "No connection to TWS: the close was not sent.", message_key: "trading.close.no_tws", message_params: {} })
        const absorbida = yield* readClaim("cierre:viejo")
        expect(absorbida && { lock: absorbida.lock, verdict: absorbida.verdict }).toEqual({
          lock: null,
          verdict: JSON.stringify({
            ok: false,
            message: "The previous close of M2K left no verdict: its session died mid-cycle; check TWS and Orders before retrying.", message_key: "trading.close.vestigio", message_params: { symbol: "M2K" },
          }),
        })
        const propia = yield* readClaim("cierre:reclamo-toma")
        expect(propia && { lock: propia.lock, verdict: propia.verdict }).toEqual({ lock: null, verdict: JSON.stringify(salida) })

        // The submission's own row: fresh means in flight (the repeat never reorders),
        // past the window means dead (the death verdict records and replays forever).
        yield* seedClaim({ id: "cierre:viva", symbol: "MES", lock: "MES", verdict: null, ts: Date.now() })
        const viva = yield* engine.closePosition("MES", "viva")
        expect(viva).toEqual({ ok: false, message: "A close is already running for MES: wait for its verdict in the log.", message_key: "trading.close.busy", message_params: { symbol: "MES" } })
        const vivaFila = yield* readClaim("cierre:viva")
        expect(vivaFila && { lock: vivaFila.lock, verdict: vivaFila.verdict }).toEqual({ lock: "MES", verdict: null })

        yield* seedClaim({ id: "cierre:propia-viva", symbol: "MGC", lock: "MGC", verdict: null, ts: Date.now() - 6 * 60_000 })
        const vestigio = yield* engine.closePosition("MGC", "propia-viva")
        expect(vestigio).toEqual({
          ok: false,
          message: "The previous close of MGC left no verdict: its session died mid-cycle; check TWS and Orders before retrying.", message_key: "trading.close.vestigio", message_params: { symbol: "MGC" },
        })
        const recordada = yield* readClaim("cierre:propia-viva")
        expect(recordada && { lock: recordada.lock, verdict: recordada.verdict }).toEqual({ lock: null, verdict: JSON.stringify(vestigio) })
      }),
    ),
  )

  // C-02: the close-all's verdict is durable too. A repeat of the same submission after a
  // restart replays the mass verdict, and a stranded mass claim refuses without touching
  // any contract — the mass row carries no lock, so nothing can race it.
  it.effect("the close-all's verdict persists and its stranded claim refuses", () =>
    conPool((pool) =>
      Effect.gen(function* () {
        const primero = yield* arrancar(pool)
        const salida = yield* primero.closeAllPositions("reclamo-todo")
        expect(salida).toEqual({ ok: false, message: "No connection to TWS: the close was not sent.", message_key: "trading.close.no_tws", message_params: {} })
        const masa = yield* readClaim("cierre-todo:reclamo-todo")
        expect(masa && { symbol: masa.symbol, lock: masa.lock, verdict: masa.verdict }).toEqual({
          symbol: "",
          lock: null,
          verdict: JSON.stringify(salida),
        })

        const segundo = yield* arrancar(pool)
        expect(yield* segundo.closeAllPositions("reclamo-todo")).toEqual(salida)

        // Same contract as the single close: the mass verdict replays from the table, not
        // from a re-run (the fresh run reads "Sin conexión" — it would never say this).
        yield* seedClaim({
          id: "cierre-todo:guardado",
          symbol: "",
          lock: null,
          verdict: { ok: true, message: "Cierre total grabado por la sesión anterior: 2 posición(es)." },
          ts: Date.now(),
        })
        expect(yield* segundo.closeAllPositions("guardado")).toEqual({
          ok: true,
          message: "Cierre total grabado por la sesión anterior: 2 posición(es).",
        })

        yield* seedClaim({ id: "cierre-todo:bloqueado", symbol: "", lock: null, verdict: null, ts: Date.now() })
        const bloqueada = yield* segundo.closeAllPositions("bloqueado")
        expect(bloqueada).toEqual({ ok: false, message: "A close-all is already running: wait for its verdict in the log.", message_key: "trading.close.busy", message_params: {} })
      }),
    ),
  )

  // Guard regression: the public close-all can never skip the AE-012 view guards — there
  // is no `total`/options knob on its signature, so a read-only watch stays refused.
  it.effect("closeAllPositions always applies the AE-012 view guards", () =>
    conPool((pool) =>
      Effect.gen(function* () {
        const base = yield* Database.Service
        const stamp = Date.now()
        yield* base.db
          .insert(TradingLinkTable)
          .values({ id: "127.0.0.1:7999", host: "127.0.0.1", port: 7999, label: "watch", broker: "ibkr", time_created: stamp, time_updated: stamp })
          .run()
        yield* base.db
          .insert(TradingAccountTable)
          .values({ id: "DU123", link_id: "127.0.0.1:7999", time_created: stamp, time_updated: stamp })
          .run()
        yield* base.db
          .insert(TradingMetaTable)
          .values({ id: "cuenta_activa", value: "DU123", time_created: stamp, time_updated: stamp })
          .run()
        const engine = yield* arrancar(pool)
        const salida = yield* engine.closeAllPositions("guardado-skip")
        expect(salida).toEqual({ ok: false, message: "The shown account (DU123) is read-only: not closed from here.", message_key: "trading.close.readonly_account", message_params: { account: "DU123" } })
      }),
    ),
  )

  // C-02: boot housekeeping purges recorded verdicts after a day. An open claim never
  // deletes — its verdict's absence is exactly the fact a later close (its takeover)
  // needs, however old it got.
  it.effect("boot housekeeping purges aged verdicts and never an open claim", () =>
    conPool((pool) =>
      Effect.gen(function* () {
        const ayer = Date.now() - 25 * 60 * 60_000
        yield* seedClaim({ id: "cierre:vencido", symbol: "MNQ", lock: null, verdict: { ok: false, message: "veredicto viejo" }, ts: ayer })
        yield* seedClaim({ id: "cierre:abierta", symbol: "M2K", lock: "M2K", verdict: null, ts: ayer - 24 * 60 * 60_000 })

        yield* arrancar(pool)

        expect(yield* readClaim("cierre:vencido")).toBeNull()
        const abierta = yield* readClaim("cierre:abierta")
        expect(abierta && { lock: abierta.lock, verdict: abierta.verdict }).toEqual({ lock: "M2K", verdict: null })
      }),
    ),
  )

  // The wizard's port search and its check before registering read one fact: whether
  // something accepts a TCP connection there. A real listener answers open, the same port
  // once closed answers closed, and an address linkAdd would refuse is refused here too.
  it.effect("the IBKR port search reports which addresses answer", () =>
    conPool((pool) =>
      Effect.gen(function* () {
        const engine = yield* arrancar(pool)
        const servidor = createServer()
        const puerto = yield* Effect.promise(
          () => new Promise<number>((resolve) => servidor.listen(0, "127.0.0.1", () => resolve((servidor.address() as AddressInfo).port))),
        )

        expect(yield* engine.ibkrDetect({ port: puerto })).toEqual([{ host: "127.0.0.1", port: puerto, live: false, open: true }])

        yield* Effect.promise(() => new Promise<void>((resolve) => servidor.close(() => resolve())))
        expect((yield* engine.ibkrDetect({ host: "127.0.0.1", port: puerto }))[0]?.open).toBe(false)

        // Without an address the search walks the two defaults, paper before live.
        expect((yield* engine.ibkrDetect({})).map((fila) => [fila.port, fila.live])).toEqual([
          [7497, false],
          [7496, true],
        ])

        const mala = yield* Effect.flip(engine.ibkrDetect({ host: "no válido/", port: 7497 }))
        expect(mala.message).toBe("A TWS host must be a loopback or private-network IP literal (127.0.0.0/8, ::1, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, fc00::/7).")

        // AE-005: a well-formed public address is the interesting refusal — the wizard would
        // otherwise hand it to linkAdd. The check runs before the knock, so no socket leaves.
        const pública = yield* Effect.flip(engine.ibkrDetect({ host: "8.8.8.8", port: 7497 }))
        if (!(pública instanceof InvalidTaskError)) return yield* Effect.die(pública)
        expect(pública.message).toBe(MENSAJE_HOST_TWS)

        // AE-005: linkAdd persists and connects on boot, so the same gate must refuse
        // before enlazar runs (no socket leaves). Both a public IP and a hostname.
        const enlacePúblico = yield* Effect.flip(engine.linkAdd({ host: "8.8.8.8", port: 7497 }))
        expect(enlacePúblico).toBeInstanceOf(InvalidTaskError)
        expect(enlacePúblico.message).toBe(MENSAJE_HOST_TWS)

        const enlaceLocalhost = yield* Effect.flip(engine.linkAdd({ host: "localhost", port: 7497 }))
        expect(enlaceLocalhost).toBeInstanceOf(InvalidTaskError)
        expect(enlaceLocalhost.message).toBe(MENSAJE_HOST_TWS)
      }),
    ),
  )

  // AE-012: a verdict saved for the primary must not be replayed when the shown
  // account is a read-only IBKR watch. The guard runs before the idempotent replay.
  it.effect("a read-only watch does not replay a primary close verdict (AE-012)", () =>
    conPool((pool) =>
      Effect.gen(function* () {
        const base = yield* Database.Service
        const stamp = Date.now()
        yield* base.db
          .insert(TradingLinkTable)
          .values({ id: "127.0.0.1:7999", host: "127.0.0.1", port: 7999, label: "watch", broker: "ibkr", time_created: stamp, time_updated: stamp })
          .run()
        yield* base.db
          .insert(TradingAccountTable)
          .values({ id: "DU123", link_id: "127.0.0.1:7999", time_created: stamp, time_updated: stamp })
          .run()
        yield* base.db
          .insert(TradingMetaTable)
          .values({ id: "cuenta_activa", value: "DU123", time_created: stamp, time_updated: stamp })
          .run()
        const rid = "watch-replay"
        yield* base.db
          .insert(TradingCloseTable)
          .values({ id: `cierre:${rid}`, symbol: "MNQ", lock: null, verdict: JSON.stringify({ ok: true, message: "Cierre enviado: MNQ" }), ts: stamp, time_created: stamp, time_updated: stamp })
          .run()

        const engine = yield* arrancar(pool)
        const resultado = yield* engine.closePosition("MNQ", rid)
        expect(resultado.message).toBe("The shown account (DU123) is read-only: not closed from here.")
      }),
    ),
  )

  // P-1: the panic's sweep must not inherit the submitted close-all's view guards. AE-012
  // stops a user submission from sweeping past the panel's view; the panic's job is
  // everything on the trading connection — with an MT5 account showing, the primary's
  // position still closes (the shown id rides no primary link, so the sweep keeps the
  // primary's own account).
  it.live("panic sweeps the primary's positions while an MT5 account is showing (P-1)", () =>
    conPool((pool) =>
      Effect.gen(function* () {
        const base = yield* Database.Service
        const stamp = Date.now()
        yield* base.db
          .insert(TradingLinkTable)
          .values({ id: "mt5-123456@MetaQuotes-Demo", host: "", port: 0, label: "demo", broker: "mt5", mt5_login: 123456, mt5_server: "MetaQuotes-Demo", time_created: stamp, time_updated: stamp })
          .run()
        yield* base.db
          .insert(TradingAccountTable)
          .values({ id: "123456", link_id: "mt5-123456@MetaQuotes-Demo", time_created: stamp, time_updated: stamp })
          .run()
        yield* base.db
          .insert(TradingMetaTable)
          .values({ id: "cuenta_activa", value: "123456", time_created: stamp, time_updated: stamp })
          .run()

        const tws = yield* twsDePosicion()
        const engine = yield* arrancar(pool, tws.puerto)
        yield* engine.run.pipe(Effect.forkScoped)
        yield* esperarLinea(engine, (linea) => linea.startsWith("Connection to IBKR established"))
        yield* esperarLinea(engine, (linea) => linea.includes("Account A discovered"))
        yield* esperarLinea(engine, (linea) => linea.startsWith("Positions:"))

        const resultado = yield* engine.panic()
        expect(resultado.close.ok).toBe(true)
        expect(resultado.close.message).toContain("Close requested for 1 position(s)")
        expect(tws.cuenta.ordenes).toBe(1)

        yield* engine.disconnect()
        yield* Effect.promise(tws.cerrar)
      }),
    ),
  )

  // P-1, the read-only flavor: a watch link's account showing stops a user submission
  // (AE-012) and must not stop the panic's sweep — the close lands on the primary's rows.
  it.live("panic sweeps the primary's positions while a read-only watch is showing (P-1)", () =>
    conPool((pool) =>
      Effect.gen(function* () {
        const base = yield* Database.Service
        const stamp = Date.now()
        yield* base.db
          .insert(TradingLinkTable)
          .values({ id: "127.0.0.1:7999", host: "127.0.0.1", port: 7999, label: "watch", broker: "ibkr", time_created: stamp, time_updated: stamp })
          .run()
        yield* base.db
          .insert(TradingAccountTable)
          .values({ id: "DU123", link_id: "127.0.0.1:7999", time_created: stamp, time_updated: stamp })
          .run()
        yield* base.db
          .insert(TradingMetaTable)
          .values({ id: "cuenta_activa", value: "DU123", time_created: stamp, time_updated: stamp })
          .run()

        const tws = yield* twsDePosicion()
        const engine = yield* arrancar(pool, tws.puerto)
        yield* engine.run.pipe(Effect.forkScoped)
        yield* esperarLinea(engine, (linea) => linea.startsWith("Connection to IBKR established"))
        yield* esperarLinea(engine, (linea) => linea.includes("Account A discovered"))
        yield* esperarLinea(engine, (linea) => linea.startsWith("Positions:"))

        const resultado = yield* engine.panic()
        expect(resultado.close.ok).toBe(true)
        expect(resultado.close.message).toContain("Close requested for 1 position(s)")
        expect(tws.cuenta.ordenes).toBe(1)

        yield* engine.disconnect()
        yield* Effect.promise(tws.cerrar)
      }),
    ),
  )

  // AE-009: with no configured folder (and no migrated pick) the engine boots with
  // an empty pool instead of a personal default path.
  it.effect("boots with an empty pool when no folder is configured (AE-009)", () =>
    Effect.gen(function* () {
      const engine = yield* arrancar("")
      expect(engine.snapshot().logs.some((linea) => linea.message === "No systems folder configured: empty pool")).toBe(true)
    }),
  )
  // D-01: a fresh install generates a per-installation client id and reuses it across boots.
  it.effect("generates and reuses a per-installation client id (D-01)", () =>
    conPool((pool) =>
      Effect.gen(function* () {
        yield* arrancar(pool)
        const base = yield* Database.Service
        const fila = yield* base.db.select().from(TradingMetaTable).where(eq(TradingMetaTable.id, "client_id")).get()
        expect(fila).toBeDefined()
        const id = Number(fila!.value)
        expect(id).toBeGreaterThanOrEqual(1000)
        expect(id).toBeLessThanOrEqual(9999)

        yield* arrancar(pool)
        const fila2 = yield* base.db.select().from(TradingMetaTable).where(eq(TradingMetaTable.id, "client_id")).get()
        expect(Number(fila2!.value)).toBe(id)
      }),
    ),
  )

  // Boot claim: a recent holder keeps the tick lease; a stale holder is taken over.
  it.effect("a second boot does not steal the tick lease from a recent holder (bootClaim)", () =>
    conPool((pool) =>
      Effect.gen(function* () {
        const base = yield* Database.Service
        const stamp = Date.now()
        yield* base.db
          .insert(TradingMetaTable)
          .values({ id: "bucle-motor", value: "otro-proceso", time_created: stamp, time_updated: stamp })
          .run()

        yield* arrancar(pool)

        const fila = yield* base.db.select().from(TradingMetaTable).where(eq(TradingMetaTable.id, "bucle-motor")).get()
        expect(fila!.value).toBe("otro-proceso")
      }),
    ),
  )

  it.effect("a second boot takes over the tick lease from a stale holder (bootClaim)", () =>
    conPool((pool) =>
      Effect.gen(function* () {
        const base = yield* Database.Service
        const stamp = Date.now() - 60_000
        yield* base.db
          .insert(TradingMetaTable)
          .values({ id: "bucle-motor", value: "proceso-muerto", time_created: stamp, time_updated: stamp })
          .run()

        yield* arrancar(pool)

        const fila = yield* base.db.select().from(TradingMetaTable).where(eq(TradingMetaTable.id, "bucle-motor")).get()
        expect(fila!.value).not.toBe("proceso-muerto")
      }),
    ),
  )

  // id and drops it half a second later. The library hands that notice only to its logger, so
  // the engine has to catch it there: the record names the taken id instead of a silent
  // connect-and-drop loop, and the drop is no "lost connection".
  it.live("a client id TWS refuses as taken is named in the record, not logged as a loss", () =>
    conPool((pool) =>
      Effect.gen(function* () {
        // The fake TWS refuses: the 326 notice, then the drop.
        const tws = yield* twsFalso((socket) => {
          socket.write(trama(["4", "2", "-1", "326", "Unable to connect as the client id is already in use. Retry with a unique client id.", ""]))
          setTimeout(() => socket.destroy(), 100)
        })
        const engine = yield* arrancar(pool)
        const enlace = yield* engine.linkAdd({ port: tws.puerto })

        const rechazo = `TWS rejects link ${enlace.id}: its client id`
        const registro = () => engine.snapshot().logs.map((fila) => fila.message)
        yield* esperarLinea(engine, (linea) => linea.startsWith(rechazo))

        expect(registro().some((linea) => linea.startsWith(rechazo))).toBe(true)
        expect(registro().some((linea) => linea.includes(`enlace ${enlace.id} perdida`) || linea.includes(`enlace ${enlace.id} establecida`))).toBe(false)

        yield* engine.linkRemove(enlace.id)
        yield* Effect.promise(tws.cerrar)
      }),
    ),
  )

  // The connection line names the address and, only for TWS's two default ports, the money
  // behind it (7497 demo, 7496 real). It used to say "demo" whatever the port, live included;
  // a port beyond the defaults claims nothing it cannot know.
  it.live("an established TWS link names its address without claiming demo money", () =>
    conPool((pool) =>
      Effect.gen(function* () {
        // The fake TWS accepts and stays: the socket holds past the refusal window.
        const tws = yield* twsFalso(() => {})
        const engine = yield* arrancar(pool)
        const enlace = yield* engine.linkAdd({ port: tws.puerto })

        const linea = `Link ${enlace.id} connection established (127.0.0.1:${tws.puerto})`
        yield* esperarLinea(engine, (texto) => texto === linea)
        expect(engine.snapshot().logs.map((fila) => fila.message)).toContain(linea)

        yield* engine.linkRemove(enlace.id)
        yield* Effect.promise(tws.cerrar)
      }),
    ),
  )

  // The wizard's paper preset is the engine's own port (the primary socket sits in the map
  // from boot), so a registration of the panel's own address dies on the duplicate guard —
  // and that address could have no way out of a row: the boot's reload skips its own id and
  // the panel's link is never removable. The engine answers by starting the panel's own
  // connect and persisting nothing; an address beyond the panel's still registers once and
  // its repeat is refused as always.
  it.effect("the panel's own TWS address connects the panel's session and never persists; other duplicates still refuse", () =>
    conPool((pool) =>
      Effect.gen(function* () {
        const engine = yield* arrancar(pool)
        // The engine's defaults are exactly the collision (host 127.0.0.1, port 7497): the
        // answer is the primary's own link, not a refusal naming a registration that is not.
        const anonciada = yield* engine.linkAdd({ port: 7497 })
        expect(anonciada).toEqual({ id: "127.0.0.1:7497", host: "127.0.0.1", port: 7497, label: null, broker: "ibkr", connected: false })

        const base = yield* Database.Service
        expect((yield* base.db.select().from(TradingLinkTable).all()).map((fila) => fila.id)).toEqual([])

        // A screen the panel does not own registers fresh; its repeat is the plain refusal.
        const segunda = yield* engine.linkAdd({ port: 7999 })
        expect(segunda.id).toBe("127.0.0.1:7999")
        const repetida = yield* Effect.flip(engine.linkAdd({ port: 7999 }))
        expect(repetida.message).toBe("Link 127.0.0.1:7999 is already registered.")
      }),
    ),
  )

  // The PC clock's own day decides where "HH:MM" lands (E7). A plain day: 21:31 asks for
  // tonight's 21:30 already past — it waits for the same wall hour tomorrow, and 07:15 the
  // next morning's — both land on the local wall clock, never on 24 added wall hours.
  it.effect("taskAdd anchors atTime on the PC wall clock across the day (E7)", () =>
    conPool((pool) =>
      Effect.gen(function* () {
        const engine = yield* arrancar(pool)
        const real = Date.now()
        setSystemTime(new Date(2026, 5, 15, 20, 31))
        const tarde = yield* engine.taskAdd({ kind: "stop-systems", atTime: "21:30" })
        expect(tarde.run_at).toBe(new Date(2026, 5, 15, 21, 30).getTime())
        const manana = yield* engine.taskAdd({ kind: "stop-systems", atTime: "07:15" })
        expect(manana.run_at).toBe(new Date(2026, 5, 16, 7, 15).getTime())
        setSystemTime(real)

        // The discriminating hour sits on a spring-change boundary (2026: Madrid jumps
        // Sunday 29 at 02:00). bun test pins its process zone to UTC — no wall clock
        // ever jumps there — so the branch re-zones to an IANA zone that does (Bun
        // honors a runtime process.env.TZ, and a runner already in that zone changes
        // nothing): "now" is Sunday 01:30, still standard time, so tomorrow's "01:30"
        // is one wall hour closer than 24 added hours — an anchor built on added
        // hours lands an hour late; this asserts the wall construction instead.
        const reserva = process.env.TZ
        process.env.TZ = "Europe/Madrid"
        setSystemTime(new Date(2026, 2, 29, 1, 30))
        const tarea = yield* engine.taskAdd({ kind: "stop-systems", atTime: "01:30" })
        expect(tarea.run_at).toBe(new Date(2026, 2, 30, 1, 30).getTime())
        if (reserva === undefined) delete process.env.TZ
        else process.env.TZ = reserva
        setSystemTime(real)
      }),
    ),
  )

  // A close is addressed to one account, so it reads that account's own rows, not the
  // login's flat list: with two accounts under one TWS socket (A shown, its only row an
  // EUR long), a MNQZ6 close must not find account B's MNQZ6 row on the flat view and
  // order it — it says "no longer open" and sends nothing. The wire below is real: the
  // fake TWS answers the managed accounts, per-account summary rows and both accounts'
  // positions, so the engine's per-account reads stand in exactly as they do against TWS.
  // (Every request a wrong-path close would make lands here too, so the flat-list
  // regression dies with an order on the recorded wire instead of a silent pass.)
  it.live("a close reads its own account's rows, never the login's flat list (E1)", () =>
    conPool((pool) =>
      Effect.gen(function* () {
        let ordenes = 0
        const tws = yield* twsFalso((socket) => {
          let pendiente = Buffer.alloc(0)
          let identrego = "60001"
          let idSiguiente = 60_001
          socket.on("data", (pedazo: Buffer) => {
            pendiente = Buffer.concat([pendiente, pedazo])
            for (;;) {
              if (pendiente.length < 4) return
              const largo = pendiente.readUInt32BE(0)
              if (pendiente.length < 4 + largo) return
              const campos = pendiente.subarray(4, 4 + largo).toString("utf8").split("\0")
              pendiente = pendiente.subarray(4 + largo)
              const id = campos[0]
              // START_API: a real TWS hands out the first order id right away, and the lib's
              // command buffer stays paused until one arrives — without this answer not one
              // request below would ever leave the client.
              if (id === "71") socket.write(trama(["9", "1", String(idSiguiente++)]))
              // REQ_MANAGED_ACCTS: this login's two accounts.
              else if (id === "17") socket.write(trama(["15", "1", "A,B"]))
              // REQ_ACCOUNT_SUMMARY: one row per account, A before B — the discovery order
              // is the engine's first account, which is who this close is addressed to.
              else if (id === "62") {
                const reqId = campos[2]
                for (const cuenta of ["A", "B"]) socket.write(trama(["63", "1", reqId, cuenta, "AccountType", "Individual", "USD"]))
                socket.write(trama(["64", "1", reqId]))
              }
              // REQ_POSITIONS: A holds only an EUR long; the row the close must not touch
              // sits on B (a MNQZ6 future: strike, right and multiplier in wire order, then
              // trading class, size and cost).
              else if (id === "61") {
                socket.write(trama(["61", "3", "A", "83626", "EURUSD", "CASH", "", "", "", "", "IDEALPRO", "USD", "EURUSD", "", "1000", "1.05"]))
                socket.write(trama(["61", "3", "B", "711712", "MNQZ6", "FUT", "20261218", "", "", "2", "GLOBEX", "USD", "MNQZ6", "MNQ", "1", "37000"]))
                socket.write(trama(["62", "1"]))
              }
              // The wrong-path close's support reads: open orders land empty, executions too.
              else if (id === "16") socket.write(trama(["53", "1"]))
              else if (id === "7") socket.write(trama(["55", "1", campos[2]]))
              // REQ_IDS: one order id handed out; the parked close's frame is counted,
              // never executed — its Filled reply only ends a wrong-path close quickly.
              else if (id === "8") {
                identrego = String(idSiguiente++)
                socket.write(trama(["9", "1", identrego]))
              } else if (id === "3") {
                ordenes += 1
                socket.write(trama(["3", "6", identrego, "Filled", "1", "0", "0", "777", "0", "", "0", "", "0"]))
              }
            }
          })
        })
        // The engine boots with the panel's pointer at the fake TWS; its own first tick
        // chases the socket (nothing is ever opened for it: no program starts at boot).
        const engine = yield* arrancar(pool, tws.puerto)
        yield* engine.run.pipe(Effect.forkScoped)
        yield* esperarLinea(engine, (linea) => linea.startsWith("Connection to IBKR established"))
        yield* esperarLinea(engine, (linea) => linea.includes("Account A discovered"))
        yield* esperarLinea(engine, (linea) => linea.includes("Account B discovered"))
        yield* esperarLinea(engine, (linea) => linea.startsWith("Positions:"))

        // The shown account's dashboard rows are A's alone; B's MNQZ6 rides the flat
        // connection's view but sits on B's own list.
        const vista = engine.snapshot()
        expect(vista.positions.map((fila) => [fila.symbol, fila.side, fila.size])).toEqual([["EURUSD", "long", 1000]])
        // Exposure spans the whole login: exactly A's EUR and B's MNQ — a flat-list read
        // (the regression this guards) would also nudge B's row into an account close.
        expect((vista.open_positions ?? []).map((fila) => `${fila.symbol}/${fila.side}/${fila.size}`)).toEqual(["EURUSD/long/1000", "MNQZ6/long/1"])
        // closable = the engine's own account only (A): B is a separate account on the same
        // login, so Panic would not close its MNQZ6 from here.
        expect((vista.closable_positions ?? []).map((fila) => `${fila.symbol}/${fila.side}/${fila.size}`)).toEqual(["EURUSD/long/1000"])

        const salida = yield* engine.closePosition("MNQZ6", "e1-cross")
        expect(salida).toEqual({
          ok: false,
          message: "The position MNQZ6 is no longer open.",
          message_key: "trading.close.gone",
          message_params: { symbol: "MNQZ6" },
        })
        // Nothing was ordered, and the durable verdict says so for the repeat.
        expect(ordenes).toBe(0)
        const claim = yield* readClaim("cierre:e1-cross")
        expect(claim && claim.verdict).toEqual(JSON.stringify(salida))

        // Drop the engine's socket before closing the server: `server.close` waits
        // for open connections, and the fake TWS's ears end with the engine's.
        yield* engine.disconnect()
        yield* Effect.promise(tws.cerrar)
      }),
    ),
  )

  // Regression: Panic leaves the accounts it does not close (here, account B on the same
  // login) reported through `leftover_symbols` in its summary.
  it.live("panic reports leftover positions in accounts it does not close", () =>
    conPool((pool) =>
      Effect.gen(function* () {
        let ordenes = 0
        const tws = yield* twsFalso((socket) => {
          let pendiente = Buffer.alloc(0)
          let identrego = "60001"
          let idSiguiente = 60_001
          socket.on("data", (pedazo: Buffer) => {
            pendiente = Buffer.concat([pendiente, pedazo])
            for (;;) {
              if (pendiente.length < 4) return
              const largo = pendiente.readUInt32BE(0)
              if (pendiente.length < 4 + largo) return
              const campos = pendiente.subarray(4, 4 + largo).toString("utf8").split("\0")
              pendiente = pendiente.subarray(4 + largo)
              const id = campos[0]
              if (id === "71") socket.write(trama(["9", "1", String(idSiguiente++)]))
              else if (id === "17") socket.write(trama(["15", "1", "A,B"]))
              else if (id === "62") {
                const reqId = campos[2]
                for (const cuenta of ["A", "B"]) socket.write(trama(["63", "1", reqId, cuenta, "AccountType", "Individual", "USD"]))
                socket.write(trama(["64", "1", reqId]))
              } else if (id === "61") {
                socket.write(trama(["61", "3", "A", "83626", "EURUSD", "CASH", "", "", "", "", "IDEALPRO", "USD", "EURUSD", "", "1000", "1.05"]))
                socket.write(trama(["61", "3", "B", "711712", "MNQZ6", "FUT", "20261218", "", "", "2", "GLOBEX", "USD", "MNQZ6", "MNQ", "1", "37000"]))
                socket.write(trama(["62", "1"]))
              } else if (id === "16") socket.write(trama(["53", "1"]))
              else if (id === "7") socket.write(trama(["55", "1", campos[2]]))
              else if (id === "8") {
                identrego = String(idSiguiente++)
                socket.write(trama(["9", "1", identrego]))
              } else if (id === "3") {
                ordenes += 1
                socket.write(trama(["3", "6", identrego, "Filled", "1", "0", "0", "777", "0", "", "0", "", "0"]))
              }
            }
          })
        })
        const engine = yield* arrancar(pool, tws.puerto)
        yield* engine.run.pipe(Effect.forkScoped)
        yield* esperarLinea(engine, (linea) => linea.startsWith("Connection to IBKR established"))
        yield* esperarLinea(engine, (linea) => linea.includes("Account A discovered"))
        yield* esperarLinea(engine, (linea) => linea.includes("Account B discovered"))
        yield* esperarLinea(engine, (linea) => linea.startsWith("Positions:"))

        const resultado = yield* engine.panic()
        expect(resultado.message_params?.leftover_symbols).toContain("MNQZ6")
        expect(resultado.message_params?.leftover_symbols).not.toContain("EURUSD")
        expect(resultado.message_params?.leftover_count).toBe(1)

        yield* engine.disconnect()
        yield* Effect.promise(tws.cerrar)
      }),
    ),
  )

  // The close's cycle pins its account once, before its first wire wait (R2), so the
  // reads, the last re-read and the order all name that one account even if the dashboard
  // flips meanwhile. The wire parks the close at its first open-orders read, switches the
  // shown account to B while it sits parked, and frees the read: only A's own list holds
  // the MNQZ6 — B holds a plain EURUSD. A close that re-read the shown account would look
  // for MNQZ6 on B, find it gone and retire saying so without one order; the pinned close
  // sells the MNQZ6 on A regardless — read straight off the recorded PLACE_ORDER row (in
  // the library's 1.6.13 encoder the account field sits exactly three tokens before
  // orderRef: account, openClose, origin, orderRef), the same way TWS would stamp the
  // order's seat.
  it.live("a shown-account flip mid-cycle never retargets the close's reads or order (R7)", () =>
    conPool((pool) =>
      Effect.gen(function* () {
        let puerta16: { aviso: Promise<void>; abrir: () => Promise<void> } | undefined
        let ordenes: string[] = []
        let idCerrado = 0
        const tws = yield* twsFalso((socket) => {
          let pendiente = Buffer.alloc(0)
          let identrego = "60001"
          let idSiguiente = 60_001
          let primer16 = true
          let notificar16: () => void = () => {}
          let soltar16: () => void = () => {}
          const aviso = new Promise<void>((res) => {
            notificar16 = res
          })
          const abrir = new Promise<void>((res) => {
            soltar16 = res
          })
          puerta16 = {
            aviso,
            abrir: () => {
              soltar16()
              return abrir
            },
          }
          socket.on("data", (pedazo: Buffer) => {
            pendiente = Buffer.concat([pendiente, pedazo])
            for (;;) {
              if (pendiente.length < 4) return
              const largo = pendiente.readUInt32BE(0)
              if (pendiente.length < 4 + largo) return
              const campos = pendiente.subarray(4, 4 + largo).toString("utf8").split("\0")
              pendiente = pendiente.subarray(4 + largo)
              const id = campos[0]
              if (id === "71") socket.write(trama(["9", "1", String(idSiguiente++)]))
              else if (id === "17") socket.write(trama(["15", "1", "A,B"]))
              else if (id === "62") {
                const reqId = campos[2]
                for (const cuenta of ["A", "B"]) socket.write(trama(["63", "1", reqId, cuenta, "AccountType", "Individual", "USD"]))
                socket.write(trama(["64", "1", reqId]))
              }
              // Positions: the shown account A owns the MNQZ6 the close targets; B's only
              // row is an EUR long a flipped view can never turn into the close's target.
              else if (id === "61") {
                socket.write(trama(["61", "3", "A", "711712", "MNQZ6", "FUT", "20261218", "", "", "2", "GLOBEX", "USD", "MNQZ6", "MNQ", "1", "37000"]))
                socket.write(trama(["61", "3", "B", "83626", "EURUSD", "CASH", "", "", "", "", "IDEALPRO", "USD", "EURUSD", "", "1000", "1.05"]))
                socket.write(trama(["62", "1"]))
              }
              // Open orders: the close's first read parks here until the test has flipped
              // the shown account mid-park; every later read (the polls) answers at once.
              else if (id === "16") {
                if (primer16) {
                  primer16 = false
                  notificar16()
                  abrir.then(() => socket.write(trama(["53", "1"])))
                  continue
                }
                socket.write(trama(["53", "1"]))
              } else if (id === "7") socket.write(trama(["55", "1", campos[2]]))
              else if (id === "8") {
                identrego = String(idSiguiente++)
                socket.write(trama(["9", "1", identrego]))
              } else if (id === "3") {
                idCerrado = Number(identrego)
                ordenes.push(campos[campos.findIndex((campo) => campo.startsWith("escritorio-cierre-")) - 3])
                // Order status carries no version token at server version 193: the decoder
                // reads id, status, filled, remaining, avgFillPrice, permId, parentId,
                // lastFillPrice, clientId, whyHeld and mktCapPrice straight away.
                socket.write(trama(["3", identrego, "Filled", "1", "0", "0", "777", "0", "", "0", "", "0"]))
                // TWS itself confirms a fill by taking the row out of the position stream: a
                // flat MNQZ6 push reads the position gone, the close sees its seat empty and
                // stops waiting on the order's own state.
                socket.write(trama(["61", "3", "A", "711712", "MNQZ6", "FUT", "20261218", "", "", "2", "GLOBEX", "USD", "MNQZ6", "MNQ", "0", "37000"]))
                socket.write(trama(["62", "1"]))
              }
            }
          })
        })
        const engine = yield* arrancar(pool, tws.puerto)
        yield* engine.run.pipe(Effect.forkScoped)
        yield* esperarLinea(engine, (linea) => linea.startsWith("Connection to IBKR established"))
        yield* esperarLinea(engine, (linea) => linea.includes("Account A discovered"))
        yield* esperarLinea(engine, (linea) => linea.includes("Account B discovered"))
        yield* esperarLinea(engine, (linea) => linea.startsWith("Positions:"))

        const cerrando = yield* engine.closePosition("MNQZ6", "r7-pin").pipe(Effect.forkScoped)
        // The close is parked on its first open-orders read: flip the shown account now,
        // and only then let the parked read go so the cycle's own window really spans it.
        if (puerta16 === undefined) return yield* Effect.die(new Error("the fake TWS never parked the close"))
        const puerta = puerta16
        yield* Effect.promise(() => puerta.aviso)
        const seleccionada = yield* engine.accountSelect("B")
        expect(seleccionada?.id ?? null).toBe("B")
        yield* Effect.promise(() => puerta.abrir())

        const salida = yield* Fiber.join(cerrando)
        expect(salida).toEqual({
          ok: true,
          message: `Close executed: SELL 1 MNQZ6 (order ${idCerrado}).`,
          message_key: "trading.close.executed_market",
          message_params: { action: "SELL", quantity: 1, symbol: "MNQZ6", order: idCerrado, extra: "" },
        })
        // The order went out addressed to the pinned account, not the flipped one.
        expect(ordenes).toEqual(["A"])
        const claim = yield* readClaim("cierre:r7-pin")
        expect(claim && claim.verdict).toEqual(JSON.stringify(salida))

        // Drop the engine's socket before closing the server: `server.close` waits
        // for open connections, and the fake TWS's ears end with the engine's.
        yield* engine.disconnect()
        yield* Effect.promise(tws.cerrar)
      }),
    ),
  )
})
