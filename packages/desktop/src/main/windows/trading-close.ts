// A window close that would leave trading bots running or open positions unattended stops
// for a native warning first. The bots are children of the sidecar server, so they keep
// trading — and the positions stay exposed — without the window. The same gate answers an
// app quit: that close runs before the windows close, so none of their close events can
// ask (their handler sees `quitting` and passes), and before-quit asks once here with no
// window to parent on. A Windows session-end stays unaskable outright — the OS logoff is
// not cancelable — and the sidecar and its bots die with that session anyway.
import { BrowserWindow, dialog } from "electron"
import { nativeT } from "../native/translations"
import { SidecarCredentials } from "../service/sidecar-credentials"

/** The close must not hang on a stalled sidecar: a quick check, then ask honestly. */
const TIMEOUT_MS = 1_500

/** What the close would orphan: one snapshot's running systems and open positions. Null
 * means no sidecar credential at all — no engine to watch, nothing of ours to orphan. */
const comercioAbierto = async () => {
  const sidecar = SidecarCredentials.get()

  if (!sidecar) return null
  const authorization = SidecarCredentials.authorization(sidecar, sidecar.url)
  const { OpenCode } = await import("@opencode/client")
  const api = OpenCode.make({ baseUrl: sidecar.url, headers: authorization ? { authorization } : {} })
  const snapshot = await api.experimental.trading.snapshot({ signal: AbortSignal.timeout(TIMEOUT_MS) })

  // The gate reads the engine's whole exposure, not the shown account's: a multi-account
  // login or a watching MetaTrader 5 link must not close silently over open positions this
  // view alone never named. Their symbols deduplicate — the warning lists symbols, and the
  // same symbol can sit open in more than one account.
  const exposure = snapshot.open_positions ?? snapshot.positions
  return {
    bots: snapshot.systems.filter((system) => system.running).map((system) => system.name),
    posiciones: [...new Set(exposure.map((position) => position.symbol))],
  }
}

/** One warning, never changing its safe default: the dialog's first button closes, the
 * default (and the escape) stays Cancel. An app quit arrives with no window to parent
 * on — and sometimes one already closing — so the platform-negative branch sends the
 * message without one. */
const preguntar = async (win: BrowserWindow | undefined, message: string, detail: string) => {
  const opciones = {
    type: "warning" as const,
    message,
    detail,
    buttons: [nativeT("desktop.trading.closeWarning.action.close"), nativeT("desktop.trading.closeWarning.action.cancel")],
    defaultId: 1,
    cancelId: 1,
  }

  const { response } = win !== undefined && !win.isDestroyed() ? await dialog.showMessageBox(win, opciones) : await dialog.showMessageBox(opciones)

  return response === 0
}

/** The close verdict: cleared with nothing left exposed (now or by an absent engine) reads
 * cleared without asking; otherwise one question — and fail-closed, per the audit: an engine
 * that did not answer is "could not verify", not "nothing to warn about", because a slow
 * sidecar is exactly when the user is likeliest to believe the safest half. `preguntó` rides
 * along because only a warning the user actually answered says anything about quitting over
 * an exposure — a silent clear never saw one. */
const decidirCierre = async (win: BrowserWindow | undefined) => {
  const abierto = await comercioAbierto().catch(() => undefined)

  if (abierto === undefined)
    return {
      permitido: await preguntar(win, nativeT("desktop.trading.closeUnknown"), nativeT("desktop.trading.closeUnknown.detail")),
      preguntó: true,
    }

  if (abierto === null) return { permitido: true, preguntó: false }

  // Either exposure alone warns with its own list; both together read as one mixed warning,
  // so the user sees not just the stranded positions but that a live bot could reopen more.
  const conBots = abierto.bots.length > 0
  const conPosiciones = abierto.posiciones.length > 0

  if (!conBots && !conPosiciones) return { permitido: true, preguntó: false }
  const names = abierto.bots.join(", ")
  const symbols = abierto.posiciones.join(", ")

  const message = nativeT(
    conBots && conPosiciones
      ? "desktop.trading.closeWarning.mixed"
      : conBots
        ? "desktop.trading.closeWarning"
        : "desktop.trading.closeWarning.positions",
  )

  const detail = nativeT(
    conBots && conPosiciones
      ? "desktop.trading.closeWarning.mixed.detail"
      : conBots
        ? "desktop.trading.closeWarning.detail"
        : "desktop.trading.closeWarning.positions.detail",
    conBots && conPosiciones ? { names, symbols } : conBots ? { names } : { symbols },
  )

  return { permitido: await preguntar(win, message, detail), preguntó: true }
}

/** A window close the user just approved: good for one quit, and only when no window is left
 * to warn about — the last window's own warning is the quit's, so before-quit never asks twice
 * for the same exposure. Anything else drops a stale approval and asks. */
let cierreAprobado = false

export const consumirCierreAprobado = () => {
  const aprobado = cierreAprobado
  cierreAprobado = false
  return aprobado
}

/** Asked whenever the user closes one window of a running app. */
export const confirmTradingClose = (win: BrowserWindow) =>
  decidirCierre(win).then(({ permitido, preguntó }) => {
    // Only a warning the user answered grants the quit its pass: a silent clear — nothing
    // exposed at close time, or no engine at all — says nothing about quitting over an
    // exposure that may start afterwards, so the quit gate asks for its own then. A denial
    // also retires an earlier approval: the user's latest word about closing windows is no,
    // so the quit gate must ask again rather than ride a stale yes.
    cierreAprobado = preguntó && permitido
    return permitido
  })

/** Asked once at app quit, before the windows close — the one chance a normal quit has to warn. */
export const confirmTradingQuit = () => decidirCierre(undefined).then(({ permitido }) => permitido)
