// The dead-exit bound on the refusal's own rotation: every gateway refusal rotates, and a landing
// the gateway refuses again with not one finished response behind it was dead on arrival — behind
// a shared exit such as WARP the fresh /64 the engine lands can hold a counter other users filled,
// or an edge refusing the whole /64, and no count of rotations fixes that. The bound counts the
// consecutive landings that never served a finished response and holds the automatic rotation once
// they reach the limit, so a day with no fresh exits left cannot churn the tunnel forever.
import { describe, expect, test } from "bun:test"
import { DEAD_EXITS, agota, aterriza, rechaza, sirvePaso, vigia } from "./free-daily-rotate"

describe("the dead-exit bound", () => {
  test("a working exit's death starts the count over", () => {
    // A landing that served finished responses before the gateway refused it is a working exit
    // that filled: its death is the next fresh /64's chance, not evidence of none.
    const v = rechaza(aterriza(vigia()))
    const viva = sirvePaso(sirvePaso(sirvePaso(v)))

    expect(agota(viva)).toBe(false)
    expect(rechaza(viva).muertas).toBe(0)
  })

  test("consecutive dead landings reach the bound", () => {
    let v = vigia()

    for (let i = 0; i < DEAD_EXITS; i++) {
      v = rechaza(aterriza(v))
      expect(agota(v)).toBe(i === DEAD_EXITS - 1)
    }
  })

  test("a dead exit's own refusals count together, however many sessions it stopped", () => {
    // Two sessions the same dead exit refused land as two refusal events: the exit counts once.
    let v = aterriza(vigia())

    v = rechaza(v)
    v = rechaza(v)
    v = rechaza(v)

    expect(v.muertas).toBe(1)
    expect(agota(v)).toBe(false)
  })

  test("a finished response lifts the hold", () => {
    let v = vigia()

    for (let i = 0; i < DEAD_EXITS; i++) v = rechaza(aterriza(v))
    expect(agota(v)).toBe(true)

    // The standing exit answered: its Retry-After ran out, or the edge relented — the bound's
    // whole premise (no exit serves) fell, so the rotation comes back on.
    v = sirvePaso(v)
    expect(agota(v)).toBe(false)
  })

  test("steps between landings keep the count down", () => {
    // A day of healthy rotations — each exit serves before it dies — never reaches the bound.
    let v = vigia()

    for (let i = 0; i < 10; i++) {
      v = rechaza(sirvePaso(sirvePaso(aterriza(v))))
      expect(agota(v)).toBe(false)
    }
  })
})
