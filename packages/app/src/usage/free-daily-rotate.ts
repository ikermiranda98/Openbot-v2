// The dead-exit bound on the refusal's own rotation: every gateway refusal rotates, and a landing
// the gateway refuses again with not one finished response behind it was dead on arrival — behind
// a shared exit such as WARP the fresh /64 the engine lands can hold a counter other users filled,
// or an edge refusing the whole /64, and no count of rotations fixes that. The bound counts the
// consecutive landings that never served a finished response and holds the automatic rotation once
// they reach the limit, so a day with no fresh exits left cannot churn the tunnel forever — each
// useless run flaps the connection, and the sessions it would resume refuse into the same wall.

/** Consecutive never-used landings the ring tolerates before holding the automatic rotation. */
export const DEAD_EXITS = 3

export type Vigia = {
  /** Finished responses the standing exit served since it landed. */
  pasos: number
  /** Consecutive landings no finished response ever used. */
  muertas: number
  /** Whether the standing exit's deadness is already on the count: a dead exit's refusals —
   * however many sessions it stopped — count together, so only its first refusal tallies. */
  contada: boolean
}

export const vigia = (): Vigia => ({ pasos: 0, muertas: 0, contada: false })

/** A finished response went through the standing exit: it is alive, and a hold lifts on it —
 * the bound's whole premise (no exit serves) has fallen. */
export const sirvePaso = (v: Vigia): Vigia =>
  v.muertas >= DEAD_EXITS ? { pasos: 1, muertas: 0, contada: false } : { ...v, pasos: v.pasos + 1 }

/** A rotation landed: the fresh exit starts uncounted — its own first refusal is its verdict. */
export const aterriza = (v: Vigia): Vigia => ({ pasos: 0, muertas: v.muertas, contada: false })

/** The gateway refused the standing exit: a working exit's death is the next fresh /64's chance,
 * while a landing no finished response ever used has already been counted once. */
export const rechaza = (v: Vigia): Vigia => {
  if (v.pasos > 0) return { ...v, muertas: 0, contada: false }
  if (v.contada) return v
  return { ...v, muertas: v.muertas + 1, contada: true }
}

/** The refusal bound: the automatic rotation holds while this stands — a manual rotation or a
 * finished response clears the way. */
export const agota = (v: Vigia): boolean => v.muertas >= DEAD_EXITS
