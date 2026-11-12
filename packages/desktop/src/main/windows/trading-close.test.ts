// The trading close gate's verdicts, tested at the one boundary another window can afford:
// the stubbed Electron dialog records which question ran, and a fake `@opencode/client`
// answers (or refuses) the snapshot. Electron itself never runs here, and the before-quit
// wiring stays a reading-checked concern (it calls the same verdict).
import { describe, expect, mock, test } from "bun:test"
import { SidecarCredentials } from "../service/sidecar-credentials"

type PreguntaElectron = { message: string; detail: string; buttons: string[] }

let preguntas: PreguntaElectron[] = []

let respuesta = 1

mock.module("electron", () => ({
  BrowserWindow: class {},
  dialog: {
    showMessageBox: async (winOrOptions: unknown, opciones?: PreguntaElectron) => {
      // Both platform shapes arrive: a parented call passes (window, options), the
      // windowless quit passes the options alone in the first position.
      preguntas.push((opciones ?? winOrOptions) as PreguntaElectron)

      return { response: respuesta }
    },
  },
}))

// The studies' sidecar lives in module state; each case sets it straight or clears it.
const setSidecar = (sidecar: { url: string; password: string | null } | undefined) =>
  SidecarCredentials.set(sidecar as never)

const clientResponde = (salida: Promise<unknown>) =>
  mock.module("@opencode/client", () => ({
    OpenCode: {
      make: () => ({
        experimental: { trading: { snapshot: () => salida } },
      }),
    },
  }))

const sut = await import("./trading-close")

type Caso = { nombre: string; salida: "sin engine" | "vacío" | "expuesto" | "posiciones" | "caído"; responde: 0 | 1; cerrar: boolean; pregunta: string | null }

const casos: Caso[] = [
  { nombre: "no sidecar credential closes without asking anything", salida: "sin engine", responde: 1, cerrar: true, pregunta: null },
  { nombre: "an idle snapshot closes without asking anything", salida: "vacío", responde: 1, cerrar: true, pregunta: null },
  {
    nombre: "running bots and open positions ask; Cancel keeps the window",
    salida: "expuesto",
    responde: 1,
    cerrar: false,
    pregunta: "Bots are still running and positions are open",
  },
  { nombre: "…and Close Anyway closes", salida: "expuesto", responde: 0, cerrar: true, pregunta: "Bots are still running and positions are open" },
  {
    // The engine's whole-exposure field, not the shown account's flat list: reading the
    // fallback instead would miss exactly these rows (positions carries [] beside them).
    nombre: "open_positions alone ask even while the flat list is empty (E3)",
    salida: "posiciones",
    responde: 1,
    cerrar: false,
    pregunta: "There are still open positions",
  },
  {
    nombre: "a stalled sidecar asks fail-closed instead of passing the close",
    salida: "caído",
    responde: 1,
    cerrar: false,
    pregunta: "The trading state could not be verified",
  },
  { nombre: "…and Close Anyway still closes", salida: "caído", responde: 0, cerrar: true, pregunta: "The trading state could not be verified" },
]

describe("the trading close gate", () => {
  for (const caso of casos)
    test(caso.nombre, async () => {
      preguntas.length = 0
      respuesta = caso.responde

      if (caso.salida === "sin engine") {
        setSidecar(undefined)
      } else {
        setSidecar({ url: "http://127.0.0.1:7999", password: "k" })
        clientResponde(
          caso.salida === "vacío"
            ? Promise.resolve({ systems: [], positions: [] })
            : caso.salida === "expuesto"
              ? Promise.resolve({ systems: [{ name: "MNQ break", running: true }], positions: [{ symbol: "MNQZ6" }] })
              : caso.salida === "posiciones"
                ? Promise.resolve({ systems: [], positions: [], open_positions: [{ symbol: "MNQZ6" }] })
                : Promise.reject(new Error("down")),
        )
      }

      const cerrar = await sut.confirmTradingQuit()

      expect(cerrar).toBe(caso.cerrar)
      expect(preguntas.map((pregunta) => pregunta.message)).toEqual(caso.pregunta === null ? [] : [caso.pregunta])
    })
})

// The approval bridge: the last window's own warning is the quit's, so a close the user just
// allowed is worth exactly one no-window quit — and a denied close leaves nothing behind.
describe("the window close's approval for the quit gate", () => {
  const arranca = async (responde: 0 | 1) => {
    preguntas.length = 0
    respuesta = responde
    setSidecar({ url: "http://127.0.0.1:7999", password: "k" })
    clientResponde(
      Promise.resolve({ systems: [{ name: "MNQ break", running: true }], positions: [{ symbol: "MNQZ6" }] }),
    )
    return sut.confirmTradingClose({ isDestroyed: () => false } as never)
  }

  test("an approved window close is worth one quit, once", async () => {
    await arranca(0)

    expect(sut.consumirCierreAprobado()).toBe(true)
    expect(sut.consumirCierreAprobado()).toBe(false)
  })

  test("a denied window close leaves no approval behind", async () => {
    await arranca(0)
    await arranca(1)

    // A prior approval retires with the user's later denial: the quit asks again.
    expect(sut.consumirCierreAprobado()).toBe(false)
  })

  test("a silent close — nothing exposed — leaves no approval behind", async () => {
    preguntas.length = 0
    respuesta = 0
    setSidecar({ url: "http://127.0.0.1:7999", password: "k" })
    clientResponde(Promise.resolve({ systems: [], positions: [] }))

    await sut.confirmTradingClose({ isDestroyed: () => false } as never)

    // No warning ran, so the user was never asked about quitting over an exposure — one that
    // may start afterwards must make the quit gate ask for its own.
    expect(preguntas).toEqual([])
    expect(sut.consumirCierreAprobado()).toBe(false)
  })
})
