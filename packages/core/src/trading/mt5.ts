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
])
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
export const PUENTE_PY = `import datetime, json, math, subprocess, sys, time

PROBE = "--probe" in sys.argv[1:]
RELOJ = ("BTCUSD", "EURUSD", "XAUUSD")

def n(valor):
    try:
        f = float(valor)
    except Exception:
        return None
    return f if math.isfinite(f) else None

def estado(motivo):
    print(json.dumps({"type": "estado", "conectado": False, "motivo": motivo}), flush=True)

${TERMINAL_ABIERTO_PY}

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

def linea(mt5, iniciar):
    if iniciar and not mt5.initialize():
        return "el terminal de MetaTrader 5 no responde"
    cuenta = mt5.account_info()
    if cuenta is None:
        return "el terminal no est\u00e1 conectado a una cuenta"
    abiertas = mt5.positions_get() or ()
    off = desfase(mt5, [p.symbol for p in abiertas] + list(RELOJ))
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
    print(json.dumps({
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
    }), flush=True)

def ciclo(mt5, iniciar):
    motivo = linea(mt5, iniciar)
    if motivo is not None:
        estado(motivo)
        return False
    return True

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
    enganchado = False
    while True:
        abierto = True if enganchado else terminal_abierto()
        if abierto is None:
            estado("no puedo comprobar si el terminal de MetaTrader 5 est\u00e1 abierto (falla la lista de procesos): no me engancho para no abrirlo")
        elif not abierto:
            estado("el terminal de MetaTrader 5 est\u00e1 cerrado")
        else:
            enganchado = ciclo(mt5, not enganchado)
            if not enganchado:
                try:
                    mt5.shutdown()
                except Exception:
                    pass
        time.sleep(5)

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
