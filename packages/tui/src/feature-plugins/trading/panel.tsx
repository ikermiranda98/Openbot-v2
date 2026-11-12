/** @jsxImportSource @opentui/solid */
// Panel "trading" del slot session.panel + página a pantalla completa cuando
// no hay sesión abierta (fallback por router). Todo el color sale del tema
// activo del TUI: text.base/muted/faint, background.raised.*,
// text.feedback.* para resultados y text.action.primary para lo interactivo.

import { TextAttributes, type RGBA } from "@opentui/core"
import { For, Show, Switch, Match } from "solid-js"
import type { Store } from "solid-js/store"
import type { Context } from "@opencode/plugin/tui/context"
import { colorDe, formatoUSD, formatoPct, estadoMotor, horaCorta } from "./estilo"
import type { SnapshotMotor } from "./motor"

export type Pestaña = "cuenta" | "sistemas" | "posiciones" | "registro"

export const PESTAÑAS: readonly { readonly id: Pestaña; readonly nombre: string }[] = [
  { id: "cuenta", nombre: "Account" },
  { id: "sistemas", nombre: "Systems" },
  { id: "posiciones", nombre: "Positions" },
  { id: "registro", nombre: "Log" },
]

/** Controles compartidos del panel: pestaña persistente y cursor de selección. */
export interface Controles {
  readonly pestaña: Store<{ actual: Pestaña }>
  readonly fijarPestaña: (pestaña: Pestaña) => Promise<void>
  readonly cursor: Store<{ sistema: number }>
}

// ------------------------------- cabecera --------------------------------

function Cabecera(props: { context: Context; snapshot: SnapshotMotor }) {
  const estado = () => estadoMotor(props.context, props.snapshot)
  return (
    <box flexDirection="row" justifyContent="space-between" paddingLeft={2} paddingRight={1}>
      <text fg={props.context.theme.text.base} attributes={TextAttributes.BOLD}>
        TRADING DESK BOT
      </text>
      <text fg={estado().color}>{estado().texto}</text>
    </box>
  )
}

// ------------------------------- pestañas --------------------------------

function BarraPestañas(props: { context: Context; controles: Controles; activa: Pestaña }) {
  return (
    <box flexDirection="row" paddingLeft={2}>
      <For each={PESTAÑAS}>
        {(pestaña) => {
          const activa = () => props.activa === pestaña.id
          return (
            <text
              onMouseDown={() => { void props.controles.fijarPestaña(pestaña.id) }}
              fg={activa() ? props.context.theme.text.action.primary.base : props.context.theme.text.faint}
              attributes={activa() ? TextAttributes.BOLD : undefined}
            >
              {`[ ${pestaña.nombre} ] `}
            </text>
          )
        }}
      </For>
      <text fg={props.context.theme.text.faint}>alt+1..4 tabs</text>
    </box>
  )
}

// ------------------------------- pestaña: Cuenta -------------------------

function FilaCuenta(props: { context: Context; etiqueta: string; valor: string; color?: RGBA }) {
  return (
    <box flexDirection="row" paddingLeft={2}>
      <box width={22}>
        <text fg={props.context.theme.text.muted}>{props.etiqueta}</text>
      </box>
      <text fg={props.color}>{props.valor}</text>
    </box>
  )
}

function TabCuenta(props: { context: Context; snapshot: SnapshotMotor }) {
  const cuenta = () => props.snapshot.cuenta
  const activos = () => props.snapshot.bots.filter((bot) => bot.activo).length
  const color = (valor: number) => colorDe(valor, props.context.theme)
  return (
    <box flexDirection="column">
      <FilaCuenta context={props.context} etiqueta="Account" valor={cuenta().id} />
      <FilaCuenta context={props.context} etiqueta="Type" valor={cuenta().tipo} />
      <FilaCuenta context={props.context} etiqueta="Equity" valor={formatoUSD.format(cuenta().patrimonio)} />
      <FilaCuenta context={props.context} etiqueta="Cash" valor={formatoUSD.format(cuenta().efectivo)} />
      <FilaCuenta context={props.context} etiqueta="Day P/L" valor={formatoUSD.format(cuenta().pnl_dia)} color={color(cuenta().pnl_dia)} />
      <FilaCuenta
        context={props.context}
        etiqueta="Realized P/L"
        valor={formatoUSD.format(cuenta().pnl_realizado)}
        color={color(cuenta().pnl_realizado)}
      />
      <FilaCuenta context={props.context} etiqueta="Systems" valor={`${activos()} / ${props.snapshot.bots.length} running`} />
      <Show when={props.snapshot.posiciones.length > 0}>
        <box flexDirection="row" paddingLeft={2}>
          <box width={22}>
            <text fg={props.context.theme.text.muted}>Latest position</text>
          </box>
          <text fg={props.context.theme.text.base}>
            {`#${props.snapshot.posiciones.length} open · see the Positions tab`}
          </text>
        </box>
      </Show>
    </box>
  )
}

// ------------------------------ pestaña: Sistemas ------------------------

function TabSistemas(props: { context: Context; snapshot: SnapshotMotor; controles: Controles }) {
  const tema = () => props.context.theme
  return (
    <box flexDirection="column">
      <box flexDirection="row" paddingLeft={2}>
        <box width={3}><text fg={tema().text.faint}>{"  "}</text></box>
        <box width={32}><text fg={tema().text.faint} attributes={TextAttributes.BOLD}>SYSTEM</text></box>
        <box width={10}><text fg={tema().text.faint}>MARKET</text></box>
        <box width={12}><text fg={tema().text.faint}>STATE</text></box>
        <text fg={tema().text.faint} attributes={TextAttributes.BOLD}>DAY P/L</text>
      </box>
      <For each={props.snapshot.bots}>
        {(bot, índice) => {
          const seleccionado = () => props.controles.cursor.sistema === índice()
          const fondo = () => (seleccionado() ? tema().background.raised.high : undefined)
          return (
            <box
              flexDirection="row"
              paddingLeft={2}
              onMouseDown={() => { props.controles.cursor.sistema = índice() }}
              backgroundColor={fondo()}
            >
              <box width={3}>
                <text fg={seleccionado() ? tema().text.action.primary.base : tema().text.faint}>
                  {seleccionado() ? "▸ " : "  "}
                </text>
              </box>
              <box width={32}>
                <text fg={bot.activo ? tema().text.base : tema().text.muted}>{bot.nombre}</text>
              </box>
              <box width={10}>
                <text fg={tema().text.muted}>{`${bot.simbolo} ${bot.temporalidad}`}</text>
              </box>
              <box width={12}>
                <text fg={bot.activo ? tema().text.feedback.success.base : tema().text.faint}>
                  {bot.activo ? "▶ running" : "stopped"}
                </text>
              </box>
              <text fg={colorDe(bot.pnl_dia, tema())}>{formatoUSD.format(bot.pnl_dia)}</text>
            </box>
          )
        }}
      </For>
      <box paddingLeft={2}>
        <text fg={tema().text.faint}>alt+j/alt+k move · alt+s start/stop · click to select</text>
      </box>
    </box>
  )
}

// ----------------------------- pestaña: Posiciones -----------------------

function TabPosiciones(props: { context: Context; snapshot: SnapshotMotor }) {
  const tema = () => props.context.theme
  return (
    <box flexDirection="column">
      <Show
        when={props.snapshot.posiciones.length > 0}
        fallback={
          <box paddingLeft={2}>
            <text fg={tema().text.muted}>Sin posiciones abiertas</text>
          </box>
        }
      >
        <box flexDirection="row" paddingLeft={2}>
          <box width={11}><text fg={tema().text.faint} attributes={TextAttributes.BOLD}>SYMBOL</text></box>
          <box width={7}><text fg={tema().text.faint}>SIDE</text></box>
          <box width={7}><text fg={tema().text.faint}>SIZE</text></box>
          <box width={11}><text fg={tema().text.faint}>ENTRY</text></box>
          <box width={11}><text fg={tema().text.faint}>CURRENT</text></box>
          <box width={11}><text fg={tema().text.faint}>P/L</text></box>
          <text fg={tema().text.faint}>P/L %</text>
        </box>
        <For each={props.snapshot.posiciones}>
          {(posición) => (
            <box flexDirection="row" paddingLeft={2}>
              <box width={11}><text fg={tema().text.base} attributes={TextAttributes.BOLD}>{posición.simbolo}</text></box>
              <box width={7}>
                <text fg={posición.lado === "corto" ? tema().text.feedback.warning.base : tema().text.feedback.info.base}>
                  {posición.lado === "corto" ? "short" : "long"}
                </text>
              </box>
              <box width={7}><text fg={tema().text.muted}>{posición.tamano}</text></box>
              <box width={11}><text fg={tema().text.base}>{posición.entrada.toFixed(2)}</text></box>
              <box width={11}><text fg={tema().text.base}>{posición.actual.toFixed(2)}</text></box>
              <box width={11}><text fg={colorDe(posición.pnl, tema())}>{formatoUSD.format(posición.pnl)}</text></box>
              <text fg={colorDe(posición.pnl_pct, tema())}>{formatoPct.format(posición.pnl_pct / 100)}</text>
            </box>
          )}
        </For>
      </Show>
    </box>
  )
}

// ------------------------------ pestaña: Registro ------------------------

const REGISTROS_MÁXIMO = 24

function TabRegistro(props: { context: Context; snapshot: SnapshotMotor }) {
  const tema = () => props.context.theme
  const colorNivel = (nivel: string) =>
    nivel === "error" ? tema().text.feedback.error.base : nivel === "aviso" ? tema().text.feedback.warning.base : tema().text.muted
  const recientes = () => [...props.snapshot.registros].slice(-REGISTROS_MÁXIMO).reverse()
  return (
    <box flexDirection="column">
      <Show
        when={recientes().length > 0}
        fallback={
          <box paddingLeft={2}>
            <text fg={tema().text.muted}>No log entries yet · the Engine publishes activity here</text>
          </box>
        }
      >
        <For each={recientes()}>
          {(entrada) => (
            <box flexDirection="row" paddingLeft={2} paddingRight={1}>
              <box width={10}><text fg={tema().text.faint}>{horaCorta(entrada.ts)}</text></box>
              <box width={27}>
                <text fg={tema().text.muted}>{entrada.bot}</text>
              </box>
              <text fg={entrada.nivel === "info" ? tema().text.base : colorNivel(entrada.nivel)}>{entrada.mensaje}</text>
            </box>
          )}
        </For>
      </Show>
    </box>
  )
}

// ------------------------------- composición ------------------------------

export function CuerpoPanel(props: { context: Context; snapshot: SnapshotMotor; controles: Controles; ancho: number }) {
  return (
    <box flexDirection="column" gap={1} width={Math.max(40, Math.min(props.ancho, 132))}>
      <Cabecera context={props.context} snapshot={props.snapshot} />
      <BarraPestañas context={props.context} controles={props.controles} activa={props.controles.pestaña.actual} />
      <Switch>
        <Match when={props.controles.pestaña.actual === "cuenta"}>
          <TabCuenta context={props.context} snapshot={props.snapshot} />
        </Match>
        <Match when={props.controles.pestaña.actual === "sistemas"}>
          <TabSistemas context={props.context} snapshot={props.snapshot} controles={props.controles} />
        </Match>
        <Match when={props.controles.pestaña.actual === "posiciones"}>
          <TabPosiciones context={props.context} snapshot={props.snapshot} />
        </Match>
        <Match when={props.controles.pestaña.actual === "registro"}>
          <TabRegistro context={props.context} snapshot={props.snapshot} />
        </Match>
      </Switch>
    </box>
  )
}

/** Contenido del slot session.panel. */
export function PanelTrading(props: {
  context: Context
  snapshot: SnapshotMotor
  controles: Controles
  width: number
}) {
  return <CuerpoPanel context={props.context} snapshot={props.snapshot} controles={props.controles} ancho={props.width} />
}

/** Página a pantalla completa (fallback cuando no hay sesión abierta). */
export function PanelTradingPágina(props: {
  context: Context
  snapshot: SnapshotMotor
  controles: Controles
  anchoTerminal: number
}) {
  return <CuerpoPanel context={props.context} snapshot={props.snapshot} controles={props.controles} ancho={props.anchoTerminal - 4} />
}
