import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { Database } from "@opencode/core/database/database"
import { TradingEngine } from "@opencode/core/trading"
import { conIdDe, duracionSegundos, lotes, magicPorDefecto, unidades, type Instrumento } from "@opencode/core/trading/bots-mt5"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node]), []))

const instrumento = (forex: boolean): Instrumento => ({
  conId: 1,
  root: forex ? "USDJPY" : "MNQ",
  secType: "FUT",
  exchange: "",
  currency: "USD",
  multiplier: 2,
  forex,
  account: "a",
  mt5: "US100",
  digits: 2,
  contractSize: forex ? 100_000 : 1,
  tickSize: 0.01,
  tickValue: 0.01,
  volumeMin: 0.01,
  volumeStep: 0.01,
  volumeMax: 100,
})

describe("MT5 bots translator", () => {
  test("sizes keep the bot's exposure", () => {
    // 1 MNQ = 2 $/point = 2 lots of a 1 $/point CFD.
    expect(lotes(instrumento(false), 1)).toBe(2)
    expect(unidades(instrumento(false), 4)).toBe(2)
    // Forex quantities are units of the base currency.
    expect(lotes(instrumento(true), 100_000)).toBe(1)
    expect(unidades(instrumento(true), 0.5)).toBe(50_000)
    // Gold: 1 MGC = 10 $/point = 0.1 lots of a 100 oz contract (tick 0.01 → 1 $).
    expect(lotes({ ...instrumento(false), root: "MGC", multiplier: 10, tickValue: 1 }, 1)).toBe(0.1)
  })

  test("IB durations, conIds and magic numbers", () => {
    expect(duracionSegundos("1 M")).toBe(31 * 86_400)
    expect(duracionSegundos("1 D")).toBeGreaterThanOrEqual(3 * 86_400)
    expect(duracionSegundos("x")).toBeNull()
    expect(conIdDe("MNQ")).toBe(conIdDe("MNQ"))
    expect(conIdDe("MNQ")).not.toBe(conIdDe("MGC"))
    expect(magicPorDefecto("07")).toBe(7_700_007)
  })
})

// ----- end to end: engine + bridge + fake MetaTrader5 + the DeepTrading test bots ----------

/** A Python that runs the fake MetaTrader5 package (it needs nothing else). */
const python = (() => {
  const candidatos = [process.env.TRADING_TEST_PYTHON, "python", "py"].filter((c): c is string => c !== undefined && c !== "")
  for (const c of candidatos) {
    const r = spawnSync(c, ["-c", "import sys; print(sys.executable)"], { encoding: "utf8", windowsHide: true })
    const exe = r.stdout?.trim() ?? ""
    if (r.status === 0 && exe !== "" && !exe.toLowerCase().includes("windowsapps")) return exe
  }
  return null
})()
const pythonw = python === null ? null : join(python, "..", "pythonw.exe")
const e2e = process.platform === "win32" && python !== null && pythonw !== null && existsSync(pythonw)
const falso = join(import.meta.dir, "fixtures", "mt5-falso")
const pruebas = join(import.meta.dir, "fixtures", "bots-mt5")

/** A pool system that runs one of the test bots with its prints in consola.log (the bot file
 * itself stays as it is: the wrapper only points stdout at stderr). */
const sistemaDePrueba = async (pool: string, carpeta: string, fichero: string) => {
  const dir = join(pool, carpeta)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "system.json"), JSON.stringify({ broker: "mt5" }))
  await writeFile(
    join(dir, "bot.py"),
    `import runpy, sys\nsys.stdout = sys.stderr\nrunpy.run_path(r"${join(pruebas, fichero)}", run_name="__main__")\n`,
  )
}

const esperar = (cond: () => boolean | Promise<boolean>, ms: number) =>
  Effect.promise(async () => {
    const limite = Date.now() + ms
    while (!(await cond()) && Date.now() < limite) await Bun.sleep(250)
    return cond()
  })

const correrBot = (carpeta: string, fichero: string, limiteMs: number) =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "openbot-mt5-"))),
    (raiz) =>
      Effect.gen(function* () {
        const pool = join(raiz, "pool")
        yield* Effect.promise(() => sistemaDePrueba(pool, carpeta, fichero))
        const engine = yield* TradingEngine.Service
        yield* engine.poolSelect(pool)
        yield* engine.linkAdd({ broker: "mt5", mt5Login: 5550001, mt5Server: "OpenBot-Sim" })
        const conectado = yield* esperar(() => (engine.snapshot().accounts ?? []).some((cuenta) => cuenta.id === "5550001"), 30_000)
        expect(conectado).toBe(true)
        const id = carpeta.slice(0, 2)
        yield* engine.activate(id)
        const consola = join(pool, carpeta, "consola.log")
        yield* esperar(() => engine.snapshot().systems.find((s) => s.id === id)?.running !== true, limiteMs)
        yield* esperar(
          async () => engine.snapshot().systems.find((s) => s.id === id)?.running !== true,
          5_000,
        )
        return { texto: yield* Effect.promise(() => readFile(consola, "utf8").catch(() => "")), logs: engine.snapshot().logs }
      }).pipe(
        Effect.provide(
          TradingEngine.layer({
            systemsDir: join(raiz, "pool"),
            mt5Python: python ?? undefined,
            mt5PythonPath: falso,
            botsDataDir: join(raiz, "datos"),
          }),
        ),
      ),
    (raiz) => Effect.tryPromise(() => rm(raiz, { recursive: true, force: true })).pipe(Effect.ignore),
  )

describe.if(e2e)("MT5 bots end to end (fake MetaTrader5)", () => {
  it.live(
    "99_prueba_puente: market, OCA, average, modify, cancel, crossed stops, forex and executions",
    () =>
      Effect.gen(function* () {
        const salida = yield* correrBot("99_prueba_puente", "99_prueba_puente.py", 150_000)
        if (!salida.texto.includes("PRUEBA OK") || process.env.TRADING_MT5_VERBOSE === "1") console.log(salida.texto, salida.logs.slice(-40))
        expect(salida.texto).toContain("PRUEBA OK")
        expect(salida.texto).not.toContain("Traceback")
      }),
    200_000,
  )

  // The broker runs the stop over two averaged positions: up to four minutes of fake prices.
  ;(process.env.TRADING_MT5_E2E === "1" ? it.live : it.live.skip)(
    "98_prueba_oca: the broker's stop fills both averaged positions and cancels the target (TRADING_MT5_E2E=1)",
    () =>
      Effect.gen(function* () {
        const salida = yield* correrBot("98_prueba_oca", "98_prueba_oca.py", 300_000)
        if (!salida.texto.includes("PRUEBA OCA OK") || process.env.TRADING_MT5_VERBOSE === "1") console.log(salida.texto, salida.logs.slice(-40))
        expect(salida.texto).toContain("PRUEBA OCA OK")
      }),
    360_000,
  )
})