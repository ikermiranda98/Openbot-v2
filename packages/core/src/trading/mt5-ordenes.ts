// Closes on a MetaTrader 5 account: one short-lived python run per request, over the same
// MetaTrader5 package the read bridge uses. It attaches to the running terminal, checks that
// the terminal is logged in to the very account the request names (never another one), and
// closes at market every position the account holds on a symbol (the systems open them). The terminal must allow algorithmic trading ("Algo Trading" on); the run says so
// plainly when it does not.
import { Option, Schema } from "effect"
import { spawn } from "node:child_process"
import { TERMINAL_ABIERTO_PY } from "./mt5.js"

export type PeticionMT5 = { readonly accion: "cerrar"; readonly login: number; readonly server: string; readonly symbol: string }

const RespuestaMT5 = Schema.Struct({
  ok: Schema.Boolean,
  message: Schema.String,
})

export type RespuestaMT5 = Schema.Schema.Type<typeof RespuestaMT5>

const leerRespuesta = Schema.decodeUnknownOption(Schema.fromJsonString(RespuestaMT5))

/** The python side. Every answer is one JSON line {ok, message} in the user's words. */
export const ORDEN_PY = `import json, subprocess, sys

${TERMINAL_ABIERTO_PY}

def responder(ok, mensaje):
    print(json.dumps({"ok": ok, "message": mensaje}), flush=True)
    sys.exit(0)

def relleno(mt5, info):
    # The symbol's own filling policy: FOK or IOC when it allows them, else RETURN.
    modos = getattr(info, "filling_mode", 0) or 0
    if modos & 1:
        return mt5.ORDER_FILLING_FOK
    if modos & 2:
        return mt5.ORDER_FILLING_IOC
    return mt5.ORDER_FILLING_RETURN

def enviar(mt5, peticion):
    resultado = mt5.order_send(peticion)
    if resultado is None:
        codigo, texto = mt5.last_error()
        return False, "MetaTrader 5 no aceptó la orden (" + str(codigo) + ": " + str(texto) + ")"
    if resultado.retcode in (mt5.TRADE_RETCODE_DONE, mt5.TRADE_RETCODE_PLACED, mt5.TRADE_RETCODE_DONE_PARTIAL):
        return True, resultado
    if resultado.retcode == mt5.TRADE_RETCODE_CLIENT_DISABLES_AT:
        return False, "MetaTrader 5 tiene desactivado el trading algorítmico: pulsa «Algo Trading» en la barra del terminal y reintenta"
    if resultado.retcode == mt5.TRADE_RETCODE_MARKET_CLOSED:
        return False, "El mercado de " + peticion["symbol"] + " está cerrado ahora"
    if resultado.retcode == mt5.TRADE_RETCODE_NO_MONEY:
        return False, "No hay margen suficiente en la cuenta para esa orden"
    if resultado.retcode == mt5.TRADE_RETCODE_INVALID_VOLUME:
        return False, "Volumen no válido para " + peticion["symbol"]
    return False, "MetaTrader 5 rechazó la orden (" + str(resultado.retcode) + ": " + str(resultado.comment) + ")"

def main():
    pedido = json.loads(sys.argv[1])
    try:
        import MetaTrader5 as mt5
    except Exception as causa:
        responder(False, "Falta el paquete de Python MetaTrader5: " + str(causa))
    # initialize() would launch a closed terminal: a close only ever attaches to a running one.
    abierto = terminal_abierto()
    if abierto is None:
        responder(False, "No puedo comprobar si el terminal de MetaTrader 5 está abierto (falla la lista de procesos): no se envió nada")
    if not abierto:
        responder(False, "El terminal de MetaTrader 5 está cerrado: ábrelo, inicia sesión en la cuenta y reintenta. No se envió nada")
    if not mt5.initialize():
        responder(False, "El terminal de MetaTrader 5 no responde: ábrelo e inicia sesión en la cuenta")
    cuenta = mt5.account_info()
    if cuenta is None:
        responder(False, "El terminal de MetaTrader 5 no tiene ninguna cuenta con sesión iniciada")
    if cuenta.login != pedido["login"] or cuenta.server != pedido["server"]:
        responder(False, "El terminal está en la cuenta " + str(cuenta.login) + " (" + cuenta.server + "), no en la " + str(pedido["login"]) + ": no se envió nada")
    terminal = mt5.terminal_info()
    if terminal is not None and not terminal.trade_allowed:
        responder(False, "MetaTrader 5 tiene desactivado el trading algorítmico: pulsa «Algo Trading» en la barra del terminal y reintenta")
    simbolo = pedido["symbol"]
    if not mt5.symbol_select(simbolo, True):
        responder(False, "MetaTrader 5 no conoce el símbolo " + simbolo + " en esta cuenta")
    info = mt5.symbol_info(simbolo)
    if info is None:
        responder(False, "MetaTrader 5 no da información de " + simbolo)

    abiertas = mt5.positions_get(symbol=simbolo) or ()
    if len(abiertas) == 0:
        responder(True, "La posición de " + simbolo + " ya no está abierta")
    cerradas = 0
    fallos = []
    for posicion in abiertas:
        tick = mt5.symbol_info_tick(simbolo)
        larga = posicion.type == mt5.POSITION_TYPE_BUY
        ok, salida = enviar(mt5, {
            "action": mt5.TRADE_ACTION_DEAL,
            "symbol": simbolo,
            "volume": posicion.volume,
            "type": mt5.ORDER_TYPE_SELL if larga else mt5.ORDER_TYPE_BUY,
            "position": posicion.ticket,
            "price": (tick.bid if larga else tick.ask) if tick is not None else 0.0,
            "deviation": 20,
            "magic": 70910,
            "comment": "manual close",
            "type_time": mt5.ORDER_TIME_GTC,
            "type_filling": relleno(mt5, info),
        })
        if ok:
            cerradas += 1
        else:
            fallos.append(str(posicion.ticket) + ": " + salida)
    if fallos:
        responder(False, "Cerradas " + str(cerradas) + " de " + str(len(abiertas)) + " posiciones de " + simbolo + "; fallaron " + "; ".join(fallos))
    responder(True, "Cierre de " + simbolo + " ejecutado (" + str(cerradas) + " posición" + ("" if cerradas == 1 else "es") + ")")

main()
`

/** One order run, capped at 30 s; its verdict is the run's own JSON line. */
export const ordenMT5 = (ejecutable: string, peticion: PeticionMT5) =>
  new Promise<RespuestaMT5>((resolver) => {
    let salida = ""
    const child = spawn(ejecutable, ["-c", ORDEN_PY, JSON.stringify(peticion)], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    })
    const temporizador = setTimeout(() => {
      child.kill()
      resolver({ ok: false, message: "MetaTrader 5 no contestó en 30 s: revisa el terminal y el registro antes de reintentar" })
    }, 30_000)
    child.stdout?.on("data", (trozo) => {
      salida += String(trozo)
    })
    child.on("error", (error) => {
      clearTimeout(temporizador)
      resolver({ ok: false, message: `No se pudo lanzar Python para MetaTrader 5: ${String(error)}` })
    })
    child.on("close", () => {
      clearTimeout(temporizador)
      const linea = salida.trim().split(/\r?\n/).pop() ?? ""
      resolver(
        Option.getOrElse(leerRespuesta(linea), () => ({
          ok: false,
          message: "MetaTrader 5 no devolvió una respuesta legible: revisa el terminal antes de reintentar",
        })),
      )
    })
  })
