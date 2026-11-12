import { describe, expect, test } from "bun:test"
import {
  createIpcTransportState,
  MAX_BUFFERED_EVENTS,
  selectBoundClientId,
  selectBoundEventQueue,
  selectClientEventQueue,
  selectClientIds,
  selectClientIsDraining,
  selectClientPort,
  selectClientSender,
  transitionIpcTransport,
  type IpcTransportCommand,
  type IpcTransportEvent,
  type IpcTransportState,
} from "./ipc-machine"

// Senders, ports, queues and events are opaque to the machine, so labels stand in for them.
type State = IpcTransportState<string, string, string, string>

type Event = IpcTransportEvent<string, string, string, string>

type Command = IpcTransportCommand<string, string, string, string>

const WINDOW = 7

const prepared: Event = { type: "sender.prepared", senderId: WINDOW, sender: "window" }

function bound(port: string, events: string): Event {
  return { type: "port.bound", senderId: WINDOW, sender: "window", port, events }
}

function emitted(event: string): Event {
  return { type: "event.emitted", senderId: WINDOW, event }
}

function replay(events: readonly Event[], from: State = createIpcTransportState()) {
  return events.reduce<{ state: State; commands: Command[] }>(
    (result, event) => {
      const next = transitionIpcTransport(result.state, event)

      return { state: next.state, commands: [...result.commands, ...next.commands] }
    },
    { state: from, commands: [] },
  )
}

describe("IPC transport machine", () => {
  test("holds a new window's events from its storage snapshot until its port binds", () => {
    // On dev the window had no event queue until bind, so a StorageChanged sent in between was dropped.
    const waiting = replay([prepared, emitted("storage R1")])
    expect(waiting.commands).toEqual([{ type: "watch-sender", senderId: WINDOW, sender: "window" }])
    expect(selectBoundEventQueue(waiting.state, WINDOW)).toBeUndefined()

    const next = transitionIpcTransport(waiting.state, bound("p0", "q0"))
    expect(next.commands).toEqual([
      { type: "attach-port", clientId: 0, port: "p0" },
      { type: "offer-events", events: "q0", items: ["storage R1"] },
    ])
    expect(selectBoundEventQueue(next.state, WINDOW)).toBe("q0")
    expect(selectClientEventQueue(next.state, 0)).toBe("q0")
  })

  test("moves events sent during a reload to the new document and drains the old port", () => {
    // On dev the reload's events went into the old queue, which the new port's bind then shut down.
    const first = replay([bound("p0", "q0")])
    const unloading = transitionIpcTransport(first.state, prepared)
    expect(unloading.commands).toEqual([
      { type: "shutdown-events", events: "q0" },
      { type: "notify-disconnect", clientId: 0 },
    ])
    // The unloading document still answers its pagehide flush, but streams no events.
    expect(selectClientPort(unloading.state, 0)).toBe("p0")
    expect(selectClientSender(unloading.state, 0)).toBe("window")
    expect(selectClientEventQueue(unloading.state, 0)).toBeUndefined()
    expect(selectBoundClientId(unloading.state, WINDOW)).toBeUndefined()
    // The old port still answers in-flight RPCs, but only the pagehide flush is allowed on it.
    expect(selectClientIsDraining(unloading.state, 0)).toBe(true)

    const reloaded = replay(
      [emitted("menu"), emitted("zoom"), emitted("focus"), emitted("storage"), prepared, bound("p1", "q1")],
      unloading.state,
    )

    // Disconnect listeners heard about client 0 once, when its document started unloading.
    expect(reloaded.commands).toEqual([
      { type: "close-port", port: "p0" },
      { type: "end-client", clientId: 0 },
      { type: "attach-port", clientId: 1, port: "p1" },
      { type: "offer-events", events: "q1", items: ["menu", "zoom", "focus", "storage"] },
    ])
    expect(selectClientIds(reloaded.state)).toEqual(new Set([1]))
    expect(selectBoundClientId(reloaded.state, WINDOW)).toBe(1)
  })

  test("marks a client as draining only until its replaced port closes", () => {
    const active = replay([bound("p0", "q0")])
    expect(selectClientIsDraining(active.state, 0)).toBe(false)

    const draining = transitionIpcTransport(active.state, prepared).state
    expect(selectClientIsDraining(draining, 0)).toBe(true)

    const closed = transitionIpcTransport(draining, { type: "client.closed", clientId: 0 }).state
    expect(selectClientIsDraining(closed, 0)).toBe(false)
    // A client that never existed is not draining either.
    expect(selectClientIsDraining(closed, 99)).toBe(false)
  })

  test("keeps a reload's events when the old port closes before the new one binds", () => {
    // On dev the closing port deleted the window's queue, so later events had nowhere to go.
    const closed = replay([bound("p0", "q0"), prepared, emitted("storage"), { type: "client.closed", clientId: 0 }])
    expect(closed.commands.slice(-2)).toEqual([
      { type: "close-port", port: "p0" },
      { type: "end-client", clientId: 0 },
    ])
    expect(selectClientIds(closed.state)).toEqual(new Set())

    expect(transitionIpcTransport(closed.state, bound("p1", "q1")).commands).toEqual([
      { type: "attach-port", clientId: 1, port: "p1" },
      { type: "offer-events", events: "q1", items: ["storage"] },
    ])
  })

  test("replaces a bound port that is rebound without a snapshot", () => {
    const rebound = replay([bound("p0", "q0"), bound("p1", "q1")])
    expect(rebound.commands.slice(2)).toEqual([
      { type: "shutdown-events", events: "q0" },
      { type: "close-port", port: "p0" },
      { type: "notify-disconnect", clientId: 0 },
      { type: "end-client", clientId: 0 },
      { type: "attach-port", clientId: 1, port: "p1" },
    ])
    expect(selectClientSender(rebound.state, 0)).toBeUndefined()
    expect(selectBoundEventQueue(rebound.state, WINDOW)).toBe("q1")
  })

  test("forgets a window whose bound port closes", () => {
    const closed = replay([bound("p0", "q0"), { type: "client.closed", clientId: 0 }])
    expect(closed.commands.slice(2)).toEqual([
      { type: "shutdown-events", events: "q0" },
      { type: "close-port", port: "p0" },
      { type: "notify-disconnect", clientId: 0 },
      { type: "end-client", clientId: 0 },
      { type: "unwatch-sender", senderId: WINDOW, sender: "window" },
    ])
    // Events for a window with no document on the way are not held.
    const after = transitionIpcTransport(closed.state, emitted("late"))
    expect(after.state).toBe(closed.state)
  })

  test.each([
    {
      name: "bound",
      events: [bound("p0", "q0")],
      released: ["shutdown-events", "close-port", "notify-disconnect", "end-client"],
    },
    { name: "awaiting its first port", events: [prepared], released: [] },
    { name: "draining a reload", events: [bound("p0", "q0"), prepared], released: ["close-port", "end-client"] },
  ])("releases a destroyed window that is $name", (input) => {
    const before = replay(input.events)
    const next = transitionIpcTransport(before.state, { type: "sender.destroyed", senderId: WINDOW })
    expect(next.commands.map((command) => command.type)).toEqual([...input.released, "unwatch-sender"])
    expect(selectClientIds(next.state)).toEqual(new Set())
    expect(transitionIpcTransport(next.state, emitted("late")).state).toBe(next.state)
  })

  test.each([
    { name: "buffers a burst of 1,000 events in order", events: 1_000, held: 1_000 },
    {
      name: "buffers up to the cap and drops the event past it",
      events: MAX_BUFFERED_EVENTS + 1,
      held: MAX_BUFFERED_EVENTS,
    },
  ])("$name, reporting each held event to the sink", ({ events, held }) => {
    // AE-042 mutates the buffered array in place, so the sink's change check (`state !== before` in
    // IpcServerProtocolLive) only keeps an event when the transition returns a new top-level state.
    const names = Array.from({ length: events }, (_, index) => `e${index}`)
    const burst = names.reduce(
      (result, name) => {
        const next = transitionIpcTransport(result.state, emitted(name))
        return { state: next.state, changed: [...result.changed, next.state !== result.state] }
      },
      { state: replay([prepared]).state, changed: [] as boolean[] },
    )

    // Only the events past the cap keep the state identity, and those are the ones dropped.
    expect(burst.changed.flatMap((changed, index) => (changed ? [] : [index]))).toEqual(
      Array.from({ length: events - held }, (_, index) => held + index),
    )
    expect(transitionIpcTransport(burst.state, bound("p0", "q0")).commands).toEqual([
      { type: "attach-port", clientId: 0, port: "p0" },
      { type: "offer-events", events: "q0", items: names.slice(0, held) },
    ])
  })

  test("ignores stale and repeated events", () => {
    const waiting = replay([prepared]).state
    expect(transitionIpcTransport(waiting, prepared).state).toBe(waiting)
    expect(transitionIpcTransport(waiting, { type: "client.closed", clientId: 3 }).state).toBe(waiting)
    expect(transitionIpcTransport(waiting, { type: "sender.destroyed", senderId: 99 }).state).toBe(waiting)
  })

  test("closes everything on dispose and refuses later ports", () => {
    const disposed = replay([bound("p0", "q0"), { type: "disposed" }])
    expect(disposed.state).toEqual({ status: "disposed" })
    expect(disposed.commands.slice(2).map((command) => command.type)).toEqual([
      "shutdown-events",
      "close-port",
      "notify-disconnect",
      "end-client",
      "unwatch-sender",
    ])
    expect(transitionIpcTransport(disposed.state, bound("p1", "q1")).commands).toEqual([
      { type: "close-port", port: "p1" },
      { type: "shutdown-events", events: "q1" },
    ])
    expect(transitionIpcTransport(disposed.state, prepared).commands).toEqual([])
  })
})
