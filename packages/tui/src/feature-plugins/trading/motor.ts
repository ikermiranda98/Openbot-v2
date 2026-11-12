// Conexión con el motor de trading: el motor nativo vive en el servidor de OpenCode
// (grupo experimental "trading") y el plugin habla por el SDK — mismas lecturas y
// mismas escrituras que el dashboard, por el API y su flujo de permisos, no por POST
// directo a un puerto legacy (T-01). El ciclo solo LEE; arrancar/parar van por los
// endpoints nativos con la confirmación del usuario delante.
//
// Superficie de habla inglesa fija por diseño (T-03, AE-011/D-10): los textos del panel,
// comandos y pastilla se declaran en inglés —el mismo de la interfaz común del TUI— y no
// pasan por ningún i18n: el TUI no lo tiene. Las filas del motor llegan con su mensaje
// inglés del wire y la app las traduce por su clave `trading.log.*`; el panel no traduce.
// Es una decisión registrada, no una deuda. Excepción técnica (inglés por contrato): los
// mensajes de validación de la API del motor (InvalidTaskError).

import type { Context } from "@opencode/plugin/tui/context"

export type ApiMotor = Context["client"]

export interface CuentaInfo {
  readonly id: string
  readonly tipo: string
  readonly efectivo: number
  readonly patrimonio: number
  readonly pnl_dia: number
  readonly pnl_realizado: number
}

export interface BotInfo {
  readonly id: string
  readonly nombre: string
  readonly activo: boolean
  readonly simbolo: string
  readonly temporalidad: string
  readonly pnl_dia: number
}

export interface PosicionInfo {
  readonly simbolo: string
  readonly lado: "largo" | "corto"
  readonly tamano: number
  readonly entrada: number
  readonly actual: number
  readonly pnl: number
  readonly pnl_pct: number
}

export interface RegistroInfo {
  readonly ts: number
  readonly nivel: "info" | "aviso" | "error"
  readonly bot: string
  readonly mensaje: string
}

export interface SnapshotMotor {
  /** true cuando el motor responde por el API. */
  enlace: boolean
  /** true mientras solo haya datos de muestra (motor nunca leído). */
  demo: boolean
  motor: { version: string }
  cuenta: CuentaInfo
  bots: BotInfo[]
  posiciones: PosicionInfo[]
  registros: RegistroInfo[]
}

// ----------------------------- datos de muestra -----------------------------
// Pool ficticio con la misma forma que el de la app (U-11/T-03): nada aquí es
// quotable como holding real — cuenta DEMO-0000 y una posición DEMO-MNQ en un
// símbolo que ningún desk llevaría. Abre el panel hasta que el motor responda una
// primera vez, y las filas de muestra quedan sin escrituras por diseño.

export const DEMO: SnapshotMotor = {
  enlace: false,
  demo: true,
  motor: { version: "sample" },
  cuenta: {
    id: "DEMO-0000",
    tipo: "Demo (paper) · IBKR",
    efectivo: 24_870.35,
    patrimonio: 24_870.35,
    pnl_dia: -81.11,
    pnl_realizado: -124.5,
  },
  bots: [
    { id: "01", nombre: "01_nasdaq_apertura_alcista", activo: true, simbolo: "NQ", temporalidad: "5m", pnl_dia: 12.5 },
    { id: "02", nombre: "02_nasdaq_ruptura_media_hora", activo: false, simbolo: "NQ", temporalidad: "30m", pnl_dia: 0 },
    { id: "03", nombre: "03_nasdaq_impulso_con_tendencia", activo: false, simbolo: "NQ", temporalidad: "15m", pnl_dia: 0 },
    { id: "04", nombre: "04_oro_rebote_del_viernes", activo: false, simbolo: "GC", temporalidad: "30m", pnl_dia: 0 },
    { id: "05", nombre: "05_oro_fuerza_de_madrugada", activo: false, simbolo: "GC", temporalidad: "15m", pnl_dia: 0 },
    { id: "06", nombre: "06_nasdaq_pullback", activo: true, simbolo: "NQ", temporalidad: "1h", pnl_dia: -40 },
    { id: "07", nombre: "07_oro_nube_ichimoku", activo: false, simbolo: "GC", temporalidad: "1h", pnl_dia: 0 },
    { id: "08", nombre: "08_russell_estocastico_h2", activo: false, simbolo: "RTY", temporalidad: "2h", pnl_dia: 0 },
    { id: "09", nombre: "09_russell_cci_tendencia", activo: false, simbolo: "RTY", temporalidad: "1h", pnl_dia: 0 },
    { id: "10", nombre: "10_russell_estocastico_h4", activo: false, simbolo: "RTY", temporalidad: "4h", pnl_dia: 0 },
    { id: "11", nombre: "11_usdjpy_ruptura_bollinger", activo: false, simbolo: "JPY", temporalidad: "1h", pnl_dia: 0 },
    { id: "12", nombre: "12_usdjpy_ruptura_keltner", activo: false, simbolo: "JPY", temporalidad: "1h", pnl_dia: 0 },
    { id: "13", nombre: "13_usdjpy_ruptura_donchian", activo: false, simbolo: "JPY", temporalidad: "1h", pnl_dia: 0 },
    { id: "14", nombre: "14_usdjpy_cruce_ema_10_40", activo: false, simbolo: "JPY", temporalidad: "1h", pnl_dia: 0 },
    { id: "15", nombre: "15_usdjpy_precio_ema30_h3", activo: false, simbolo: "JPY", temporalidad: "3h", pnl_dia: 0 },
  ],
  posiciones: [
    { simbolo: "DEMO-MNQ", lado: "corto", tamano: 1, entrada: 25_150.75, actual: 25_191.3, pnl: -81.11, pnl_pct: -0.16 },
  ],
  registros: [],
}

DEMO.registros = [
  { ts: horaDemo(-90), nivel: "info", bot: "motor", mensaje: "Sample data · the engine has not answered yet" },
  { ts: horaDemo(-80), nivel: "info", bot: "01_nasdaq_apertura_alcista", mensaje: "Started · waiting for the Nasdaq open" },
  { ts: horaDemo(-40), nivel: "info", bot: "06_nasdaq_pullback", mensaje: "Signal found · waiting for confirmation" },
  { ts: horaDemo(-20), nivel: "aviso", bot: "10_russell_estocastico_h4", mensaje: "Markets out of session · no signals" },
  { ts: horaDemo(-1), nivel: "info", bot: "motor", mensaje: "Snapshot ready · 15 systems, 3 active" },
]

function horaDemo(minutosAtrás: number) {
  return Date.now() - minutosAtrás * 60_000
}

/** El snapshot nativo mapeado a las filas del panel: la forma del schema ya garantiza
 * los tipos (la validación vive en el server), así que aquí solo mapea y llama "—" a lo
 * que el motor aún no ha visto.
 */
type SnapshotNativo = Awaited<ReturnType<ApiMotor["experimental"]["trading"]["snapshot"]>>

/** El tipo del wire lleva las variantes raras de JSON en sus números; en la práctica el
 * runtime nunca las entrega, y el panel quiere números reales: cualquier otra cosa cae
 * al 0 de las filas con guion. */
const número = (valor: number | string | null | undefined): number => (typeof valor === "number" && Number.isFinite(valor) ? valor : 0)

function deNativo(nativo: SnapshotNativo): Omit<SnapshotMotor, "enlace" | "demo"> {
  return {
    motor: { version: nativo.version },
    cuenta: {
      id: nativo.account?.id ?? "",
      tipo: nativo.account?.type ?? "",
      efectivo: número(nativo.account?.cash),
      patrimonio: número(nativo.account?.equity),
      pnl_dia: número(nativo.account?.pnl_day),
      pnl_realizado: número(nativo.account?.pnl_realized),
    },
    bots: nativo.systems.map((sistema) => ({
      id: sistema.id,
      nombre: sistema.name,
      activo: sistema.active,
      simbolo: sistema.symbol,
      temporalidad: sistema.timeframe,
      pnl_dia: número(sistema.pnl_day),
    })),
    posiciones: nativo.positions.map((posición) => ({
      simbolo: posición.symbol,
      lado: posición.side === "short" ? "corto" : "largo",
      tamano: número(posición.size),
      entrada: número(posición.entry),
      actual: número(posición.current),
      pnl: número(posición.pnl),
      pnl_pct: número(posición.pnl_pct),
    })),
    registros: nativo.logs.map((registro) => ({
      ts: número(registro.ts),
      nivel: registro.level === "warning" ? "aviso" : registro.level === "error" ? "error" : "info",
      bot: registro.system,
      mensaje: registro.message,
    })),
  }
}

// ------------------------------ ciclo de lectura ------------------------------

export type Refrescador = () => Promise<void>

const refrescoManual: { ahora: Refrescador } = { ahora: async () => undefined }

/** Coloca el refresco manual que la UI usa tras una acción de escritura. */
export function enlazarRefresco(ahora: Refrescador) {
  refrescoManual.ahora = ahora
}

/** Refresco extra fuera del temporizador (tras arrancar/parar un bot). */
export function refrescarAhora() {
  void refrescoManual.ahora()
}

/** Pide el snapshot al motor nativo. undefined cuando no responde. */
export async function pedirSnapshot(api: ApiMotor): Promise<Omit<SnapshotMotor, "enlace" | "demo"> | undefined> {
  const respuesta = await api.experimental.trading.snapshot().catch(() => undefined)
  if (respuesta === undefined) return undefined
  return deNativo(respuesta)
}

const REFRESCO_MS = 3_000

/** Ciclo de refresco (3 s). Devuelve la parada. */
export function iniciarRefresco(api: ApiMotor, setSnapshot: (mutación: (borrador: SnapshotMotor) => void) => void): () => void {
  let huboReal = false
  const refrescar: Refrescador = async () => {
    const real = await pedirSnapshot(api)
    if (real !== undefined) {
      huboReal = true
      setSnapshot((borrador) => {
        borrador.enlace = true
        borrador.demo = false
        borrador.motor = real.motor
        borrador.cuenta = real.cuenta
        borrador.bots = real.bots
        borrador.posiciones = real.posiciones
        borrador.registros = real.registros
      })
      return
    }
    if (huboReal) setSnapshot((borrador) => { borrador.enlace = false })
  }
  refrescoManual.ahora = refrescar
  void refrescar()
  const temporizador = setInterval(() => { void refrescar() }, REFRESCO_MS)
  return () => clearInterval(temporizador)
}

// ------------------------------ ciclo de escritura ------------------------------

/** Ordena arrancar o parar un sistema por el API nativo (activate/pause), con el flujo
 * de permisos del server detrás; el comandos pide la confirmación del usuario antes. */
export async function ordenBot(api: ApiMotor, id: string, acción: "arrancar" | "parar"): Promise<boolean> {
  const respuesta =
    (acción === "arrancar"
      ? api.experimental.trading.system.activate({ systemID: id })
      : api.experimental.trading.system.pause({ systemID: id })
    ).catch(() => undefined)
  return (await respuesta) !== undefined
}
