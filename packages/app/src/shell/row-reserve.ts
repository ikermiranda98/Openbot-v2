import { createEffect, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { uuid } from "@opencode/util/uuid"
import { TRADING_DASH_WIDTH_MIN } from "@/session/session-panel-width"

// The width the content beside the vertical-tabs sidebar needs to stay usable; the shell caps
// the sidebar against it so widening the sidebar can never crush the panes beside it. Screens
// with panes of their own claim more while those panes show (a session with its side panel,
// the trading desk with its chat), each claim living as long as its owner, so the order in
// which screens mount and unmount while navigating never matters. With no claim the reserve
// is the trading dashboard's floor — the cap every screen had before claims existed.
const [claims, setClaims] = createStore<Record<string, number | undefined>>({})

export function rowReserve() {
  return Object.values(claims).reduce<number>((max, width) => (width === undefined ? max : Math.max(max, width)), TRADING_DASH_WIDTH_MIN)
}

/** Claims `width` for the calling owner's lifetime; the claim follows the accessor. */
export function claimRowReserve(width: () => number) {
  const id = uuid()

  createEffect(() => setClaims(id, width()))
  onCleanup(() => setClaims(id, undefined))
}
