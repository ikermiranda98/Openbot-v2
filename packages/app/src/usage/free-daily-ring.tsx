// The titlebar's ring for the current exit's use of OpenCode's free allowance: an arc that fills
// toward the free tier's request cap, and slides its share and the reset time out
// beside it on hover. It sums the local session stats of every server the app knows from midnight
// UTC — the gateway's own day — on mount, whenever a server reports that a step's usage was stored,
// and once a minute as a fallback, less what the day stood at when the exit last rotated (the
// gateway counts per /64). That count is this desk's own: the gateway's counter belongs to the exit
// address and may hold more, so the gateway's refusal is taken as the truth the moment it arrives
// (full and red, with the gateway's own time to come back) until a step succeeds again — the typed
// FreeUsageLimitError, and since an edge in front of the gateway can refuse a whole /64 without the
// type, any 429 that refuses with the gateway's own Retry-After. The turn a refusal cut carries on
// once a rotation has landed: the sessions it stopped resume straight on the fresh /64, with
// nothing admitted into their chats.
import "./free-daily-ring.css"
import { createEffect, createMemo, onCleanup, onMount, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { Schema } from "effect"
import type { GhostRotateOrigin } from "@opencode/client/promise"
import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform } from "@/runtime/platform/platform"
import { useGlobal } from "@/runtime/server/runtime"
import { ServerConnection, useServers } from "@/runtime/server/registry"
import { Persistence } from "@/runtime/persistence/schema"
import { Persist, persisted } from "@/runtime/persistence/storage"
import { useCommand } from "@/shell/commands/command"
import { useSettings } from "@/settings/model"
import { ROTATE_COMMAND } from "@/usage/rotation"
import {
  freeDailyLevel,
  freeDailyLimit,
  freeDailyUsageOf,
  freeExitUsage,
  ipv6BucketOf,
  startOfFreeDay,
  type FreeDailyLevel,
} from "./free-daily"
import { agota, aterriza, rechaza, sirvePaso, vigia, type Vigia } from "./free-daily-rotate"
import { Ring } from "./ring"
import { bloqueado, rotando, transicion, veredictoDe, type Anillo, type EventoAnillo } from "./free-daily-ring-machine"

// Only covers a usage event lost to a reconnect: the events themselves drive the ring.
const FALLBACK_MS = 60_000

// Several sessions can store a step at once; their events collapse into one read.
const SETTLE_MS = 250

// The reconciliation beat holds its class this long; the comet's one-lap run inside it takes 430 ms.
const AVISTA_MS = 600

// A failed automatic rotation waits this long before the ring tries again, so a WARP that will not
// land a fresh /64 is not hammered with one run after another.
const RETRY_MS = 5 * 60_000

// A server that did not answer is not a run that failed: nothing busy ran behind it, so the ring
// only waits this long before the next refresh may try again.
const REACH_MS = 60_000

// Where the current exit's count starts: the day's request count when the exit last rotated. It
// survives restarts, and a stored day other than today's counts as no rotation yet. `blind` marks
// a count nobody read: a rotation that landed with no read of its day anchors at zero, and the
// first read of the day re-anchors the record instead. The bucket is the /64 the count belongs
// to: whenever the engine's current /64 disagrees with it, another rotation happened out of band
// (the desktop bat, a script) and the refresh reconciles the record.
const ExitSchema = Persistence.struct({
  day: Persistence.optional(Schema.Number),
  requests: Persistence.optional(Schema.Number),
  bucket: Persistence.optional(Schema.String),
  blind: Persistence.optional(Schema.Boolean),
})

// What each refusal measured: how many of this desk's requests the gateway accepted on the exit
// before saying no. They outlive restarts and days — a /64's capacity is the same figure on its
// next day — and the ring reads the median of the latest ones instead of guessing once.
const SamplesSchema = Persistence.struct({
  values: Persistence.array(Schema.Number),
})

// A rotation's verdict holds the ring's centre this long, hovered or not, before it clears.
const SELLO_MS = 20_000

// The glyph a settled verdict shows inside the ring — the only art its centre holds: the native
// check and xmark-small strokes, both centred on (8, 8) in their 16-unit artwork, drawn on the
// ring's own canvas so they share its centre exactly (an icon box of its own snaps to the pixel
// grid apart from the ring and drifts off-centre at fractional scales).
const GLIFO = {
  ok: "M3.53613 8.17857L6.39328 11.75L12.4647 4.25",
  fallo: "M4.25 11.75L11.75 4.25M11.75 11.75L4.25 4.25",
} as const

// The comet is the ring itself: a lead lap on the ring at the arc's own state colour, one
// shade thicker, from the dash's rest while the pill opens — it burns out where it ends its
// run and the centre stays clear. While the engine rotates, that same comet laps without end
// over the arc it dims: the rotation's loading indicator. Under reduced motion it holds still
// — one dash at its rest — so the rotation keeps a marker without motion. The ring's own
// geometry and the comet live on the shared Ring (@/usage/ring).

// Each band paints the arc with the theme's own state colour (light and dark come with it).
const LEVEL_COLOR: Record<FreeDailyLevel, string> = {
  normal: "var(--v2-state-fg-info)",
  warning: "var(--v2-state-fg-warning)",
  danger: "var(--v2-state-fg-danger)",
}

export function FreeDailyUsageRing() {
  const language = useLanguage()
  const servers = useServers()
  const global = useGlobal()
  const platform = usePlatform()
  const command = useCommand()
  const settings = useSettings()

  const [store, setStore] = createStore<{
    usage?: ReturnType<typeof freeDailyUsageOf>
    // The engine server's own read alone: the /64 the gateway limits is this machine's, so the
    // exit record anchors on this count. A silent motor keeps its last read.
    usoMotor?: ReturnType<typeof freeDailyUsageOf>
    // The pill's cycle, as the state machine free-daily-ring-machine.ts holds it.
    anillo: Anillo
    // A failed run's retry wait, the driver's own timer: no auto rotation until it passes.
    retryAt?: number
    // The sessions the gateway's refusal stopped, on the server that reported them: a landed
    // rotation sends each one an admission-less resume to carry on, and a succeeding step drops it.
    reanudar: Array<{ id: string; servidor: ServerConnection.Key }>
    // When the record finds an exit the ring did not move, the class rides one comet lap.
    avista?: number
    // The free day the engine server's own read belongs to: a read fetched for yesterday would
    // anchor a fresh exit on the wrong day's count, so the record's own anchoring reads this
    // day, not any server's.
    usoMotorDia?: number
    // The dead-exit watch (free-daily-rotate.ts): the standing exit's finished responses, and the
    // consecutive landings the gateway refused with not one behind them — the bound that holds
    // the automatic rotation when no fresh /64 is serving today.
    salida: Vigia
  }>({ anillo: { fase: "reposo" }, reanudar: [], salida: vigia() })

  // A transition's state replaces the pill whole: a plain store write would merge the object
  // into the previous one, and a phase's dropped fields (a rotando's own block, say) would
  // survive it — `bloqueado` would then read a block the machine had already lifted.
  const transitar = (evento: EventoAnillo) => setStore("anillo", reconcile(transicion(store.anillo, evento)))

  const [exit, setExit, , exitReady] = persisted(Persist.global("usage.free-exit"), ExitSchema, {})

  const [samples, setSamples] = persisted(Persist.global("usage.free-samples"), SamplesSchema, { values: [] })

  // The gateway's limit on the exit serving now: the seed until a refusal measures it, then the
  // median of the latest refusals. A sample alone does not move the ring — only a 429 rotates.
  const limite = createMemo(() => freeDailyLimit(samples.values))

  // The day's count the current exit anchors to: zero for a day the record does not know yet.
  const ancla = createMemo(() => (exit.day === startOfFreeDay(Date.now()) ? (exit.requests ?? 0) : 0))

  // The current /64's share: the day's count less what it stood at when the exit last rotated today.
  const exitUsage = createMemo(() =>
    store.usage ? freeExitUsage(store.usage, ancla(), limite()) : undefined,
  )

  // Handing the machine's own address back: the free day renewed, or the app came up over an
  // old run's exit, so the hosts pin comes off the hosts and WARP hangs up — and a later
  // refusal rotates straight back. A rotation running right now keeps its exit: the engine
  // retires a release through its lock (ok:false) and the next refresh asks again. No
  // notification rides on it — winding down is the day's own quiet course.
  const soltar = async () => {
    if (rotando(store.anillo)) return

    const conn = servers.visible.find(servers.current) ?? servers.visible[0]

    if (!conn) return

    const respuesta = await global
      .serverCtx(ServerConnection.key(conn))
      ?.sdk.api.experimental.ghost.release()
      .catch(() => undefined)

    // A released exit serves the day's whole count: the machine's own address started.
    if (respuesta?.ok) setExit({ day: startOfFreeDay(Date.now()), requests: 0, bucket: undefined, blind: undefined })
  }

  // The gateway counts the whole connection, so every server this app knows adds its own day:
  // the desktop's own sidecar, and any other OpenCode on this machine added in Settings ›
  // Servers. A server that does not answer adds nothing; the ring keeps its last value only
  // when none answered at all.
  const refresh = async () => {
    const now = Date.now()

    // Only a server on this machine (the desktop's sidecar, or the server that served the web app)
    // runs this machine's engine — a remote server's engine would watch the machine behind it.
    const engine = servers.visible.find(servers.current)
    const motorEn = engine === undefined ? -1 : servers.visible.indexOf(engine)

    const [days, status] = await Promise.all([
      Promise.all(
        servers.visible.map((conn) =>
          global
            .serverCtx(ServerConnection.key(conn))
            ?.sdk.api.experimental.session.stats({
              from: startOfFreeDay(now),
              to: now,
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              tools: "none",
            })
            .catch(() => undefined),
        ),
      ),
      engine
        ? global.serverCtx(ServerConnection.key(engine))?.sdk.api.experimental.ghost.status().catch(() => undefined)
        : Promise.resolve(undefined),
    ])

    const answered = days.filter((item) => item !== undefined)

    if (answered.length === 0) return

    const day = freeDailyUsageOf(answered, limite())

    // The engine server's own read: the /64 the gateway limits is this machine's, and the record
    // anchors on this count. A silent motor leaves no read to anchor on.
    const motorLectura = motorEn >= 0 ? days[motorEn] : undefined
    const motorUso = motorLectura === undefined ? undefined : freeDailyUsageOf([motorLectura], limite())

    // A rotation the ring did not ask for (the desktop bat, a script, another window) moves the exit
    // without touching the stored record, so whenever the engine's current /64 disagrees with the
    // record another rotation happened and the share restarts on the day's own count. A rotation
    // whose count no read ever fetched lands here too: the record marks it blind, and the first read
    // of its day re-anchors it on the count the read found. While a run holds the ring its memory is
    // mid-update — the run's own answer reconciles the record instead. All of this runs before the
    // usage lands in the store, so the day's share never reads a fresh count against the old anchor.
    const current = status?.warp === "connected" ? status.current : undefined

    if (current !== undefined && exitReady() && !rotando(store.anillo)) {
      if (exit.bucket !== current || exit.blind === true) {
        // The record anchors on the engine's own count — the /64 the gateway limits is this
        // machine's. With no engine read this refresh, the fresh count is unknown: anchor at
        // zero and mark the record blind, so the next read re-anchors it.
        setExit({
          day: startOfFreeDay(now),
          requests: motorUso?.requests ?? 0,
          bucket: current,
          blind: motorUso === undefined ? true : undefined,
        })
        // A move the ring did not ask for is a landing all the same: the fresh exit starts uncounted.
        setStore("salida", (v) => aterriza(v))
        setStore("avista", Date.now())
      } else if (exit.day !== startOfFreeDay(now)) {
        // The same exit carried across the free day's renewal: nothing moved it, so the gateway's
        // own day restarted under it — the share reads the whole new day, and the record re-dates
        // at zero, quietly. No lap: the exit is the record's own, not a move the ring missed.
        setExit({ day: startOfFreeDay(now), requests: 0, bucket: current, blind: undefined })
        // The free day renewed under the standing exit: the bound is today's, and it restarts with it.
        setStore("salida", vigia())
      }
    }

    // With nothing of the day's carrying the standing exit — the engine's read names no /64 and
    // the record holds no /64 of today's — it is a past run's leftover. The hosts pin is the one
    // evidence that says so: the rotation program writes it (and only it), so a WARP the ring's
    // user connected themselves never gets hung up by this. The machine's own address comes back
    // and a later refusal rotates the same way as always. Mid-run the record is halfway to its
    // fresh exit — the run's own answer reconciles it, then the next read asks the release.
    if (
      status?.warp === "connected" &&
      status.pin === true &&
      current === undefined &&
      !rotando(store.anillo) &&
      exitReady() &&
      exit.day !== startOfFreeDay(now)
    ) {
      void soltar()
    } else if (
      status !== undefined &&
      status.pin !== true &&
      current === undefined &&
      !rotando(store.anillo) &&
      exitReady() &&
      exit.day !== startOfFreeDay(now)
    ) {
      // With the pin off and no /64 of today's named, the standing exit is the machine's own
      // address (or a tunnel nobody's day records): the stored record is a past run's leftover,
      // and on it the day's share would read against yesterday's anchor. Seeding the day here
      // restarts the share from zero: the next engine read that names a /64 reconciles through
      // the adoption above, and a later refusal rotates the same way as always. A failed
      // status read is no evidence — the engine's answer must stand behind the seed.
      setExit({ day: startOfFreeDay(now), requests: 0, bucket: undefined, blind: undefined })
      // The day's own seed: the bound is today's, and it restarts with it.
      setStore("salida", vigia())
    }

    setStore("usage", day)
    if (motorUso !== undefined) {
      setStore("usoMotor", motorUso)
      setStore("usoMotorDia", startOfFreeDay(now))
    }
  }

  onMount(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), FALLBACK_MS)
    onCleanup(() => clearInterval(timer))
  })

  // The server publishes session.usage.updated once a step's tokens are stored (and after a
  // compaction), so the ring reads the day exactly when it changed instead of polling it.
  let pending: ReturnType<typeof setTimeout> | undefined

  const schedule = () => {
    clearTimeout(pending)
    pending = setTimeout(() => void refresh(), SETTLE_MS)
  }

  onCleanup(() => clearTimeout(pending))

  // The gateway's refusal is the one exact fact about the limit: it holds until the time the
  // gateway gave, or until a step succeeds again (a shared exit such as WARP can move to another
  // address, and so to another counter, long before that).
  const blocked = (retryAfterMs: number | undefined) =>
    transitar({
      tipo: "bloqueo",
      hasta: Date.now() + (retryAfterMs ?? startOfFreeDay(Date.now()) + 86_400_000 - Date.now()),
    })

  createEffect(() => {
    const hasta = bloqueado(store.anillo)

    if (hasta === undefined) return

    const timer = setTimeout(() => {
      transitar({ tipo: "bloqueo.consumado" })

      // A block that ran to the gateway's own day end answers the day's renewal: the free day
      // restarted for every address, so the machine's own comes back (nobody's byte was spent
      // since midnight). A shorter Retry-After keeps the working exit — its counter simply has
      // room again until the gateway refuses it once more. The span reads the captured end one
      // second back, so a midnight stroke reads its own day (a bare day start reads the whole
      // new one away), and a tab's throttled wake does not misread either way.
      if (startOfFreeDay(hasta - 1) + 86_400_000 - hasta < 90_000) void soltar()
    }, hasta - Date.now())
    onCleanup(() => clearTimeout(timer))
  })

  createEffect(() => {
    const unsubscribe = servers.visible.flatMap((conn) => {
      // A server whose context is not up yet adds no listeners; the effect reruns once it is.
      const events = global.serverCtx(ServerConnection.key(conn))?.sdk.event

      if (!events) return []

      return [
        events.on("session.usage.updated", schedule),
        events.on("session.step.ended", (event) => {
          transitar({ tipo: "bloqueo.levantado" })
          // A finished response is the standing exit serving: the dead-exit watch reads it alive,
          // and a hold the bound had set lifts on it.
          setStore("salida", (v) => sirvePaso(v))
          setStore("reanudar", (pendientes) => pendientes.filter((item) => item.id !== event.data.sessionID))
        }),
        events.on("session.step.failed", (event) => {
          const error = event.data.error

          // The gateway's typed refusal (provider.free-limit) is the exact block — and since its
          // limiter stands behind an edge that can answer for the whole /64 first, an untyped 429
          // refused with the gateway's own Retry-After is the block too: full, red, and rotating.
          // A paid provider's throttle dials the same shape and may rotate the exit once
          // pointlessly — harmless, and the failure events carry no model to filter on.
          const refusal =
            error.type === "provider.free-limit" ||
            ((error.type === "provider.rate-limit" || error.type === "provider.quota") &&
              error.status === 429 &&
              error.retryAfterMs !== undefined)

          if (refusal) {
            // The first refusal of a block measures this exit: every request this desk sent the
            // gateway accepted before it said no. A refusal that lands on an already-blocked ring
            // only repeats that count, and a dead exit's handful is filtered by freeDailyLimit.
            if (bloqueado(store.anillo) === undefined) {
              const requests = exitUsage()?.requests

              if (requests !== undefined) setSamples("values", (values) => [...values, requests])
            }
            // The dead-exit watch tallies the refusal before the block claims the ring: a landing
            // no finished response ever used counts once, however many sessions it stopped, and
            // the bound closing announces itself once.
            const previa = store.salida
            const salida = rechaza(previa)
            setStore("salida", salida)
            blocked(error.retryAfterMs)
            setStore(
              "reanudar",
              (pendientes) => [
                ...pendientes.filter((item) => item.id !== event.data.sessionID),
                { id: event.data.sessionID, servidor: ServerConnection.key(conn) },
              ],
            )
            if (agota(salida) && !agota(previa) && settings.rotation.notify())
              void platform.notify(
                language.t("notification.rotation.exhausted.title"),
                language.t("notification.rotation.exhausted.description"),
              )
          }
        }),
      ]
    })

    onCleanup(() => unsubscribe.forEach((off) => off()))
  })

  const porcentaje = createMemo(
    () => new Intl.NumberFormat(language.intl(), { style: "percent", maximumFractionDigits: 0 }),
  )

  const hora = createMemo(() => new Intl.DateTimeFormat(language.intl(), { hour: "2-digit", minute: "2-digit" }))

  // The next reset in the viewer's own clock: midnight UTC reads as 01:00 in Madrid in winter.
  const reset = createMemo(() => hora().format(startOfFreeDay(Date.now()) + 86_400_000))

  // The ring's own act: this machine's ghost engine runs the very rotation program the desktop
  // bat runs on a double-click — a fresh WARP exit /64 deduped against the day's memory, served by
  // this app's own server (a plugin or remote server's engine would rotate that machine's exit).
  // Every rotation lands here, and the origin only rides along to the run's history and the
  // notification's gate: a click or Settings' trigger is manual, the gateway's refusal is limit.
  // The comet laps the dimmed arc while the engine works, folded pill
  // or not (a second click while it rotates lands once, like the bat's own lock). For a moment
  // after the verdict a tic or a cross falls into the ring the same way, folded pill or not, with
  // the outcome on the pill's second line.
  // A server that never answered is not a run that failed: nothing busy ran behind it, so the pill
  // says so, the retry is far shorter, and no failure notification goes out — the next refresh or
  // refusal simply rotates again.
  const SIN_RESPUESTA = "sin-respuesta" as const

  // A landed rotation sends every session the gateway stopped back through its own reloaded
  // history. That resume is one request and a reconnect can lose it: it retries a couple of beats
  // before returning the session to the queue, where the next landing picks it up again — the turn
  // carries on either way, never silently dropped.
  const reanudarSesion = async (
    pendiente: { id: string; servidor: ServerConnection.Key },
    intento = 0,
  ): Promise<void> => {
    const ctx = global.serverCtx(pendiente.servidor)

    if (!ctx) return

    try {
      await ctx.sdk.api.experimental.session.resume({ sessionID: pendiente.id })
    } catch {
      if (intento >= 2) {
        setStore("reanudar", (pendientes) =>
          pendientes.some((item) => item.id === pendiente.id) ? pendientes : [...pendientes, pendiente],
        )

        return
      }

      await new Promise((done) => setTimeout(done, 1_500))
      await reanudarSesion(pendiente, intento + 1)
    }
  }

  const sellar = async (origin: GhostRotateOrigin = "manual") => {
    // Claim the ring in the same beat the run is asked for, before the first await.
    if (rotando(store.anillo)) return
    transitar({ tipo: "rotar" })

    // WARP's service stopped (only an administrator starts it): the app's own window asks Windows'
    // permission first, so the prompt opens in front of it, once. A declined prompt fails this run.
    const servicio = platform.startWarpService ? await platform.startWarpService().catch(() => false) : true

    const conn = servers.visible.find(servers.current) ?? servers.visible[0]

    const llamada =
      servicio && conn
        ? global.serverCtx(ServerConnection.key(conn))?.sdk.api.experimental.ghost.rotate({ origin })
        : undefined

    const respuesta = await (llamada?.catch(() => SIN_RESPUESTA) ?? Promise.resolve(SIN_RESPUESTA))

    if (respuesta === SIN_RESPUESTA) {
      transitar({ tipo: "falló", causa: "servidor" })
      setStore("retryAt", Date.now() + REACH_MS)

      return
    }

    if (!respuesta.ok) {
      transitar({ tipo: "falló", causa: "motor" })
      setStore("retryAt", Date.now() + RETRY_MS)

      if (origin !== "manual" && settings.rotation.notify())
        void platform.notify(
          language.t("notification.rotation.failed.title"),
          language.t("notification.rotation.failed.description"),
        )

      return
    }

    // A fresh /64 starts its own count, and the gateway's block on the old one no longer applies.
    // Without the engine's read of today the count is unknown: anchor at zero and mark the
    // record blind, so the watch holds until the engine's first read of the day re-anchors it.
    // A remote server's read tells nothing about this machine's fresh /64, so the record's
    // own read decides — `usoMotorDia`, not any server's `usoDia`.
    const hoy = startOfFreeDay(Date.now())
    const leido = store.usoMotorDia === hoy

    setExit({
      day: hoy,
      requests: leido ? (store.usoMotor?.requests ?? 0) : 0,
      bucket: respuesta.address ? ipv6BucketOf(respuesta.address) : undefined,
      blind: leido ? undefined : true,
    })
    transitar({ tipo: "aterrizó", dirección: respuesta.address ?? "" })
    // The fresh exit starts the dead-exit watch over — and a manual rotation is the user's own
    // word that an exit is worth trying, so the whole bound resets with it.
    setStore("salida", (v) => (origin === "manual" ? vigia() : aterriza(v)))

    // The block's readers carry on without a trace: every session a refusal stopped gets one
    // admission-less resume on the server that reported it, and its executor re-runs the turn from
    // reloaded history — a failed step contributes nothing, so no chat row exists to explain it.
    // The gateway's memory on the fresh /64 is the loop bound: when no fresh /64 remains today, the
    // run fails through its own events and nothing publishes. Two windows on the machine may both
    // send, as each keeps its own record.
    for (const pendiente of [...store.reanudar]) {
      setStore("reanudar", (pendientes) => pendientes.filter((item) => item.id !== pendiente.id))
      void reanudarSesion(pendiente)
    }

    if (origin !== "manual" && settings.rotation.notify())
      void platform.notify(
        language.t("notification.rotation.ok.title"),
        language.t("notification.rotation.ok.description", { address: respuesta.address ?? "" }),
      )
  }

  // The rotate command never shows in the palette (the ring's click is the one visible door), but
  // Settings › IPv6 and WARP's "Rotate now" triggers it, so its rotation passes through this
  // sellar too and the count, exit record and verdict stay in one place.
  command.register("ring", () => [
    {
      ...ROTATE_COMMAND,
      title: language.t("usage.freeDaily.ipv6Show"),
      category: language.t("command.category.network"),
      hidden: true,
      onSelect: () => void sellar(),
    },
  ])

  // The ring rotates on its own while Settings › IPv6 and WARP leaves it on — and only when the
  // gateway refuses: the refusal is the limit made fact, the one word about this exit the desk
  // never has to guess at. A reply in flight waits through the reconnect and carries on, and a
  // 429 that lands anyway reads as full and rotates at once. A failed run waits RETRY_MS.
  createEffect(() => {
    if (rotando(store.anillo) || store.retryAt !== undefined) return
    if (!settings.rotation.auto()) return

    // No fresh /64 has served today: the dead-exit bound holds the automatic rotation — every
    // run would land on an exit the gateway refuses at once and flap the tunnel for nothing.
    // A manual rotation or a finished response clears it.
    if (agota(store.salida)) return

    // The gateway's refusal rotates whatever the record says — including a day whose count no
    // read ever fetched: the refusal is the gateway's own word about this exit, not the desk's
    // guess, so the record's absence holds nothing back.
    if (bloqueado(store.anillo) !== undefined) void sellar("limit")
  })

  createEffect(() => {
    const at = store.retryAt

    if (at === undefined) return

    const timer = setTimeout(() => setStore("retryAt", undefined), at - Date.now())
    onCleanup(() => clearTimeout(timer))
  })

  // A settled verdict holds its glyph, then clears the way for the next one — the same shape the
  // block's own watch above keeps. A verdict a block caught clears the verdict alone.
  createEffect(() => {
    const veredicto = veredictoDe(store.anillo)

    if (veredicto === undefined) return

    const timer = setTimeout(() => transitar({ tipo: "veredicto.consumado" }), SELLO_MS)
    onCleanup(() => clearTimeout(timer))
  })

  // The discovery of an exit the ring did not move holds its class a beat, so the reconciliation's
  // comet lap can run, and then clears for the next move.
  createEffect(() => {
    const at = store.avista

    if (at === undefined) return

    const timer = setTimeout(() => setStore("avista", undefined), AVISTA_MS)
    onCleanup(() => clearTimeout(timer))
  })

  // What the ring does, or did: its accessible description and, while a rotation runs or its
  // verdict holds, the pill's second line.
  const avisoSello = () => {
    if (rotando(store.anillo)) return language.t("usage.freeDaily.ipv6Looking")

    const veredicto = veredictoDe(store.anillo)

    if (veredicto === undefined) return language.t("usage.freeDaily.ipv6Show")

    if (veredicto.tipo === "ok") return language.t("usage.freeDaily.ipv6New", { address: veredicto.dirección })

    return veredicto.causa === "servidor" ? language.t("usage.freeDaily.ipv6Server") : language.t("usage.freeDaily.ipv6None")
  }

  return (
    <Show when={store.usage}>
      {(usage) => {
        const percent = () => (bloqueado(store.anillo) === undefined ? (exitUsage()?.percent ?? usage().percent) : 100)

        const label = () =>
          bloqueado(store.anillo) === undefined
            ? language.t("usage.freeDaily.label", { percent: String(Math.round(percent())) })
            : language.t("usage.freeDaily.labelBlocked")

        const level = () => freeDailyLevel(percent())

        // Two lines beside the ring: the day's share, then when it starts over (or, blocked, when the
        // gateway lets requests through again) — or the rotation's progress and outcome while they hold.
        const cuando = () => {
          if (rotando(store.anillo)) return avisoSello()

          if (veredictoDe(store.anillo)) return avisoSello()

          const hasta = bloqueado(store.anillo)

          return hasta === undefined
            ? `${language.t("usage.freeDaily.resets")} ${reset()}`
            : `${language.t("usage.freeDaily.back")} ${hora().format(hasta)}`
        }

        // The titlebar update pill's own reveal: the pill grows to fit on hover or focus and its
        // contents slide in after the ring. It grows in the row's own flow and pushes its
        // neighbours aside while it holds, so nothing rides over them. The ring is the rotate
        // button: on hover it grows a step with the pill and a comet laps the arc announcing the
        // wake; while a rotation runs that comet laps the dimmed arc, the loading indicator.
        return (
          // Pulled in against the product switcher: the row's 6px gap reads as a separate group.
          // The hover wake is one choreography on the house curve: the comet takes the ring first,
          // pill, dome and centre beat at once behind it, and the details slide in after a
          // settled beat — while leaving drops every delay, so the retract is quick.
          <div data-component="free-daily-ring" class="relative -ms-1 h-7 shrink-0">
            <div
              data-verdict={veredictoDe(store.anillo)?.tipo}
              class="group h-7 flex w-7 items-center overflow-clip rounded-[6px] bg-v2-background-bg-deep text-v2-icon-icon-muted motion-safe:[transition:width_200ms_cubic-bezier(0.22,1,0.36,1)] [interpolate-size:allow-keywords] hover:w-fit has-[:focus-visible]:w-fit [app-region:no-drag]"
            >
              <span class="flex size-full items-center rounded-[6px] group-hover:bg-v2-overlay-simple-overlay-hover group-has-[:focus-visible]:bg-v2-overlay-simple-overlay-hover motion-safe:[transition:background-color_150ms_ease-out]">
                {/* Only the ring is the rotate button; the details beside it are information. Its
                    hover overlay stacks on the pill's own, the ghost icon button's state. */}
                <button
                  type="button"
                  data-slot="free-daily-usage"
                  aria-label={label()}
                  aria-description={avisoSello()}
                  aria-busy={rotando(store.anillo)}
                  onClick={() => void sellar()}
                  class="grid size-7 shrink-0 place-items-center rounded-[6px] text-v2-icon-icon-muted hover:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none motion-safe:[transition:background-color_150ms_ease-out]"
                >
                  {/* Ring and centre grow together, so the centre never drifts off the arc. */}
                  <span class="grid place-items-center motion-safe:[transition:scale_200ms_cubic-bezier(0.22,1,0.36,1)] group-hover:scale-[1.3] group-has-[:focus-visible]:scale-[1.3]">
                    {/* The shared hooks still paint the ring: with its data slots the
                        ProgressCircle stylesheet applies the colours, the rotate -90 that starts
                        the fill at the top, and the dashoffset transition. Only the geometry is
                        the Ring's. */}
                    <Ring
                      progress={percent()}
                      color={LEVEL_COLOR[level()]}
                      comet={rotando(store.anillo)}
                      class="[grid-area:1/1]"
                      classList={{
                        "free-daily-blocked": bloqueado(store.anillo) !== undefined,
                        "free-daily-avista": store.avista !== undefined,
                      }}
                    />
                    <Show when={!rotando(store.anillo)}>
                      <Show when={veredictoDe(store.anillo)}>

                        {(glifo) => (
                          <svg
                            width={13.6}
                            height={13.6}
                            viewBox="0 0 16 16"
                            fill="none"
                            aria-hidden="true"
                            data-slot="ring-verdict"
                            class="[grid-area:1/1]"
                            classList={{
                              "text-v2-state-fg-success": glifo().tipo === "ok",
                              "text-v2-state-fg-danger": glifo().tipo === "fallo",
                            }}
                          >
                            <path
                              data-slot="ring-verdict-stroke"
                              d={GLIFO[glifo().tipo]}
                              stroke="currentColor"
                              transform="translate(8 8) scale(0.72) translate(-8 -8)"
                            />
                          </svg>
                        )}
                      </Show>
                    </Show>
                  </span>
                </button>
                <span
                  data-slot="free-daily-usage-details"
                  aria-hidden="true"
                  class="ms-px me-2.5 flex shrink-0 -translate-x-2 flex-col whitespace-nowrap text-start text-[11px] leading-[13px] opacity-0 motion-safe:[transition:all_180ms_cubic-bezier(0.22,1,0.36,1)] group-hover:translate-x-0 group-hover:opacity-100 group-hover:[transition-delay:90ms] group-has-[:focus-visible]:translate-x-0 group-has-[:focus-visible]:opacity-100 group-has-[:focus-visible]:[transition-delay:90ms] motion-reduce:translate-x-0 rtl:translate-x-2"
                >
                  <span class="text-v2-text-text-base [font-weight:530]">
                    {language.t("usage.freeDaily.title")} ·{" "}
                    {bloqueado(store.anillo) === undefined
                      ? porcentaje().format(percent() / 100)
                      : language.t("usage.freeDaily.blocked")}
                  </span>
                  <span class="text-v2-text-text-muted [font-weight:440]">{cuando()}</span>
                </span>
              </span>
            </div>
          </div>
        )
      }}
    </Show>
  )
}
