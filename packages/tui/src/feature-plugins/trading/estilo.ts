// Formato y tokens de color. Regla del plugin: SOLO tokens de tema
// (context.theme.*); así la sección hereda el aspecto del tema que elija el
// usuario en OpenCode. Nada de colores fijos.

import type { RGBA } from "@opentui/core"
import type { Context } from "@opencode/plugin/tui/context"
import type { SnapshotMotor } from "./motor"

export const formatoUSD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  currencyDisplay: "narrowSymbol",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})
export const formatoPct = new Intl.NumberFormat("en-US", {
  style: "percent",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

/** Color por resultado: verde/rojo del tema, gris neutro cuando es plano. */
export function colorDe(valor: number, tema: Context["theme"]): RGBA {
  if (valor > 0.005) return tema.text.feedback.success.base
  if (valor < -0.005) return tema.text.feedback.error.base
  return tema.text.muted
}

/** Estado del enlace con el Motor: color y texto para pill y cabecera. */
export function estadoMotor(contexto: Context, snapshot: SnapshotMotor) {
  if (snapshot.enlace) return { color: contexto.theme.text.feedback.success.base, texto: `Engine ${snapshot.motor.version} · linked` }
  if (snapshot.demo) return { color: contexto.theme.text.feedback.error.base, texto: "Engine offline · sample data" }
  return { color: contexto.theme.text.feedback.error.base, texto: "Engine offline · last data" }
}

/** HH:MM:SS para el registro. */
export function horaCorta(ts: number) {
  return new Date(ts).toLocaleTimeString("en-US", { hour12: false })
}
