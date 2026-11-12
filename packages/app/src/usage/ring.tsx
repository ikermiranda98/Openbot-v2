// The house's progress ring: the free-usage ring's own arc and comet, shared so every ring on
// the chrome reads as one. The shared ProgressCircle stylesheet still paints the strokes — the
// svg wears its data-component and appearance, and carries the arc's colour in the custom
// property that stylesheet reads — while the geometry stays this component's: the band sits
// 0.25 units inside the viewBox edge, so fractional device scales cannot shave the contour at
// the cardinal points (the shared circle keeps its stroke's outer edge on the exact edge), and
// the comet rides the same radius a shade thicker.
import { Show } from "solid-js"
import { prefersReducedMotion } from "@opencode/ui/motion"
import "./ring.css"

const RING_STROKE = 1.75
const RING_MARGIN = 0.25
const RING_RADIUS = 8 - RING_STROKE / 2 - RING_MARGIN
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

// The comet rides the same radius as the band, a shade thicker — its stroke's outer edge lands
// exactly on the band's own margin, so nothing of it clips at the cardinal points either.
const RING_COMET_STROKE = RING_STROKE + 2 * RING_MARGIN

export function Ring(props: {
  /** The arc's share, clamped to the band. */
  progress: number
  /** The arc's own colour: the value the shared stylesheet reads for both band and comet. */
  color: string
  /** The comet laps the dimmed arc without end — the loading lap. Reduced motion holds it
   * still instead: one dash at its rest over the full arc. */
  comet?: boolean
  class?: string
  classList?: Record<string, boolean | undefined>
}) {
  return (
    <svg
      width={13.6}
      height={13.6}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      data-component="progress-circle"
      data-appearance="indicator"
      data-ring=""
      data-ring-comet={props.comet && !prefersReducedMotion() ? "" : undefined}
      class={props.class}
      classList={props.classList}
      style={{ "--progress-circle-progress": props.color }}
    >
      <circle cx="8" cy="8" r={RING_RADIUS} data-slot="progress-circle-background" stroke-width={RING_STROKE} />
      <circle
        cx="8"
        cy="8"
        r={RING_RADIUS}
        data-slot="progress-circle-progress"
        stroke-width={RING_STROKE}
        stroke-dasharray={RING_CIRCUMFERENCE.toString()}
        stroke-dashoffset={RING_CIRCUMFERENCE * (1 - Math.max(0, Math.min(100, props.progress)) / 100)}
      />
      {/* The comet lives on the ring's own canvas: a lead lap on wake that burns out where it
          ends its run, the centre staying clear — and, with `comet`, the loading lap over the
          arc it dims until the work lands. Reduced motion holds it still instead of looping. */}
      <circle
        data-slot="ring-comet"
        cx="8"
        cy="8"
        r={RING_RADIUS}
        fill="none"
        stroke-width={RING_COMET_STROKE}
        stroke-linecap="round"
        pathLength={100}
        stroke-dasharray="18 82"
        class={
          props.comet
            ? "opacity-100"
            : "opacity-0 motion-safe:group-hover:[animation:ring-comet-run_430ms_linear_both] motion-safe:group-has-[:focus-visible]:[animation:ring-comet-run_430ms_linear_both]"
        }
      >
        <Show when={props.comet && !prefersReducedMotion()}>
          <animate attributeName="stroke-dashoffset" dur="1200ms" values="0;-100" repeatCount="indefinite" />
        </Show>
      </circle>
    </svg>
  )
}
