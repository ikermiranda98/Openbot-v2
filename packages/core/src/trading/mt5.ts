// The MetaTrader 5 side of the trading engine: this computer's terminal folders (where
// every install keeps its own account records) and the sidecar Python bridge an MT5 link
// reads over. All of it is read-only bookkeeping around the terminal — nothing here ever
// touches a position.
import { Option, Schema } from "effect"
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { join } from "node:path"
import { readdir, readFile } from "node:fs/promises"

/**
 * One MetaTrader 5 account this computer's own records name. `active` marks the terminal
 * folder's last-session login (its most natural pick in the wizard's list).
 */
export interface DatoDisco {
  readonly login: number
  readonly server: string
  readonly active: boolean
}

/** One account the live terminal answered for (the probe's verdict). */
export interface DatoVivo {
  readonly login: number
  readonly server: string
  readonly name: string | null
}

/** The MetaTrader 5 package's trade codes: 0 demo, 1 contest, 2 real-money. */
export const MODO_MT5 = ["demo", "contest", "real"]

/**
 * One bridge line: the account's own facts (`cuenta`) or the reason the read found
 * nothing worth reading yet (`estado`). Every number arrives finite — the python side
 * sanitizes what would break downstream renders.
 */
/** One open MT5 position as the bridge reports it (prices and P/L in the account's terms). */
const PosicionPuenteMT5 = Schema.Struct({
  symbol: Schema.String,
  side: Schema.Literals(["long", "short"]),
  size: Schema.NullOr(Schema.Number),
  entry: Schema.NullOr(Schema.Number),
  current: Schema.NullOr(Schema.Number),
  pnl: Schema.NullOr(Schema.Number),
})

/** One deal that closed (part of) a position today; `ts` already reads as UTC epoch ms. */
const CierrePuenteMT5 = Schema.Struct({
  symbol: Schema.String,
  ts: Schema.Number,
  volume: Schema.NullOr(Schema.Number),
  price: Schema.NullOr(Schema.Number),
  pnl: Schema.NullOr(Schema.Number),
})

export const LineaPuenteMT5 = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("cuenta"),
    login: Schema.Number,
    name: Schema.NullOr(Schema.String),
    server: Schema.String,
    trade_mode: Schema.Number,
    balance: Schema.NullOr(Schema.Number),
    equity: Schema.NullOr(Schema.Number),
    profit: Schema.NullOr(Schema.Number),
    margin_free: Schema.NullOr(Schema.Number),
    margin_used: Schema.NullOr(Schema.Number),
    pnl_day: Schema.NullOr(Schema.Number),
    // The richer read (a bridge from before it simply omits these): today's realized P/L,
    // the open positions and today's closing deals.
    pnl_realized: Schema.optional(Schema.NullOr(Schema.Number)),
    positions: Schema.optional(Schema.Array(PosicionPuenteMT5)),
    closes: Schema.optional(Schema.Array(CierrePuenteMT5)),
  }),
  Schema.Struct({
    type: Schema.Literal("estado"),
    conectado: Schema.Literal(false),
    motivo: Schema.String,
  }),
  // The bots' side: the full book of the terminal the translator reads (every time UTC ms).
  Schema.Struct({
    type: Schema.Literal("bot"),
    login: Schema.Number,
    server: Schema.String,
    demo: Schema.Boolean,
    currency: Schema.String,
    leverage: Schema.Number,
    balance: Schema.NullOr(Schema.Number),
    equity: Schema.NullOr(Schema.Number),
    margin: Schema.NullOr(Schema.Number),
    margin_free: Schema.NullOr(Schema.Number),
    profit: Schema.NullOr(Schema.Number),
    positions: Schema.Array(
      Schema.Struct({
        ticket: Schema.Number,
        symbol: Schema.String,
        side: Schema.Literals(["long", "short"]),
        volume: Schema.Number,
        entry: Schema.Number,
        current: Schema.Number,
        sl: Schema.Number,
        tp: Schema.Number,
        magic: Schema.Number,
        time: Schema.Number,
      }),
    ),
    orders: Schema.Array(
      Schema.Struct({
        ticket: Schema.Number,
        symbol: Schema.String,
        kind: Schema.String,
        volume: Schema.Number,
        price: Schema.Number,
        magic: Schema.Number,
      }),
    ),
    deals: Schema.optional(
      Schema.Array(
        Schema.Struct({
          deal: Schema.Number,
          order: Schema.Number,
          position: Schema.Number,
          symbol: Schema.String,
          side: Schema.Literals(["long", "short"]),
          volume: Schema.Number,
          price: Schema.Number,
          pnl: Schema.Number,
          magic: Schema.Number,
          time: Schema.Number,
          entry: Schema.String,
          reason: Schema.String,
        }),
      ),
    ),
  }),
  // One command's answer, matched by its id.
  Schema.Struct({
    type: Schema.Literal("resultado"),
    id: Schema.String,
    ok: Schema.Boolean,
    retcode: Schema.Number,
    message: Schema.String,
    data: Schema.Unknown,
  }),
])

/** The bridge's bot-side book, as the translator reads it. */
export type LibroMT5 = Extract<LineaPuenteMT5, { type: "bot" }>
export type ResultadoMT5 = Omit<Extract<LineaPuenteMT5, { type: "resultado" }>, "type" | "id">
export type LineaPuenteMT5 = Schema.Schema.Type<typeof LineaPuenteMT5>

/** A bridge line's verdict straight from its JSON text: None when the line says nothing
 * this engine understands (a crashed sidecar's leftovers, an interpreter's babble). */
export const leerPuente = Schema.decodeUnknownOption(Schema.fromJsonString(LineaPuenteMT5))

/** The MetaQuotes umbrella: one subfolder per install beside `Common` and friends. */
export const carpetaMetaQuotes = (appdata: string) => join(appdata, "MetaQuotes", "Terminal")

/** MT5 keeps its own files UTF-16LE (the folder's ini and logs do); a BOM-less ANSI file
 * still decodes through utf8's ASCII-safe core. Null for a file the terminal holds or one
 * that does not exist — records half-read are worse than none. */
const textoDeArchivo = async (ruta: string): Promise<string | null> => {
  const datos = await readFile(ruta).catch(() => null)
  if (datos === null) return null
  if (datos.length >= 2 && datos[0] === 0xff && datos[1] === 0xfe) return datos.toString("utf16le", 2)
  return datos.toString("utf8")
}

/** `'5058203356': authorized on MetaQuotes-Demo through Access Point 32` — a login the
 * terminal actually connected as. Every full row needs login AND server named right after. */
const AUTORIZACION = /'(\d+)':\s*authorized on (\S+) through/g

/** `new demo account '5058203356' opened on MetaQuotes-Demo` — an account born in this
 * terminal (demo or real; the word between is optional). */
const APERTURA = /new (?:\S+ )?account '(\d+)' opened on (\S+)/g

/** One terminal folder's known accounts: the config's last-session login (the terminal's
 * own memory, marked `active`) plus each login named in its recent logs. Unreadable files
 * contribute nothing and never break the rest. */
const leerTerminal = async (carpeta: string): Promise<readonly DatoDisco[]> => {
  const filas: DatoDisco[] = []
  const ini = await textoDeArchivo(join(carpeta, "config", "common.ini"))
  if (ini !== null) {
    // The `[Common]` rows name the folder's last login; the terminal rewrites them on
    // every login, so anything else in the file is a section the regex never enters.
    const login = /^Login=(\d+)/m.exec(ini)
    const servidor = /^Server=(.*\S)/m.exec(ini)
    if (login !== null && servidor !== null)
      filas.push({ login: Number(login[1]), server: servidor[1], active: true })
  }
  const registros = await readdir(join(carpeta, "logs"), { withFileTypes: true }).catch(() => [])
  const nombres = registros
    .filter((registro) => registro.isFile() && /^\d{8}\.log$/.test(registro.name))
    .map((registro) => registro.name)
    .sort((a, b) => (a < b ? 1 : -1))
    .slice(0, 7)
  const vistas = new Set(filas.map((fila) => `${fila.login}@${fila.server}`))
  for (const nombre of nombres) {
    const texto = await textoDeArchivo(join(carpeta, "logs", nombre))
    if (texto === null) continue
    for (const autorizada of texto.matchAll(AUTORIZACION)) {
      const clave = `${autorizada[1]}@${autorizada[2]}`
      if (vistas.has(clave)) continue
      vistas.add(clave)
      filas.push({ login: Number(autorizada[1]), server: autorizada[2], active: false })
    }
    for (const abierta of texto.matchAll(APERTURA)) {
      const clave = `${abierta[1]}@${abierta[2]}`
      if (vistas.has(clave)) continue
      vistas.add(clave)
      filas.push({ login: Number(abierta[1]), server: abierta[2], active: false })
    }
  }
  return filas
}

/** Every MetaTrader 5 account this computer's install folders have on record: one subfolder
 * per terminal install (their 32-hex names; the umbrella's `Common`-family folders never
 * match), each contributing its config row and its logins' history. A computer without
 * MetaTrader 5 finds an empty list — the read-only scan opens nothing. */
export const leerCuentasDisco = async (raiz: string): Promise<readonly DatoDisco[]> => {
  const carpetas = await readdir(raiz, { withFileTypes: true }).catch(() => [])
  const terminales = carpetas
    .filter((carpeta) => carpeta.isDirectory() && /^[0-9A-F]{32}$/.test(carpeta.name))
    .map((carpeta) => leerTerminal(join(raiz, carpeta.name)))
  return (await Promise.all(terminales)).flat()
}

/**
 * Python shared by the read bridge and the close run: whether a MetaTrader 5 terminal is
 * running, from the process list. `mt5.initialize()` launches a closed terminal, and the app
 * never opens MT5 on its own, so neither script attaches unless this says True: when the
 * process list cannot be read at all (tasklist missing, blocked or failing) it answers None
 * — unknown — and the caller stays away instead of assuming the terminal is open.
 */
export const TERMINAL_ABIERTO_PY = `def terminal_abierto():
    try:
        hecho = subprocess.run(["tasklist", "/FI", "IMAGENAME eq terminal64.exe", "/NH"], capture_output=True, text=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except Exception:
        return None
    if hecho.returncode != 0:
        return None
    return "terminal64.exe" in hecho.stdout.lower()`

/**
 * The sidecar's source, handed to python as `-c` (no script file on disk). It attaches to
 * the terminal, reads the account, its open positions and today's deals, and prints JSON
 * lines. Every float goes through `n()` so no NaN or Infinity can reach the wire.
 *
 * MT5 stamps deals in the trade server's clock, written as if it were UTC (MetaQuotes-Demo
 * runs two hours ahead of a Madrid PC in winter). The bridge reads that offset off the
 * freshest tick it can see — a 24/7 symbol keeps it honest over weekends — rounded to the
 * half hour, and uses it twice: to ask for "today" as the PC's own day, and to hand every
 * time back as real UTC. The day P/L is today's realized deals plus the floating part.
 *
 * `--probe` prints its verdict (a retry after 5 s catches a terminal still booting or still
 * logging in) and exits; it may launch a closed terminal, which is why it only runs behind
 * the wizard's own button. The link-feed mode never launches one: it attaches only while a
 * terminal is running, attaches again when one comes back after being closed, and loops the
 * read every 5 s.
 */
export const PUENTE_PY = String.raw`import datetime, json, math, os, queue, subprocess, sys, threading, time

ARGS = sys.argv[1:]
PROBE = "--probe" in ARGS
RELOJ = ("BTCUSD", "EURUSD", "XAUUSD")

def argumento(nombre):
    if nombre in ARGS:
        i = ARGS.index(nombre)
        if i + 1 < len(ARGS):
            return ARGS[i + 1]
    return None

# The link's own account: trading commands only run while the terminal is logged in to it.
LOGIN = argumento("--login")
SERVIDOR = argumento("--server")
FICHERO_DESFASE = argumento("--desfase")
SALIDA = threading.Lock()

def emitir(objeto):
    texto = json.dumps(objeto, ensure_ascii=True, separators=(",", ":"))
    with SALIDA:
        sys.stdout.write(texto + "\n")
        sys.stdout.flush()

def n(valor):
    try:
        f = float(valor)
    except Exception:
        return None
    return f if math.isfinite(f) else None

def estado(motivo):
    emitir({"type": "estado", "conectado": False, "motivo": motivo})

` + TERMINAL_ABIERTO_PY + String.raw`

def desfase(mt5, simbolos):
    ultimo = 0
    for simbolo in simbolos:
        try:
            tick = mt5.symbol_info_tick(simbolo)
        except Exception:
            tick = None
        if tick is not None and tick.time > ultimo:
            ultimo = tick.time
    if ultimo == 0:
        return 0
    bruto = ultimo - time.time()
    if abs(bruto) > 15 * 3600:
        return 0
    return int(round(bruto / 1800.0) * 1800)

class Reloj:
    """Broker server time minus UTC, in seconds. A fresh tick (within two minutes of a
    quarter-hour step) states it; otherwise the last known one stays, remembered on disk
    so a weekend (no fresh ticks anywhere) still reads the right hours."""

    def __init__(self):
        self.offset = None
        self.revisado = 0.0
        if FICHERO_DESFASE:
            try:
                with open(FICHERO_DESFASE, encoding="utf-8") as fh:
                    self.offset = int(json.load(fh).get("offset", 0))
            except Exception:
                pass

    def valor(self, mt5, simbolos):
        ahora = time.time()
        if self.offset is not None and ahora - self.revisado < 30:
            return self.offset
        self.revisado = ahora
        nombres = list(simbolos) + list(RELOJ)
        try:
            for s in mt5.symbols_get() or ():
                if getattr(s, "visible", False):
                    nombres.append(s.name)
        except Exception:
            pass
        vistos = set()
        mejor = None
        for nombre in nombres:
            if nombre in vistos or len(vistos) > 40:
                continue
            vistos.add(nombre)
            try:
                tick = mt5.symbol_info_tick(nombre)
            except Exception:
                tick = None
            if tick is None or not tick.time:
                continue
            bruto = tick.time - ahora
            redondo = round(bruto / 900.0) * 900
            if abs(bruto - redondo) < 120 and abs(redondo) <= 15 * 3600:
                mejor = int(redondo)
                break
        if mejor is None:
            if self.offset is None:
                self.offset = desfase(mt5, simbolos)
            return self.offset
        if mejor != self.offset and FICHERO_DESFASE:
            try:
                os.makedirs(os.path.dirname(FICHERO_DESFASE), exist_ok=True)
                with open(FICHERO_DESFASE, "w", encoding="utf-8") as fh:
                    json.dump({"offset": mejor}, fh)
            except Exception:
                pass
        self.offset = mejor
        return mejor

RELOJ_SERVIDOR = Reloj()

def linea(mt5, iniciar):
    if iniciar and not mt5.initialize():
        return "el terminal de MetaTrader 5 no responde"
    cuenta = mt5.account_info()
    if cuenta is None:
        return "el terminal no est\u00e1 conectado a una cuenta"
    abiertas = mt5.positions_get() or ()
    off = RELOJ_SERVIDOR.valor(mt5, [p.symbol for p in abiertas])
    medianoche = datetime.datetime.combine(datetime.date.today(), datetime.time.min).timestamp()
    realizado = None
    cierres = []
    try:
        deals = mt5.history_deals_get(int(medianoche + off), int(time.time() + off + 3600))
        if deals is not None:
            realizado = 0.0
            for d in deals:
                # Only trade deals count: deposits and corrections ride their own deal
                # types and would book the initial deposit as the day's P/L.
                if d.type not in (mt5.DEAL_TYPE_BUY, mt5.DEAL_TYPE_SELL):
                    continue
                total = d.profit + d.commission + d.swap
                realizado += total
                if d.entry in (mt5.DEAL_ENTRY_OUT, mt5.DEAL_ENTRY_INOUT, mt5.DEAL_ENTRY_OUT_BY):
                    cierres.append({"symbol": d.symbol, "ts": int((d.time - off) * 1000), "volume": n(d.volume), "price": n(d.price), "pnl": n(total)})
    except Exception:
        realizado = None
    realizado = n(realizado)
    flotante = n(cuenta.profit)
    pnl = realizado
    if realizado is None:
        pnl = flotante
    elif flotante is not None:
        pnl = realizado + flotante
    posiciones = [{
        "symbol": p.symbol,
        "side": "long" if p.type == mt5.POSITION_TYPE_BUY else "short",
        "size": n(p.volume),
        "entry": n(p.price_open),
        "current": n(p.price_current),
        "pnl": n(p.profit + p.swap),
    } for p in abiertas]
    emitir({
        "type": "cuenta",
        "login": cuenta.login,
        "name": cuenta.name,
        "server": cuenta.server,
        "trade_mode": cuenta.trade_mode,
        "balance": n(cuenta.balance),
        "equity": n(cuenta.equity),
        "profit": flotante,
        "margin_free": n(cuenta.margin_free),
        "margin_used": n(cuenta.margin),
        "pnl_day": pnl,
        "pnl_realized": realizado,
        "positions": posiciones,
        "closes": cierres,
    })

def ciclo(mt5, iniciar):
    motivo = linea(mt5, iniciar)
    if motivo is not None:
        estado(motivo)
        return False
    return True

# ----------------------------------------------------------------------------- the bots' side
# The bots' orders (OpenBot's ib_async stand-in) arrive here as one JSON line per command on
# stdin: {"id", "verb", "arg"}; each one is answered with a "resultado" line. Verbs and
# arguments are those of the DeepTrading bridge protocol:
#   SYMBOL name, RATES symbol;tf;fromUtc;toUtc, DEAL symbol;buy|sell;volume;magic;comment,
#   PENDING symbol;buy|sell;stop|limit;volume;price;magic;comment;day,
#   CLOSEVOL ticket;volume, SLTP ticket;sl;tp, DELETE ticket
# Besides, a "bot" line carries the account, every position (ticket, magic, SL, TP), the
# pending orders and three days of deals (order, entry, reason) for the engine's translator.

OK_ORDEN = (10008, 10009, 10010)  # placed, done, done partial
DESVIO = 20
COLA = queue.Queue()
ORDENES = ("DEAL", "PENDING", "CLOSEVOL", "SLTP", "DELETE")

def leer_entrada():
    for texto in sys.stdin:
        texto = texto.strip().lstrip("﻿")
        if texto:
            COLA.put(texto)

def respuesta(cid, ok, retcode, mensaje, datos=None):
    return {"type": "resultado", "id": cid, "ok": bool(ok), "retcode": int(retcode), "message": str(mensaje), "data": datos}

def relleno(mt5, simbolo):
    info = mt5.symbol_info(simbolo)
    modos = getattr(info, "filling_mode", 0) or 0
    if modos & 1:
        return mt5.ORDER_FILLING_FOK
    if modos & 2:
        return mt5.ORDER_FILLING_IOC
    return mt5.ORDER_FILLING_RETURN

def mandar(mt5, peticion):
    hecho = mt5.order_send(peticion)
    if hecho is None:
        codigo, texto = mt5.last_error()
        return False, int(codigo), str(texto), None
    return hecho.retcode in OK_ORDEN, int(hecho.retcode), str(hecho.comment), hecho

MARCOS = {}

def marco(mt5, nombre):
    if not MARCOS:
        for clave in ("M1", "M2", "M3", "M5", "M10", "M15", "M20", "M30", "H1", "H2", "H3", "H4", "H6", "H8", "H12", "D1", "W1"):
            valor = getattr(mt5, "TIMEFRAME_" + clave, None)
            if valor is not None:
                MARCOS[clave] = valor
    return MARCOS.get(nombre)

def ejecutar(mt5, verbo, cid, arg):
    a = arg.split(";")
    off = RELOJ_SERVIDOR.valor(mt5, [])
    if verbo in ORDENES:
        cuenta = mt5.account_info()
        if cuenta is None:
            return respuesta(cid, False, -1, "el terminal no est\u00e1 conectado a una cuenta")
        if LOGIN is None or str(cuenta.login) != LOGIN or (SERVIDOR is not None and cuenta.server != SERVIDOR):
            return respuesta(cid, False, -3, "el terminal est\u00e1 en la cuenta " + str(cuenta.login) + " (" + str(cuenta.server) + "), no en la del enlace: no se envi\u00f3 nada")
        terminal = mt5.terminal_info()
        if terminal is not None and not terminal.trade_allowed:
            return respuesta(cid, False, -10, "MetaTrader 5 tiene desactivado el trading algor\u00edtmico (bot\u00f3n Algo Trading)")

    if verbo == "SYMBOL":
        if not mt5.symbol_select(arg, True):
            return respuesta(cid, False, 4301, "no existe el s\u00edmbolo " + arg)
        s = mt5.symbol_info(arg)
        if s is None:
            return respuesta(cid, False, 4301, "no existe el s\u00edmbolo " + arg)
        return respuesta(cid, True, 0, "", {"symbol": s.name, "digits": s.digits, "contract_size": n(s.trade_contract_size),
                                           "tick_size": n(s.trade_tick_size), "tick_value": n(s.trade_tick_value),
                                           "volume_min": n(s.volume_min), "volume_step": n(s.volume_step), "volume_max": n(s.volume_max),
                                           "currency_profit": s.currency_profit, "bid": n(s.bid), "ask": n(s.ask)})

    if verbo == "RATES":
        if len(a) < 4:
            return respuesta(cid, False, -1, "RATES necesita s\u00edmbolo;tf;desde;hasta")
        tf = marco(mt5, a[1])
        if tf is None:
            return respuesta(cid, False, -1, "temporalidad no soportada: " + a[1])
        mt5.symbol_select(a[0], True)
        desde, hasta = int(float(a[2])) + off, int(float(a[3])) + off
        velas = mt5.copy_rates_range(a[0], tf, desde, hasta)
        if velas is None:
            codigo, texto = mt5.last_error()
            return respuesta(cid, False, int(codigo), "MT5 no devolvi\u00f3 velas de " + a[0] + " (" + str(texto) + ")", [])
        filas = [[(int(r["time"]) - off) * 1000, float(r["open"]), float(r["high"]), float(r["low"]), float(r["close"]),
                  int(r["tick_volume"])] for r in velas]
        return respuesta(cid, True, 0, "", filas)

    if verbo == "DEAL":
        if len(a) < 5:
            return respuesta(cid, False, -1, "DEAL necesita s\u00edmbolo;lado;volumen;magic;comentario")
        simbolo, compra = a[0], a[1] == "buy"
        mt5.symbol_select(simbolo, True)
        tick = mt5.symbol_info_tick(simbolo)
        if tick is None:
            return respuesta(cid, False, 10021, "sin precios de " + simbolo)
        ok, codigo, texto, hecho = mandar(mt5, {"action": mt5.TRADE_ACTION_DEAL, "symbol": simbolo, "volume": float(a[2]),
                                                "type": mt5.ORDER_TYPE_BUY if compra else mt5.ORDER_TYPE_SELL,
                                                "price": tick.ask if compra else tick.bid, "deviation": DESVIO, "magic": int(a[3]),
                                                "comment": a[4][:31], "type_time": mt5.ORDER_TIME_GTC, "type_filling": relleno(mt5, simbolo)})
        return respuesta(cid, ok, codigo, texto, {"order": hecho.order if hecho else 0, "deal": hecho.deal if hecho else 0,
                                                  "price": n(hecho.price) if hecho else 0.0, "volume": n(hecho.volume) if hecho else 0.0})

    if verbo == "PENDING":
        if len(a) < 8:
            return respuesta(cid, False, -1, "PENDING necesita 8 campos")
        simbolo, compra, stop = a[0], a[1] == "buy", a[2] == "stop"
        tipo = (mt5.ORDER_TYPE_BUY_STOP if compra else mt5.ORDER_TYPE_SELL_STOP) if stop else \
            (mt5.ORDER_TYPE_BUY_LIMIT if compra else mt5.ORDER_TYPE_SELL_LIMIT)
        mt5.symbol_select(simbolo, True)
        ok, codigo, texto, hecho = mandar(mt5, {"action": mt5.TRADE_ACTION_PENDING, "symbol": simbolo, "volume": float(a[3]), "type": tipo,
                                                "price": float(a[4]), "magic": int(a[5]), "comment": a[6][:31],
                                                "type_time": mt5.ORDER_TIME_DAY if a[7] == "1" else mt5.ORDER_TIME_GTC,
                                                "type_filling": mt5.ORDER_FILLING_RETURN})
        return respuesta(cid, ok, codigo, texto, {"order": hecho.order if hecho else 0})

    if verbo == "CLOSEVOL":
        ticket = int(a[0])
        halladas = mt5.positions_get(ticket=ticket)
        if not halladas:
            return respuesta(cid, False, 10036, "la posici\u00f3n ya no est\u00e1 abierta")
        p = halladas[0]
        volumen = p.volume if len(a) < 2 else min(float(a[1]), p.volume)
        tick = mt5.symbol_info_tick(p.symbol)
        if tick is None:
            return respuesta(cid, False, 10021, "sin precios de " + p.symbol)
        vende = p.type == mt5.POSITION_TYPE_BUY
        ok, codigo, texto, hecho = mandar(mt5, {"action": mt5.TRADE_ACTION_DEAL, "symbol": p.symbol, "volume": volumen, "position": ticket,
                                                "type": mt5.ORDER_TYPE_SELL if vende else mt5.ORDER_TYPE_BUY,
                                                "price": tick.bid if vende else tick.ask, "deviation": DESVIO, "magic": p.magic,
                                                "type_time": mt5.ORDER_TIME_GTC, "type_filling": relleno(mt5, p.symbol)})
        return respuesta(cid, ok, codigo, texto, {"deal": hecho.deal if hecho else 0, "price": n(hecho.price) if hecho else 0.0,
                                                  "volume": n(hecho.volume) if hecho else 0.0})

    if verbo == "SLTP":
        if len(a) < 3:
            return respuesta(cid, False, -1, "SLTP necesita ticket;sl;tp")
        ticket = int(a[0])
        halladas = mt5.positions_get(ticket=ticket)
        if not halladas:
            return respuesta(cid, False, 10036, "la posici\u00f3n ya no est\u00e1 abierta")
        ok, codigo, texto, _ = mandar(mt5, {"action": mt5.TRADE_ACTION_SLTP, "symbol": halladas[0].symbol, "position": ticket,
                                            "sl": float(a[1]), "tp": float(a[2])})
        return respuesta(cid, ok, codigo, texto)

    if verbo == "DELETE":
        ticket = int(arg)
        if not mt5.orders_get(ticket=ticket):
            return respuesta(cid, False, 10036, "la orden ya no est\u00e1 pendiente")
        ok, codigo, texto, _ = mandar(mt5, {"action": mt5.TRADE_ACTION_REMOVE, "order": ticket})
        return respuesta(cid, ok, codigo, texto)

    return respuesta(cid, False, -1, "orden desconocida: " + verbo)

TIPOS_PENDIENTE = {}
FIRMA = {"libro": None}

def linea_bots(mt5, con_operaciones):
    cuenta = mt5.account_info()
    if cuenta is None:
        return
    if not TIPOS_PENDIENTE:
        TIPOS_PENDIENTE.update({mt5.ORDER_TYPE_BUY_STOP: "buy_stop", mt5.ORDER_TYPE_SELL_STOP: "sell_stop",
                                mt5.ORDER_TYPE_BUY_LIMIT: "buy_limit", mt5.ORDER_TYPE_SELL_LIMIT: "sell_limit"})
    abiertas = mt5.positions_get() or ()
    off = RELOJ_SERVIDOR.valor(mt5, [p.symbol for p in abiertas])
    posiciones = [{"ticket": p.ticket, "symbol": p.symbol, "side": "short" if p.type == mt5.POSITION_TYPE_SELL else "long",
                   "volume": n(p.volume) or 0.0, "entry": n(p.price_open) or 0.0, "current": n(p.price_current) or 0.0,
                   "sl": n(p.sl) or 0.0, "tp": n(p.tp) or 0.0, "magic": int(p.magic), "time": int(p.time_msc) - off * 1000}
                  for p in abiertas]
    pendientes = [{"ticket": o.ticket, "symbol": o.symbol, "kind": TIPOS_PENDIENTE.get(o.type, "other"),
                   "volume": n(o.volume_current) or 0.0, "price": n(o.price_open) or 0.0, "magic": int(o.magic)}
                  for o in (mt5.orders_get() or ())]
    salida = {"type": "bot", "login": cuenta.login, "server": cuenta.server, "demo": cuenta.trade_mode != 2,
              "currency": cuenta.currency, "leverage": int(cuenta.leverage or 0), "balance": n(cuenta.balance),
              "equity": n(cuenta.equity), "margin": n(cuenta.margin), "margin_free": n(cuenta.margin_free),
              "profit": n(cuenta.profit), "positions": posiciones, "orders": pendientes}
    # A position or pending order that comes or goes rides with the deals that explain it, so
    # the translator never sees a stop's position gone before the stop's own deal.
    firma = (tuple(sorted(p["ticket"] for p in posiciones)), tuple(sorted(o["ticket"] for o in pendientes)))
    if firma != FIRMA["libro"]:
        FIRMA["libro"] = firma
        con_operaciones = True
    if con_operaciones:
        ahora = time.time() + off
        inicio = ahora - ahora % 86400 - 3 * 86400
        entradas = {mt5.DEAL_ENTRY_IN: "in", mt5.DEAL_ENTRY_OUT: "out", mt5.DEAL_ENTRY_INOUT: "inout"}
        motivos = {mt5.DEAL_REASON_SL: "sl", mt5.DEAL_REASON_TP: "tp", mt5.DEAL_REASON_SO: "so"}
        operaciones = []
        for d in mt5.history_deals_get(int(inicio), int(ahora + 86400)) or ():
            if d.type not in (mt5.DEAL_TYPE_BUY, mt5.DEAL_TYPE_SELL):
                continue
            operaciones.append({"deal": d.ticket, "order": d.order, "position": d.position_id, "symbol": d.symbol,
                                "side": "short" if d.type == mt5.DEAL_TYPE_SELL else "long", "volume": n(d.volume) or 0.0,
                                "price": n(d.price) or 0.0, "pnl": n(d.profit + d.commission + d.swap) or 0.0, "magic": int(d.magic),
                                "time": int(d.time_msc) - off * 1000, "entry": entradas.get(d.entry, "out_by"),
                                "reason": motivos.get(d.reason, "other")})
        salida["deals"] = operaciones
    emitir(salida)

def atender(mt5, enganchado):
    hubo = False
    while True:
        try:
            texto = COLA.get_nowait()
        except queue.Empty:
            return hubo
        try:
            pedido = json.loads(texto)
            cid = str(pedido.get("id", ""))
            verbo = str(pedido.get("verb", ""))
            arg = str(pedido.get("arg", ""))
        except Exception:
            continue
        if not enganchado:
            emitir(respuesta(cid, False, -1, "el terminal de MetaTrader 5 no est\u00e1 enganchado"))
            continue
        try:
            emitir(ejecutar(mt5, verbo, cid, arg))
        except Exception as causa:
            emitir(respuesta(cid, False, -1, "error del puente: " + str(causa)))
        hubo = hubo or verbo in ORDENES

def vigilar():
    try:
        import MetaTrader5 as mt5
    except Exception as causa:
        estado("falta el paquete de Python MetaTrader5: " + str(causa))
        return
    if PROBE:
        ciclo(mt5, True)
        time.sleep(5)
        ciclo(mt5, True)
        return
    # A stand-in package for tests (no terminal process to look for) says so itself.
    falso = bool(getattr(mt5, "__openbot_falso__", False))
    threading.Thread(target=leer_entrada, daemon=True).start()
    enganchado = False
    ultimo_intento = ultima_cuenta = ultima_bot = ultimas_ops = -1e9
    while True:
        ahora = time.monotonic()
        if not enganchado and ahora - ultimo_intento >= 5:
            ultimo_intento = ahora
            abierto = True if falso else terminal_abierto()
            if abierto is None:
                estado("no puedo comprobar si el terminal de MetaTrader 5 est\u00e1 abierto (falla la lista de procesos): no me engancho para no abrirlo")
            elif not abierto:
                estado("el terminal de MetaTrader 5 est\u00e1 cerrado")
            else:
                enganchado = ciclo(mt5, True)
                ultima_cuenta = ahora
                if not enganchado:
                    try:
                        mt5.shutdown()
                    except Exception:
                        pass
        if atender(mt5, enganchado):
            ultima_bot = ultimas_ops = -1e9  # report a command's effect right away
        if enganchado:
            try:
                if ahora - ultima_cuenta >= 5:
                    ultima_cuenta = ahora
                    enganchado = ciclo(mt5, False)
                if enganchado and LOGIN is not None and ahora - ultima_bot >= 0.5:
                    ultima_bot = ahora
                    operaciones = ahora - ultimas_ops >= 2
                    if operaciones:
                        ultimas_ops = ahora
                    linea_bots(mt5, operaciones)
            except Exception as causa:
                estado("lectura fallida: " + str(causa))
                enganchado = False
        time.sleep(0.05)

vigilar()`

/** One live probe over the computer's python: the account the terminal carries right now
 * (launching the terminal when nothing is running), or null after a 60 s cap or any
 * unreadable run. Verdict source: the child's own first understandable line. */
export const sondearCuenta = (ejecutable: string) =>
  new Promise<DatoVivo | null>((resolver) => {
    let listo = false
    const child = spawn(ejecutable, ["-c", PUENTE_PY, "--probe"], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    })
    if (child.stdout === null) {
      child.kill()
      resolver(null)
      return
    }
    const cerrar = (veredicto: DatoVivo | null) => {
      if (listo) return
      listo = true
      clearTimeout(temporizador)
      child.kill()
      resolver(veredicto)
    }
    const temporizador = setTimeout(() => cerrar(null), 60_000)
    const lineas = createInterface({ input: child.stdout, crlfDelay: Infinity })
    lineas.on("line", (linea) => {
      const fila = leerPuente(linea)
      if (Option.isNone(fila)) return
      if (fila.value.type === "cuenta" && Number.isSafeInteger(fila.value.login))
        cerrar({ login: fila.value.login, server: fila.value.server, name: fila.value.name })
      // An estado line is "no answer yet": the second ciclo may still catch the booting terminal.
    })
    child.on("error", () => cerrar(null))
    // `close` (not `exit`): every stdout line is in before the verdict settles.
    child.on("close", () => cerrar(null))
  })
