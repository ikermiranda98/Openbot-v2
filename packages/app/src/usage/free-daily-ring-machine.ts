// The free-usage ring's pill, as one state machine: the rotation's cycle (the engine working, the
// fresh exit it landed, the X its failure left) and the gateway's block, which can stand under any
// of them. The component drives it — the holds and waits (a verdict's beat, a failed run's retry,
// a block's own end) stay in the driver, which turns events into state and dispatches back.
// Nothing here reads the clock or the world: every time enters as data on the event that carries it.

/** How a run ended: the fresh exit it landed, or why it failed. */
export type Veredicto = { tipo: "ok"; dirección: string } | { tipo: "fallo"; causa: Causa }

/** A run's failure: the engine refused it, or the server never answered at all. */
export type Causa = "motor" | "servidor"

/** What the ring's pill holds. A block survives a landing that failed and a rotation that runs, so
 * `rotando` carries the block it started under, and `bloqueado` carries the verdict it arrived on. */
export type Anillo =
  | { fase: "reposo" }
  | { fase: "rotando"; bloqueo?: number }
  | { fase: "ok"; dirección: string }
  | { fase: "fallo"; causa: Causa }
  | { fase: "bloqueado"; hasta: number; sello?: Veredicto }

/** What can happen to the pill. `hasta` is the block's own end, the driver's reading of the
 * gateway's Retry-After (or the free day's end when it refused without one). */
export type EventoAnillo =
  | { tipo: "rotar" }
  | { tipo: "aterrizó"; dirección: string }
  | { tipo: "falló"; causa: Causa }
  | { tipo: "bloqueo"; hasta: number }
  | { tipo: "bloqueo.levantado" }
  | { tipo: "bloqueo.consumado" }
  | { tipo: "veredicto.consumado" }

export function transicion(estado: Anillo, evento: EventoAnillo): Anillo {
  switch (evento.tipo) {
    case "rotar":
      // A run holds the ring: a second ask lands once, like the desktop bat's own lock.
      if (estado.fase === "rotando") return estado

      return { fase: "rotando", bloqueo: estado.fase === "bloqueado" ? estado.hasta : undefined }

    case "aterrizó":
      // The fresh exit lifts the block with it.
      if (estado.fase !== "rotando") return estado

      return { fase: "ok", dirección: evento.dirección }

    case "falló":
      if (estado.fase !== "rotando") return estado

      // A failed landing does not lift the block it ran under: the verdict rides the block.
      if (estado.bloqueo !== undefined)
        return { fase: "bloqueado", hasta: estado.bloqueo, sello: { tipo: "fallo", causa: evento.causa } }

      return { fase: "fallo", causa: evento.causa }

    case "bloqueo": {
      if (estado.fase === "rotando") return { ...estado, bloqueo: evento.hasta }

      // The verdict a refusal interrupted keeps holding beside the block.
      const sello = veredictoDe(estado)

      return sello ? { fase: "bloqueado", hasta: evento.hasta, sello } : { fase: "bloqueado", hasta: evento.hasta }
    }

    case "bloqueo.levantado": {
      if (estado.fase === "rotando") return estado.bloqueo === undefined ? estado : { fase: "rotando" }

      if (estado.fase !== "bloqueado") return estado

      return estado.sello ? deVeredicto(estado.sello) : { fase: "reposo" }
    }

    case "bloqueo.consumado": {
      if (estado.fase !== "bloqueado") return estado

      return estado.sello ? deVeredicto(estado.sello) : { fase: "reposo" }
    }

    case "veredicto.consumado": {
      if (estado.fase === "ok" || estado.fase === "fallo") return { fase: "reposo" }

      if (estado.fase === "bloqueado" && estado.sello) return { fase: "bloqueado", hasta: estado.hasta }

      return estado
    }
  }
}

/** Whether a run is working the ring right now. */
export function rotando(estado: Anillo) {
  return estado.fase === "rotando"
}

/** The verdict the pill holds, if any — the one a block does not displace. */
export function veredictoDe(estado: Anillo): Veredicto | undefined {
  if (estado.fase === "ok") return { tipo: "ok", dirección: estado.dirección }

  if (estado.fase === "fallo") return { tipo: "fallo", causa: estado.causa }

  if (estado.fase === "bloqueado") return estado.sello

  return undefined
}

/** The block the gateway is holding against the current exit, with its own end, if any. */
export function bloqueado(estado: Anillo) {
  if (estado.fase === "rotando") return estado.bloqueo

  if (estado.fase === "bloqueado") return estado.hasta

  return undefined
}

function deVeredicto(veredicto: Veredicto): Anillo {
  return veredicto.tipo === "ok" ? { fase: "ok", dirección: veredicto.dirección } : { fase: "fallo", causa: veredicto.causa }
}
