// The trading sidebar tree's data bridge: the rendering rows most nav modules need live in
// the engine snapshot, which only the route reads. This module is the strictly shaped slice
// of that snapshot — no SDK, no engine, no menu imports — so `nav.tsx` stays light for the
// titlebar while the route owns everything: it writes the fields on every snapshot and
// registers its callbacks once at boot; the nav only reads and dispatches.
import { createStore } from "solid-js/store"

/** One system row: its dossier id (selection and toggle both dispatch it). */
export interface FilaSistemaNav {
  readonly id: string
  readonly nombre: string
  readonly enMarcha: boolean
  /** The system's day P/L — the same signed figure the section's rows carry. */
  readonly pnl_dia: number | null
  /** What it trades and on which bar ("NQ", "5m"); "?" where the pool has no entry for it. */
  readonly simbolo: string
  readonly temporalidad: string
  /** Epoch ms of the bot's newest own record row today; null until it logs. */
  readonly actividad: number | null
}

/** One account row: demo-ness rides the account's own `demo` fact when the engine names it
 * (MT5's trade mode), else the id's DU prefix (the pase 13 rule for IBKR-only engines). */
export interface FilaCuentaNav {
  readonly id: string
  readonly pnl_dia: number | null
  /** The link the account lives on ("host:port" or an MT5 identity); null when the engine predates links. */
  readonly enlace: string | null
  /** true demo, false real; undefined/null on engines predating the field (the dot falls
   * back to the id's DU prefix). */
  readonly demo?: boolean | null
}

/** One broker group (the platform family the accounts split by: IBKR, NT, MT5): each link
 * carries the broker it speaks to. The sidebar nests one collapsible group per broker. */
export interface FilaEnlaceNav {
  readonly id: string
  readonly etiqueta: string | null
  /** The link's platform family (matches the schema's Trading.Broker; older engines read ibkr). */
  readonly broker: "ibkr" | "nt" | "mt5"
  readonly conectado: boolean
}

/** One record row: the log ring and the trade record merged (the route's own union), with
 * the level and the lifecycle beat the rows tone themselves by. Close rows carry gross USD. */
export interface FilaRegistroNav {
  readonly ts: number
  readonly nivel: "info" | "aviso" | "error"
  readonly bot: string
  readonly mensaje: string
  /** The engine's i18n key for the row (`trading.log.*`); null when none (bot rows, older
   * engines, trade rows). */
  readonly clave_mensaje: string | null
  /** Interpolation values for `clave_mensaje`; null when the row carries no key or none are needed. */
  readonly params_mensaje: Record<string, string | number | boolean> | null
  /** A position lifecycle beat ("apertura"/"cierre"/"senal") or null for plain lines. */
  readonly evento: "apertura" | "cierre" | "senal" | null
  /** Gross USD for close rows; null elsewhere. */
  readonly pnl: number | null
}

interface ArbolNav {
  /** false until the route's first write — the nav renders the groups' empty row until then. */
  sincronizado: boolean
  sistemas: readonly FilaSistemaNav[]
  cuentas: readonly FilaCuentaNav[]
  enlaces: readonly FilaEnlaceNav[]
  registros: readonly FilaRegistroNav[]
  /** The dashboard's reading account ("—" while the engine has yet to name one). */
  activa: string
  /** The systems tree header's mass controls, gated the way the section's own buttons are
   * (demo pool, a write already running, or the engine stopped answering). */
  puedeArrancar: boolean
  puedeParar: boolean
  /** The primary link's connect door, gated like the header's own button (demo pool, a
   * write already running, or the engine stopped answering). */
  puedeConectar: boolean
  /** This window asked the primary link up and TWS has not accepted yet: the engine keeps
   * chasing every 5 s, but its snapshot only says "not connected". */
  conectando: boolean
  /** The folder the engine reads its systems from (null until a serving engine names it). */
  carpeta: string | null
  /** Picking the folder is open: a desktop with a folder picker, a live engine, no write
   * running and no system running (the engine refuses a switch under a live bot). */
  puedeElegirCarpeta: boolean
  /** Opens the folder picker and points the engine at the pick. */
  elegirCarpeta: () => void
  conectarPrincipal: () => void
  cambiarCuenta: (accountID: string) => void
  /** Start/stop the named system (the route maps the id onto the engine's current row). */
  conmutarSistema: (systemID: string) => void
  /** Open the system's dossier (the same ficha the systems section's rows open). */
  fichaSistema: (systemID: string) => void
  /** Mass start/stop for the whole pool (the route owns the confirmations). */
  arrancarSistemas: () => void
  pararSistemas: () => void
  /** The remove confirmation's opener — the engine refuses to drop the panel's own link. */
  quitarEnlace: (enlaceID: string) => void
  registrarEnlace: () => void
}

const [arbol, fijarArbol] = createStore<ArbolNav>({
  sincronizado: false,
  sistemas: [],
  cuentas: [],
  enlaces: [],
  registros: [],
  activa: "",
  puedeArrancar: false,
  puedeParar: false,
  puedeConectar: false,
  conectando: false,
  carpeta: null,
  puedeElegirCarpeta: false,
  elegirCarpeta: () => {},
  conectarPrincipal: () => {},
  cambiarCuenta: () => {},
  conmutarSistema: () => {},
  fichaSistema: () => {},
  arrancarSistemas: () => {},
  pararSistemas: () => {},
  quitarEnlace: () => {},
  registrarEnlace: () => {},
})

export const navArbol = arbol

export const fijarNavArbol = fijarArbol
