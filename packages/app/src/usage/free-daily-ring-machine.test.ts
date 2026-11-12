import { describe, expect, test } from "bun:test"
import { createStore, reconcile } from "solid-js/store"
import {
  bloqueado,
  rotando,
  transicion,
  veredictoDe,
  type Anillo,
  type EventoAnillo,
} from "./free-daily-ring-machine"

const REPOSO: Anillo = { fase: "reposo" }

const ROTANDO: Anillo = { fase: "rotando" }

const OK: Anillo = { fase: "ok", dirección: "2001:db8::42" }

const FALLO: Anillo = { fase: "fallo", causa: "motor" }

const BLOQUEADO: Anillo = { fase: "bloqueado", hasta: 6_000 }

/** Replays events the way the driver builds them, one transition at a time. */
const paso = (estado: Anillo, eventos: EventoAnillo[]) => eventos.reduce(transicion, estado)

describe("free daily ring machine", () => {
  test("a verdict that arrives without a rotation running changes nothing", () => {
    for (const estado of [REPOSO, OK, FALLO, BLOQUEADO]) {
      expect(transicion(estado, { tipo: "aterrizó", dirección: "2001:db8:0:1" })).toBe(estado)
      expect(transicion(estado, { tipo: "falló", causa: "servidor" })).toBe(estado)
    }
  })

  test("a second ask while a run holds the ring lands once", () => {
    expect(transicion(REPOSO, { tipo: "rotar" })).toEqual({ fase: "rotando" })
    expect(transicion(ROTANDO, { tipo: "rotar" })).toBe(ROTANDO)
    expect(transicion(OK, { tipo: "rotar" })).toEqual({ fase: "rotando" })
  })

  test("a block that arrives during a rotation rides it instead of cutting it", () => {
    const bloqueoDuranteRotación = transicion(ROTANDO, { tipo: "bloqueo", hasta: 6_000 })

    expect(bloqueoDuranteRotación).toEqual({ fase: "rotando", bloqueo: 6_000 })
    expect(rotando(bloqueoDuranteRotación)).toBe(true)
    expect(bloqueado(bloqueoDuranteRotación)).toBe(6_000)
    expect(veredictoDe(bloqueoDuranteRotación)).toBeUndefined()
  })

  test("a landing lifts the block it ran under; a failure holds it with the verdict", () => {
    const bajoBloqueo = paso(BLOQUEADO, [{ tipo: "rotar" }])

    expect(bajoBloqueo).toEqual({ fase: "rotando", bloqueo: 6_000 })
    expect(transicion(bajoBloqueo, { tipo: "aterrizó", dirección: "2001:db8:0:1" })).toEqual({
      fase: "ok",
      dirección: "2001:db8:0:1",
    })
    expect(transicion(bajoBloqueo, { tipo: "falló", causa: "motor" })).toEqual({
      fase: "bloqueado",
      hasta: 6_000,
      sello: { tipo: "fallo", causa: "motor" },
    })
    expect(transicion(ROTANDO, { tipo: "falló", causa: "servidor" })).toEqual({ fase: "fallo", causa: "servidor" })
  })

  test("a refusal under a held verdict keeps the verdict beside the block", () => {
    const sobreOk = transicion(OK, { tipo: "bloqueo", hasta: 6_000 })

    expect(sobreOk).toEqual({ fase: "bloqueado", hasta: 6_000, sello: { tipo: "ok", dirección: "2001:db8::42" } })
    expect(veredictoDe(sobreOk)).toEqual({ tipo: "ok", dirección: "2001:db8::42" })
    expect(bloqueado(sobreOk)).toBe(6_000)

    const sobreFallo = transicion(FALLO, { tipo: "bloqueo", hasta: 7_000 })

    expect(veredictoDe(sobreFallo)).toEqual({ tipo: "fallo", causa: "motor" })
  })

  test("a step going through lifts the block back to the held verdict, or to rest", () => {
    expect(transicion(BLOQUEADO, { tipo: "bloqueo.levantado" })).toEqual({ fase: "reposo" })
    expect(transicion(paso(OK, [{ tipo: "bloqueo", hasta: 6_000 }]), { tipo: "bloqueo.levantado" })).toEqual(OK)
    expect(transicion(paso(ROTANDO, [{ tipo: "bloqueo", hasta: 6_000 }]), { tipo: "bloqueo.levantado" })).toEqual({
      fase: "rotando",
    })

    for (const estado of [REPOSO, OK, FALLO]) expect(transicion(estado, { tipo: "bloqueo.levantado" })).toBe(estado)
  })

  test("each hold ends with its own beat, and never cuts what stands beside it", () => {
    expect(transicion(BLOQUEADO, { tipo: "bloqueo.consumado" })).toEqual({ fase: "reposo" })
    expect(transicion(paso(OK, [{ tipo: "bloqueo", hasta: 6_000 }]), { tipo: "bloqueo.consumado" })).toEqual(OK)
    expect(transicion(ROTANDO, { tipo: "bloqueo.consumado" })).toBe(ROTANDO)

    expect(transicion(OK, { tipo: "veredicto.consumado" })).toEqual({ fase: "reposo" })
    expect(transicion(FALLO, { tipo: "veredicto.consumado" })).toEqual({ fase: "reposo" })
    expect(transicion(paso(OK, [{ tipo: "bloqueo", hasta: 6_000 }]), { tipo: "veredicto.consumado" })).toEqual(BLOQUEADO)
    expect(transicion(BLOQUEADO, { tipo: "veredicto.consumado" })).toBe(BLOQUEADO)
    expect(transicion(ROTANDO, { tipo: "veredicto.consumado" })).toBe(ROTANDO)
  })

  test("the selectors read every phase", () => {
    expect(rotando(REPOSO)).toBe(false)
    expect(veredictoDe(REPOSO)).toBeUndefined()
    expect(bloqueado(REPOSO)).toBeUndefined()

    expect(rotando(ROTANDO)).toBe(true)
    expect(veredictoDe(ROTANDO)).toBeUndefined()
    expect(bloqueado(ROTANDO)).toBeUndefined()

    expect(veredictoDe(OK)).toEqual({ tipo: "ok", dirección: "2001:db8::42" })
    expect(veredictoDe(FALLO)).toEqual({ tipo: "fallo", causa: "motor" })
    expect(bloqueado(OK)).toBeUndefined()

    expect(rotando(BLOQUEADO)).toBe(false)
    expect(veredictoDe(BLOQUEADO)).toBeUndefined()
    expect(bloqueado(BLOQUEADO)).toBe(6_000)
  })

  test("the refused rotation replays whole: refused, rotating under the block, failing, retried on the block's end", () => {
    const fallido = paso(REPOSO, [
      { tipo: "bloqueo", hasta: 6_000 },
      { tipo: "rotar" },
      { tipo: "falló", causa: "motor" },
    ])

    expect(fallido).toEqual({ fase: "bloqueado", hasta: 6_000, sello: { tipo: "fallo", causa: "motor" } })
    expect(rotando(fallido)).toBe(false)
    expect(bloqueado(fallido)).toBe(6_000)
    expect(veredictoDe(fallido)).toEqual({ tipo: "fallo", causa: "motor" })

    const consumado = transicion(fallido, { tipo: "veredicto.consumado" })

    expect(consumado).toEqual(BLOQUEADO)
    expect(transicion(consumado, { tipo: "bloqueo.consumado" })).toEqual({ fase: "reposo" })
  })

  // The driver writes each transition through `reconcile` — a plain store write merges the
  // object into the previous one, and a phase's dropped field (a rotando's own block) would
  // survive it: `bloqueado` would then read a block the machine had lifted, and a later
  // failure would resurrect it with its stale end.
  test("a store write through reconcile drops the fields a transition's state no longer holds", () => {
    const [store, setStore] = createStore<{ anillo: Anillo }>({ anillo: REPOSO })
    const transitar = (evento: EventoAnillo) => setStore("anillo", reconcile(transicion(store.anillo, evento)))

    transitar({ tipo: "rotar" })
    transitar({ tipo: "bloqueo", hasta: 6_000 })

    expect(store.anillo).toEqual({ fase: "rotando", bloqueo: 6_000 })
    expect(bloqueado(store.anillo)).toBe(6_000)

    transitar({ tipo: "bloqueo.levantado" })

    expect(store.anillo).toEqual({ fase: "rotando" })
    expect(bloqueado(store.anillo)).toBeUndefined()
  })
})
