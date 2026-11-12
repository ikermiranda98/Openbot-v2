import { expect, test } from "bun:test"

// The dictation button's icon is CSS-only geometry: six rects take their height and the
// centered `y` from the `--wave-base` and `--wave-reach` custom properties the recorder eases
// in, and color through `currentColor`. The weekly dev merge that resolved voice.css toward
// upstream lost the block — upstream never carried it — and the button rendered six
// zero-height rects until it came back. This guard fails again the next time a merge drops it.
const css = await Bun.file(import.meta.dir + "/voice.css").text()

const wave = css.match(/\.voice-dictation-wave \{[\s\S]*?\}/)?.[0] ?? ""
const rectBlock = css.match(/\.voice-dictation-wave rect \{[\s\S]*?\}/)?.[0] ?? ""

test("the dictation wave keeps its paint rules", () => {
  expect(wave).toContain("display: block")
  expect(wave).toContain("fill: currentColor")
  expect(rectBlock).toContain(
    "height: calc(var(--wave-base, 6px) * (1 + var(--voice-bass, 0) * var(--wave-reach, 0.5)))",
  )
  expect(rectBlock).toContain(
    "y: calc(8px - var(--wave-base, 6px) * (1 + var(--voice-bass, 0) * var(--wave-reach, 0.5)) / 2)",
  )
})
