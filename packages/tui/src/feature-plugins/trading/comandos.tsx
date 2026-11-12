/** @jsxImportSource @opentui/solid */
// Command layer ("Trading" in the palette with ctrl+p, slash /trading, /systems,
// /account…) and keybinds: ctrl+alt+t toggle, alt+1..4 tabs, alt+j/k
// selection and alt+s start/stop with confirmation. Writes always ask the
// user for confirmation before leaving the TUI.

import type { Context } from "@opencode/plugin/tui/context"
import type { SnapshotMotor } from "./motor"
import { ordenBot, refrescarAhora } from "./motor"
import { formatoUSD, estadoMotor } from "./estilo"
import { type Controles, type Pestaña } from "./panel"

const RUTA = "trading"

interface Props {
  readonly context: Context
  readonly snapshot: SnapshotMotor
  readonly controles: Controles
}

export function Comandos(props: Props) {
  const panelAbierto = () => props.context.ui.panel.current()?.name === RUTA
  const enPágina = () => {
    const actual = props.context.ui.router.current()
    return actual.type === "plugin" && actual.name === RUTA
  }
  const visible = () => panelAbierto() || enPágina()

  const abrir = (pestaña?: Pestaña) => {
    if (pestaña !== undefined) void props.controles.fijarPestaña(pestaña)
    props.context.ui.dialog.clear()
    if (props.context.ui.panel.open(RUTA)) return
    props.context.ui.router.navigate({
      type: "plugin",
      name: RUTA,
      data: { retorno: props.context.ui.router.current() },
    })
  }

  const cerrar = () => {
    if (panelAbierto()) {
      props.context.ui.panel.close()
      return
    }
    if (!enPágina()) return
    props.context.ui.router.navigate({ type: "home" })
  }

  const sistemaSeleccionado = () => props.snapshot.bots[props.controles.cursor.sistema]

  const moverCursor = (paso: number) => {
    const total = props.snapshot.bots.length
    if (total === 0) return
    props.controles.cursor.sistema = (props.controles.cursor.sistema + paso + total) % total
  }

  const alternarSistema = async () => {
    const bot = sistemaSeleccionado()
    if (bot === undefined) {
      props.context.ui.toast.show({ title: "Trading", message: "Select a system (alt+j / alt+k).", variant: "info" })
      return
    }
    if (!props.snapshot.enlace) {
      props.context.ui.toast.show({
        title: "Trading",
        message: `Engine not linked: cannot ${bot.activo ? "stop" : "start"} ${bot.nombre} now.`,
        variant: "warning",
      })
      return
    }
    const acción = bot.activo ? "parar" : "arrancar"
    const confirmó = await props.context.ui.dialog.confirm({
      title: acción === "parar" ? "Stop system" : "Start system",
      message: `${bot.nombre} · ${bot.simbolo} ${bot.temporalidad}\n${acción === "parar" ? "Stop" : "Start"} the system now on ${props.snapshot.cuenta.id}?`,
      label: { confirm: acción === "parar" ? "Stop" : "Start", cancel: "Cancel" },
    })
    if (confirmó !== true) return
    const enviado = await ordenBot(props.context.client, bot.id, acción)
    refrescarAhora()
    props.context.ui.toast.show({
      title: "Trading",
      message: enviado
        ? `${acción === "parar" ? "Stop order" : "Start order"} sent to ${bot.nombre}.`
        : `The Engine could not process the order on ${bot.nombre}.`,
      variant: enviado ? "success" : "error",
    })
  }

  const resumen = () => {
    const estado = estadoMotor(props.context, props.snapshot)
    const activos = props.snapshot.bots.filter((bot) => bot.activo).length
    props.context.ui.toast.show({
      title: estado.texto,
      message: `${props.snapshot.cuenta.id} · Day P/L ${formatoUSD.format(props.snapshot.cuenta.pnl_dia)} · systems ${activos}/${props.snapshot.bots.length} · ${props.snapshot.posiciones.length} position(s)`,
      variant: props.snapshot.enlace ? "info" : "warning",
    })
  }

  props.context.keymap.layer(() => ({
    commands: [
      {
        id: "trading.abrir",
        title: "Trading: open panel",
        description: "Account, systems, positions and log of the Desk Bot",
        group: "Trading",
        palette: true,
        suggested: () => !visible(),
        slash: { name: "trading" },
        bind: "ctrl+alt+t",
        run() { abrir() },
      },
      {
        id: "trading.cerrar",
        title: "Trading: close panel",
        group: "Trading",
        palette: true,
        bind: false,
        enabled: () => visible(),
        run() { cerrar() },
      },
      {
        id: "trading.resumen",
        title: "Trading: quick summary",
        group: "Trading",
        palette: true,
        bind: false,
        run() { resumen() },
      },
      {
        id: "trading.pestaña.cuenta",
        title: "Trading: Account tab",
        group: "Trading",
        palette: true,
        slash: { name: "account" },
        bind: "alt+1",
        enabled: () => visible(),
        run() { abrir("cuenta") },
      },
      {
        id: "trading.pestaña.sistemas",
        title: "Trading: Systems tab",
        group: "Trading",
        palette: true,
        slash: { name: "systems" },
        bind: "alt+2",
        enabled: () => visible(),
        run() { abrir("sistemas") },
      },
      {
        id: "trading.pestaña.posiciones",
        title: "Trading: Positions tab",
        group: "Trading",
        palette: true,
        bind: "alt+3",
        enabled: () => visible(),
        run() { abrir("posiciones") },
      },
      {
        id: "trading.pestaña.registro",
        title: "Trading: Log tab",
        group: "Trading",
        palette: true,
        bind: "alt+4",
        enabled: () => visible(),
        run() { abrir("registro") },
      },
      {
        id: "trading.sistema.abajo",
        title: "Systems: next selection",
        group: "Trading",
        palette: true,
        bind: "alt+k",
        enabled: () => visible() && props.controles.pestaña.actual === "sistemas",
        run() { moverCursor(1) },
      },
      {
        id: "trading.sistema.arriba",
        title: "Systems: previous selection",
        group: "Trading",
        palette: true,
        bind: "alt+j",
        enabled: () => visible() && props.controles.pestaña.actual === "sistemas",
        run() { moverCursor(-1) },
      },
      {
        id: "trading.sistema.alternar",
        title: "Systems: start/stop selected",
        group: "Trading",
        palette: true,
        slash: { name: "system" },
        bind: "alt+s",
        enabled: () => visible() && props.controles.pestaña.actual === "sistemas",
        run() { void alternarSistema() },
      },
    ],
  }))

  return null
}
