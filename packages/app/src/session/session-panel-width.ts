// The review pane has no width of its own: it takes whatever the chat panel
// leaves behind. Instead of capping the chat panel at a fraction of the window
// (which forces the review pane to grow with the monitor), reserve a fixed
// minimum for the review pane and let the chat panel take everything else.
// Until the user drags the divider, the default width keeps roomier minimums
// (wider still for split diffs); a drag can take either side down to the hard
// minimum. The chat minimum leaves the session header room for its title beside
// its controls, macOS traffic lights included.
export const SESSION_PANEL_WIDTH_MIN = 400

/** The one gap the pane row keeps between its panels; the CSS formulas below and the
 * consumers deriving a row width from it all read this constant. */
export const PANE_GAP = 8

export const SIDE_PANE_WIDTH_MIN = 320

const SESSION_PANEL_WIDTH_FIT = 450

const REVIEW_PANE_WIDTH_FIT = 480

const REVIEW_PANE_WIDTH_FIT_SPLIT = 800

/** The trading dashboard's own floor on the row this module sizes: the desk's cards and
 * header need this much room — the review pane's 320 hard floor crushes them (Panic and
 * Connect already crowd together near 366). The trading chat passes it as `paneMin`, so
 * the pane the chat leaves behind never drops below it, dragged or not — one uniform cap
 * instead of the dragged-state drop to the side-pane minimum. */
export const TRADING_DASH_WIDTH_MIN = 480

/** The trading chat's own hard floor: 15% under the session panel's, for the trading desk's
 * tighter rows — the extra give the user asked for when dragging the chat narrower. Passed
 * as `chatMin` by the trading panel; session screens keep the session panel's floor. */
export const TRADING_CHAT_WIDTH_MIN = Math.round(SESSION_PANEL_WIDTH_MIN * 0.85)

/** The trading chat's emergency floor: when the row cannot hold the chat's own minimum
 * beside the dashboard's, the chat gives way down to this width so the desk keeps its
 * floor (the user's call: the chat shrinks, the desk never crushes). */
export const TRADING_CHAT_WIDTH_FLOOR = 260

/** The trading pane row's minimum with the chat open: the chat's emergency floor, the pane
 * gap, and the dashboard's own floor. The shell caps the sidebar against this (plus the
 * row's side insets) so widening it can never crush the desk. */
export const TRADING_ROW_WIDTH_MIN = TRADING_CHAT_WIDTH_FLOOR + PANE_GAP + TRADING_DASH_WIDTH_MIN

/** A session row with its side panel open: the chat panel's resting floor (it rests at the
 * roomier fit until dragged), the gap, and the side pane's hard floor. The session screen
 * claims it from the shell while the side panel shows, so the sidebar never crushes either. */
export const SESSION_ROW_WIDTH_MIN = SESSION_PANEL_WIDTH_FIT + PANE_GAP + SIDE_PANE_WIDTH_MIN

export function sessionPanelWidthMax(input: { available: number; split: boolean; resized: boolean; paneMin?: number; chatMin?: number }) {
  // The dragged cap bottoms at the caller's floor too (the trading chat passes 340, the
  // session's own 400): the handle and the resting CSS must clamp the stored width with
  // the SAME floor or the two disagree below the row's room and the inner pane paints
  // wider than its face.
  if (input.resized) return Math.max(input.chatMin ?? SESSION_PANEL_WIDTH_MIN, input.available - (input.paneMin ?? SIDE_PANE_WIDTH_MIN))
  const pane = input.split ? REVIEW_PANE_WIDTH_FIT_SPLIT : REVIEW_PANE_WIDTH_FIT

  return Math.max(SESSION_PANEL_WIDTH_FIT, input.available - pane)
}

// The same limit in CSS, against the pane row's width less its 8px gap, so the chat panel follows the row on the frame
// it resizes, e.g. while the left sidebar moves, rather than after a ResizeObserver callback.
export function sessionPanelWidthCss(input: { width: number; split: boolean; resized: boolean; paneMin?: number; chatMin?: number }) {
  // `chatMin` trades the session panel's own floor for the caller's (the trading chat's,
  // 15% under): on both the outer resting floor and the dragged minimum, so a stored
  // width under the session floor survives the clamp instead of re-raising to it.
  const floor = input.chatMin ?? SESSION_PANEL_WIDTH_MIN
  const minimum = input.resized ? floor : SESSION_PANEL_WIDTH_FIT
  const pane = input.paneMin ?? (input.resized ? SIDE_PANE_WIDTH_MIN : input.split ? REVIEW_PANE_WIDTH_FIT_SPLIT : REVIEW_PANE_WIDTH_FIT)

  // The outer floor raises a width stored below the minimum, e.g. dragged before it rose.
  return `max(${floor}px, min(${input.width}px, max(${minimum}px, 100% - ${pane + PANE_GAP}px)))`
}

// A panel with a side width of its own: the chat panel takes the rest of the row, keeping at least its minimum.
export function sidePanelWidthCss(side: number) {
  return `max(${SESSION_PANEL_WIDTH_MIN}px, 100% - ${Math.max(SIDE_PANE_WIDTH_MIN, side) + 8}px)`
}

// `available` is undefined until the layout row is first measured; render the
// stored width untouched until then to avoid a first-frame snap.
export function clampSessionPanelWidth(input: {
  width: number
  available: number | undefined
  split: boolean
  resized: boolean
  paneMin?: number
  chatMin?: number
}) {
  const width = Math.max(input.chatMin ?? SESSION_PANEL_WIDTH_MIN, input.width)

  if (input.available === undefined) return width

  return Math.min(width, sessionPanelWidthMax({ ...input, available: input.available }))
}
