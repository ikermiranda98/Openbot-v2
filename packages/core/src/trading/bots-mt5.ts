// The bridge between the bots and a MetaTrader 5 account (a TypeScript port of DeepTrading's
// `bots.rs`).
//
// The bots are written against IBKR's `ib_async`. When the engine starts one for an MT5
// account it puts a small `ib_async` look-alike first on its PYTHONPATH (see `bots-py.ts`),
// and every call that would go to TWS comes here instead, over the local bot API with the
// system's own token. This module turns those calls into MT5 actions on the link's bridge:
//
// | bot order                         | on MT5                                          |
// |-----------------------------------|-------------------------------------------------|
// | market, opening                   | `DEAL` with the bot's magic number              |
// | market, against its position      | `CLOSEVOL` on its positions (oldest first)      |
// | stop / limit that opens or adds   | a pending order on the broker (`PENDING`)       |
// | stop against its position         | the stop loss of each of its positions (`SLTP`) |
// | limit against its position        | the take profit of each of its positions        |
//
// So the protection lives on the broker and keeps working while the app or the bot is
// closed. Sizes keep the same exposure: the lots that give the same money per point as the
// bot's contracts (forex: units of the base currency). Prices are the MT5 symbol's own: the
// bot reads its bars from the same symbol it trades.
//
// Every order, fill and the instruments the bots qualified are persisted (through the
// engine's callbacks), so a bot that restarts finds its orders and executions as on TWS.
import type { LibroMT5, ResultadoMT5 } from "./mt5.js"

/** IB statuses of an order that can still execute. */
const ACTIVOS = new Set(["PendingSubmit", "PreSubmitted", "Submitted"])
/** Broker answers that mean "not now" (market closed, no prices, busy): a market order waits and retries. */
const REINTENTO = new Set([-1, 10004, 10018, 10020, 10021, 10024, 10031, 10012])
/** The price is already beyond the stop or limit: it would trigger at once. */
const CRUZADO = new Set([10015, 10016])
/** How long a bot order is kept after it ends. */
export const RETENCION_MS = 14 * 86_400_000
/** A DAY market order that could not execute gives up after this long. */
const DIA_MS = 12 * 3_600_000
/** Grace before a missing broker order or position is believed. */
const GRACIA_MS = 6_000

type Posicion = LibroMT5["positions"][number]
type Operacion = NonNullable<LibroMT5["deals"]>[number]

/** One tradable thing a bot asked for, and the MT5 symbol that stands for it. */
export interface Instrumento {
  conId: number
  /** MNQ, MGC, USDJPY… */
  root: string
  /** What the bot asked for: FUT, CONTFUT, CASH, CFD. */
  secType: string
  exchange: string
  currency: string
  /** Money per point of one bot contract (futures and CFDs); unused for forex. */
  multiplier: number
  /** Bot quantities are units of the base currency. */
  forex: boolean
  /** The MT5 link (`mt5-<login>@<server>`) the symbol was resolved on. */
  account: string
  mt5: string
  digits: number
  contractSize: number
  tickSize: number
  tickValue: number
  volumeMin: number
  volumeStep: number
  volumeMax: number
}

const redondear = (valor: number, digitos: number) => {
  const f = 10 ** digitos
  return Math.round(valor * f) / f
}

/** MT5 lots for one bot unit (same money per point). */
export const lotesPorUnidad = (i: Instrumento) => {
  if (i.forex) return 1 / Math.max(i.contractSize, 1e-9)
  const porLote = i.tickSize > 0 ? i.tickValue / i.tickSize : 0
  return porLote > 0 ? i.multiplier / porLote : 1
}

/** Lots for `qty` bot units, on the symbol's volume step and inside its limits. */
export const lotes = (i: Instrumento, qty: number) => {
  const paso = i.volumeStep > 0 ? i.volumeStep : 0.01
  let v = Math.round((Math.abs(qty) * lotesPorUnidad(i)) / paso) * paso
  if (v < i.volumeMin && Math.abs(qty) > 0) v = i.volumeMin
  if (i.volumeMax > 0) v = Math.min(v, i.volumeMax)
  return redondear(v, 8)
}

/** Bot units for `lots`. */
export const unidades = (i: Instrumento, lots: number) => {
  const u = lots / lotesPorUnidad(i)
  const r = Math.round(u)
  return Math.abs(u - r) < 1e-6 ? r : redondear(u, 6)
}

const precioDe = (i: Instrumento, p: number) =>
  redondear(i.tickSize > 0 ? Math.round(p / i.tickSize) * i.tickSize : p, Math.min(Math.max(i.digits, 0), 10))

/** A bot's order as `ib_async` sees it, plus how it lives on MT5. */
export interface OrdenVirtual {
  orderId: number
  permId: number
  system: string
  clientId: number
  conId: number
  symbol: string
  action: "BUY" | "SELL"
  orderType: "MKT" | "STP" | "LMT"
  qty: number
  auxPrice: number
  lmtPrice: number
  tif: string
  ocaGroup: string
  role: "market" | "entry" | "exit_sl" | "exit_tp"
  status: string
  filled: number
  avgFillPrice: number
  /** The broker's pending order (entry stops and limits). */
  ticket: number
  /** Broker deals already counted for this order. */
  deals: number[]
  message: string
  /** The MT5 link the order lives on. */
  account: string
  created: number
  updated: number
  /** Earliest next try of a waiting market order or entry. */
  nextTry: number
}

export const activa = (o: OrdenVirtual) => ACTIVOS.has(o.status)

/** One execution, as `reqExecutions` / `fills` report it. */
export interface Ejecucion {
  execId: string
  orderId: number
  permId: number
  system: string
  clientId: number
  conId: number
  symbol: string
  /** BOT | SLD. */
  side: "BOT" | "SLD"
  shares: number
  price: number
  time: number
  account: string
}

/** What the translator needs from the engine. */
export interface EntornoBots {
  /** The MT5 link a system trades on, or the reason it has none. */
  readonly enlaceDe: (sistema: string) => { ok: true; enlace: string } | { ok: false; motivo: string }
  /** The link's last book; null while its bridge reads nothing (terminal offline). */
  readonly libro: (enlace: string) => LibroMT5 | null
  readonly comando: (enlace: string, verbo: string, arg: string) => Promise<ResultadoMT5>
  readonly magic: (sistema: string) => number
  /** The system's own symbol choice (`system.json` → "symbol"). */
  readonly simbolo: (sistema: string) => string | null
  readonly log: (nivel: "info" | "warning" | "error", sistema: string, mensaje: string) => void
  readonly guardarOrden: (o: OrdenVirtual) => void
  readonly guardarEjecucion: (f: Ejecucion) => void
  readonly guardarInstrumentos: (lista: Instrumento[]) => void
}

export interface EstadoInicial {
  readonly ordenes: readonly OrdenVirtual[]
  readonly ejecuciones: readonly Ejecucion[]
  readonly instrumentos: readonly Instrumento[]
}

export const magicPorDefecto = (sistema: string) => 7_700_000 + (Number.parseInt(sistema, 10) || 0)

// ----- instruments ------------------------------------------------------------------

const NASDAQ = ["US100", "USTEC", "NAS100", "NDX100", "USTECH", "NQ100", "US100Cash", "NASDAQ"]
const SP500 = ["US500", "SPX500", "SP500", "US500Cash", "USA500", "SPX"]
const RUSSELL = ["US2000", "RUS2000", "RUSSELL2000", "US2000Cash", "R2000", "USSC2000", "RTY"]
const DOW = ["US30", "DJ30", "WS30", "US30Cash", "DOW30", "USA30"]
const ORO = ["XAUUSD", "GOLD", "XAUUSD.", "GOLDmicro"]
const PLATA = ["XAGUSD", "SILVER"]
const PETROLEO = ["USOIL", "WTI", "XTIUSD", "CL-OIL", "USOUSD"]

/** Futures roots: money per point of one contract and the MT5 symbols that follow the same market. */
const FUTUROS: Record<string, readonly [number, readonly string[]]> = {
  MNQ: [2, NASDAQ],
  NQ: [20, NASDAQ],
  MES: [5, SP500],
  ES: [50, SP500],
  M2K: [5, RUSSELL],
  RTY: [50, RUSSELL],
  MYM: [0.5, DOW],
  YM: [5, DOW],
  MGC: [10, ORO],
  GC: [100, ORO],
  SIL: [1000, PLATA],
  SI: [5000, PLATA],
  MCL: [100, PETROLEO],
  CL: [1000, PETROLEO],
}

/** Common broker suffixes for the same symbol. */
const SUFIJOS = ["", ".cash", ".a", "m", ".m", ".pro", ".raw", "+", ".i", "_i"]

/** A stable conId per root (FNV-1a), the same on every run and machine. */
export const conIdDe = (root: string) => {
  let h = 0x811c9dc5
  for (const b of Buffer.from(root, "utf8")) {
    h ^= b
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return (h & 0x3fffffff) + 100_000
}

/** What the bot asked `qualifyContracts` for. */
export interface PeticionContrato {
  readonly secType?: string
  readonly symbol?: string
  readonly currency?: string
  readonly exchange?: string
  readonly conId?: number
}

/** What `placeOrder` sends. */
export interface PeticionOrden {
  readonly orderId?: number
  readonly clientId?: number
  readonly conId: number
  readonly action: string
  readonly orderType: string
  readonly totalQuantity: number
  readonly auxPrice?: number
  readonly lmtPrice?: number
  readonly tif?: string
  readonly ocaGroup?: string
}

const MARCOS: Record<string, string> = {
  "1 min": "M1",
  "2 mins": "M2",
  "3 mins": "M3",
  "5 mins": "M5",
  "10 mins": "M10",
  "15 mins": "M15",
  "20 mins": "M20",
  "30 mins": "M30",
  "1 hour": "H1",
  "1 hours": "H1",
  "60 mins": "H1",
  "2 hours": "H2",
  "3 hours": "H3",
  "4 hours": "H4",
  "8 hours": "H8",
  "1 day": "D1",
  "1 week": "W1",
}

/** IB duration strings in seconds. "N D" counts trading days, so weekends are added. */
export const duracionSegundos = (d: string): number | null => {
  const partes = d.trim().split(/\s+/)
  const cantidad = Number(partes[0])
  if (partes.length < 2 || !Number.isInteger(cantidad)) return null
  const dia = 86_400
  switch (partes[1].toUpperCase()) {
    case "S":
      return cantidad
    case "D":
      return (cantidad + 2 * Math.floor((cantidad + 4) / 5) + 1) * dia
    case "W":
      return cantidad * 7 * dia
    case "M":
      return cantidad * 31 * dia
    case "Y":
      return cantidad * 366 * dia
    default:
      return null
  }
}

const neto = (posiciones: readonly Posicion[]) =>
  posiciones.reduce((suma, p) => suma + (p.side === "short" ? -p.volume : p.volume), 0)

const numero = (valor: unknown, defecto = 0) => (typeof valor === "number" && Number.isFinite(valor) ? valor : defecto)
const campo = (datos: unknown, clave: string) =>
  typeof datos === "object" && datos !== null ? (datos as Record<string, unknown>)[clave] : undefined

/** The translator: one per engine. */
export const crearTraductor = (entorno: EntornoBots, inicial: EstadoInicial) => {
  const ordenes = new Map<number, OrdenVirtual>()
  const desde = Date.now() - RETENCION_MS
  for (const o of inicial.ordenes) if (activa(o) || o.updated >= desde) ordenes.set(o.orderId, o)
  let ejecuciones = inicial.ejecuciones.filter((f) => f.time >= desde)
  const instrumentos = new Map(inicial.instrumentos.map((i) => [i.conId, i]))
  let siguiente = Math.max(999, ...[...ordenes.keys()]) + 1
  /** Last SL/TP request per position ticket, so a refused one is not resent every second. */
  const sltpEnviado = new Map<number, number>()

  // One trading action at a time: placing, cancelling and reconciling never interleave.
  let cola: Promise<unknown> = Promise.resolve()
  let ocupado = false
  const enExclusiva = <T>(trabajo: () => Promise<T>): Promise<T> => {
    const hecho = cola.then(async () => {
      ocupado = true
      try {
        return await trabajo()
      } finally {
        ocupado = false
      }
    })
    cola = hecho.catch(() => undefined)
    return hecho
  }

  const instrumento = (conId: number): Instrumento => {
    const i = instrumentos.get(conId)
    if (i === undefined) throw new Error(`conId ${conId} sin cualificar`)
    return i
  }

  const enlaceOError = (sistema: string) => {
    const r = entorno.enlaceDe(sistema)
    if (!r.ok) throw new Error(r.motivo)
    if (entorno.libro(r.enlace) === null) throw new Error(`la cuenta ${r.enlace} no tiene el terminal de MetaTrader 5 conectado`)
    return r.enlace
  }

  const posicionesBot = (enlace: string, magic: number, simbolo: string) =>
    (entorno.libro(enlace)?.positions ?? [])
      .filter((p) => p.magic === magic && p.symbol === simbolo)
      .sort((a, b) => a.time - b.time)

  const operaciones = (enlace: string): readonly Operacion[] => entorno.libro(enlace)?.deals ?? []

  /** The account name the bots see: paper accounts start with "DU", like on IBKR. */
  const nombreCuenta = (enlace: string) => {
    const libro = entorno.libro(enlace)
    if (libro === null) return enlace
    return `${libro.demo ? "DU" : "U"}${libro.login}`
  }

  const contratoJson = (i: Instrumento, secType = "") => {
    const [symbol, currency] = i.forex && i.root.length === 6 ? [i.root.slice(0, 3), i.root.slice(3)] : [i.root, i.currency]
    return {
      conId: i.conId,
      secType: secType === "" ? i.secType : secType,
      symbol,
      currency,
      exchange: i.exchange,
      localSymbol: i.mt5,
      tradingClass: i.root,
      multiplier: i.forex ? "" : String(i.multiplier),
      lastTradeDateOrContractMonth: "",
      mt5: i.mt5,
      lotsPerUnit: lotesPorUnidad(i),
    }
  }

  const resolver = async (sistema: string, enlace: string, root: string, sec: string, exchange: string, currency: string) => {
    const futuro = FUTUROS[root]
    const forex = futuro === undefined && /^[A-Za-z]{6}$/.test(root)
    // The system's own choice (system.json "symbol") wins over the built-in list.
    const nombres: string[] = []
    const elegido = entorno.simbolo(sistema)
    if (elegido !== null) nombres.push(elegido)
    const bases = futuro === undefined ? [root] : futuro[1]
    for (const sufijo of SUFIJOS) for (const b of bases) nombres.push(`${b}${sufijo}`)
    let spec: unknown = null
    for (const nombre of nombres) {
      const r = await entorno.comando(enlace, "SYMBOL", nombre)
      if (r.ok && typeof r.data === "object" && r.data !== null) {
        spec = r.data
        break
      }
      if (r.retcode === -1 || r.retcode === -2) throw new Error(r.message)
    }
    if (spec === null)
      throw new Error(
        `MT5 no tiene ningún símbolo para ${root} (probados ${nombres.slice(0, 8).join(", ")}). Pon el nombre exacto en "symbol" del system.json del sistema.`,
      )
    const i: Instrumento = {
      conId: conIdDe(root),
      root,
      secType: sec !== "" ? sec : forex ? "CASH" : "FUT",
      exchange,
      currency: currency !== "" ? currency : String(campo(spec, "currency_profit") ?? "USD"),
      multiplier: futuro?.[0] ?? 1,
      forex,
      account: enlace,
      mt5: String(campo(spec, "symbol") ?? root),
      digits: numero(campo(spec, "digits"), 5),
      contractSize: numero(campo(spec, "contract_size")),
      tickSize: numero(campo(spec, "tick_size")),
      tickValue: numero(campo(spec, "tick_value")),
      volumeMin: numero(campo(spec, "volume_min")),
      volumeStep: numero(campo(spec, "volume_step")),
      volumeMax: numero(campo(spec, "volume_max")),
    }
    instrumentos.set(i.conId, i)
    entorno.guardarInstrumentos([...instrumentos.values()])
    entorno.log("info", sistema, `${root} → ${i.mt5} en MT5 (${i.forex ? `${lotesPorUnidad(i) * 100_000} lotes por 100.000 unidades` : `${Number(lotesPorUnidad(i).toPrecision(6))} lotes por contrato`} del bot)`)
    return i
  }

  /** Resolves what a bot asked for to an instrument on the system's MT5 account. */
  const qualify = async (sistema: string, req: PeticionContrato) => {
    const enlace = enlaceOError(sistema)
    const conId = numero(req.conId)
    // A conId the bot already got: same instrument (refreshed when the account changed).
    if (conId !== 0 && (req.symbol ?? "") === "") {
      const conocido = instrumentos.get(conId)
      if (conocido === undefined) throw new Error(`conId ${conId} desconocido`)
      const i =
        conocido.account === enlace
          ? conocido
          : await resolver(sistema, enlace, conocido.root, conocido.secType, conocido.exchange, conocido.currency)
      return contratoJson(i, req.secType ?? "")
    }
    const sec = (req.secType ?? "").toUpperCase()
    const sym = (req.symbol ?? "").toUpperCase()
    const moneda = req.currency ?? ""
    const root =
      sec === "CASH" || sec === "CFD" ? (sym.length === 3 && moneda.length === 3 ? `${sym}${moneda.toUpperCase()}` : sym.replaceAll(".", "")) : sym
    if (root === "") throw new Error("contrato sin símbolo")
    const i = await resolver(sistema, enlace, root, sec, req.exchange ?? "", moneda)
    return contratoJson(i, req.secType ?? "")
  }

  /** `reqHistoricalData`: the MT5 bars of the instrument's symbol for an IB duration and bar size. */
  const bars = async (sistema: string, conId: number, finSegundos: number | null, duracion: string, tamano: string) => {
    const i = instrumento(conId)
    const enlace = enlaceOError(sistema)
    const tf = MARCOS[tamano.trim().toLowerCase()]
    if (tf === undefined) throw new Error(`tamaño de vela no soportado con MT5: ${tamano}`)
    const hasta = finSegundos ?? Math.floor(Date.now() / 1000)
    const lapso = duracionSegundos(duracion)
    if (lapso === null) throw new Error(`duración no soportada: ${duracion}`)
    const r = await entorno.comando(enlace, "RATES", `${i.mt5};${tf};${hasta - lapso};${hasta}`)
    if (!r.ok) {
      // No bars in that window (before the history starts) reads as an empty answer, like TWS.
      if (Array.isArray(r.data) && r.data.length === 0 && r.retcode !== -1 && r.retcode !== -2) return []
      throw new Error(r.message)
    }
    return Array.isArray(r.data) ? r.data : []
  }

  /** The bot's open positions per instrument it qualified, in its own units. */
  const positions = (sistema: string) => {
    const r = entorno.enlaceDe(sistema)
    if (!r.ok || entorno.libro(r.enlace) === null) return []
    const magic = entorno.magic(sistema)
    const vistos = new Set<string>()
    return [...instrumentos.values()]
      .filter((i) => i.account === r.enlace)
      .flatMap((i) => {
        if (vistos.has(i.mt5)) return []
        vistos.add(i.mt5)
        const ps = posicionesBot(r.enlace, magic, i.mt5)
        if (ps.length === 0) return []
        const lots = neto(ps)
        const vol = ps.reduce((s, p) => s + p.volume, 0)
        const media = vol > 0 ? ps.reduce((s, p) => s + p.entry * p.volume, 0) / vol : 0
        return [
          {
            account: nombreCuenta(r.enlace),
            contract: contratoJson(i),
            position: unidades(i, Math.abs(lots)) * Math.sign(lots),
            avgCost: media * (i.forex ? 1 : i.multiplier),
          },
        ]
      })
  }

  /** `accountSummary` tags from the MT5 account. */
  const accountSummary = (sistema: string) => {
    const r = entorno.enlaceDe(sistema)
    if (!r.ok) return []
    const libro = entorno.libro(r.enlace)
    if (libro === null) return []
    const nombre = nombreCuenta(r.enlace)
    const etiquetas: [string, number | null][] = [
      ["NetLiquidation", libro.equity],
      ["TotalCashValue", libro.balance],
      ["EquityWithLoanValue", libro.equity],
      ["AvailableFunds", libro.margin_free],
      ["ExcessLiquidity", libro.margin_free],
      ["FullInitMarginReq", libro.margin],
      ["InitMarginReq", libro.margin],
      ["MaintMarginReq", libro.margin],
      ["UnrealizedPnL", libro.profit],
      ["BuyingPower", libro.margin_free === null || libro.leverage === 0 ? null : libro.margin_free * libro.leverage],
    ]
    return [
      ...etiquetas
        .filter((fila): fila is [string, number] => fila[1] !== null)
        .map(([tag, valor]) => ({ account: nombre, tag, value: valor.toFixed(2), currency: libro.currency, modelCode: "" })),
      { account: nombre, tag: "AccountType", value: libro.demo ? "PAPER" : "INDIVIDUAL", currency: "", modelCode: "" },
    ]
  }

  const hello = (sistema: string) => {
    const enlace = enlaceOError(sistema)
    const nombre = nombreCuenta(enlace)
    const magic = entorno.magic(sistema)
    entorno.log("info", sistema, `Bot conectado al motor: opera en ${nombre} (${enlace}) con magic ${magic}`)
    return { system: sistema, accounts: [nombre], account: enlace, magic, broker: "mt5", serverTime: Date.now() }
  }

  // ----- orders --------------------------------------------------------------------

  const guardar = (o: OrdenVirtual) => {
    ordenes.set(o.orderId, { ...o, deals: [...o.deals] })
    entorno.guardarOrden(o)
  }

  const estado = (o: OrdenVirtual, status: string, mensaje: string) => {
    o.status = status
    o.message = mensaje
    o.updated = Date.now()
  }

  /** Adds an execution of `units` at `price` to the order and books the fill. */
  const sumarEjecucion = (o: OrdenVirtual, deal: number, units: number, price: number, at: number) => {
    if (units <= 0) return
    const total = o.filled + units
    o.avgFillPrice = total > 0 ? (o.avgFillPrice * o.filled + price * units) / total : price
    o.filled = total
    if (deal !== 0) o.deals.push(deal)
    const f: Ejecucion = {
      execId: `${deal}.${o.orderId}`,
      orderId: o.orderId,
      permId: o.permId,
      system: o.system,
      clientId: o.clientId,
      conId: o.conId,
      symbol: o.symbol,
      side: o.action === "BUY" ? "BOT" : "SLD",
      shares: units,
      price,
      time: at,
      account: nombreCuenta(o.account),
    }
    ejecuciones.push(f)
    entorno.guardarEjecucion(f)
  }

  const comentario = (o: OrdenVirtual) => `OB${o.system}#${o.orderId}`

  /** The bot's signed position on the order's symbol in lots, from MT5, or from its own
   * fills of the last seconds while MT5 has not reported the new position yet. */
  const netoDe = (o: OrdenVirtual, magic: number) => {
    const n = neto(posicionesBot(o.account, magic, o.symbol))
    if (Math.abs(n) > 1e-9) return n
    const reciente = Date.now() - 15_000
    const u = ejecuciones
      .filter((f) => f.system === o.system && f.conId === o.conId && f.time >= reciente)
      .reduce((s, f) => s + (f.side === "BOT" ? f.shares : -f.shares), 0)
    const i = instrumentos.get(o.conId)
    return i === undefined ? 0 : u * lotesPorUnidad(i)
  }

  /** Market order: closes the bot's opposite positions first (oldest first), then opens the rest. */
  const ejecutarMercado = async (o: OrdenVirtual, i: Instrumento, magic: number) => {
    const paso = i.volumeStep > 0 ? i.volumeStep : 0.01
    let falta = lotes(i, o.qty - o.filled)
    const opuestas = posicionesBot(o.account, magic, o.symbol).filter((p) => (p.side === "long") !== (o.action === "BUY"))
    let fallo: ResultadoMT5 | null = null
    for (const p of opuestas) {
      if (falta < paso / 2) break
      const vol = redondear(Math.min(p.volume, falta), 8)
      const r = await entorno.comando(o.account, "CLOSEVOL", `${p.ticket};${vol}`)
      if (r.ok) {
        const precio = numero(campo(r.data, "price")) > 0 ? numero(campo(r.data, "price")) : p.current
        const hecho = numero(campo(r.data, "volume")) > 0 ? numero(campo(r.data, "volume")) : vol
        sumarEjecucion(o, numero(campo(r.data, "deal")), unidades(i, hecho), precio, Date.now())
        falta = redondear(falta - hecho, 8)
      } else if (r.retcode !== 10036) {
        fallo = r
        break
      }
    }
    if (fallo === null && falta >= paso / 2) {
      const lado = o.action === "BUY" ? "buy" : "sell"
      const r = await entorno.comando(o.account, "DEAL", `${o.symbol};${lado};${falta};${magic};${comentario(o)}`)
      if (r.ok) {
        const hecho = numero(campo(r.data, "volume")) > 0 ? numero(campo(r.data, "volume")) : falta
        sumarEjecucion(o, numero(campo(r.data, "deal")), unidades(i, hecho), numero(campo(r.data, "price")), Date.now())
      } else fallo = r
    }
    if (fallo === null) {
      // Small rounding leftovers count as done.
      o.filled = Math.max(o.filled, o.qty)
      estado(o, "Filled", "")
      entorno.log("info", o.system, `Orden ${o.orderId} ejecutada a ${o.avgFillPrice} en ${o.symbol}`)
      return
    }
    if (REINTENTO.has(fallo.retcode)) {
      o.nextTry = Date.now() + 10_000
      if (o.status !== "Submitted" || o.message !== fallo.message)
        entorno.log("warning", o.system, `Orden ${o.orderId} en espera: ${fallo.message} (se reintenta)`)
      estado(o, "Submitted", fallo.message)
      return
    }
    entorno.log("error", o.system, `Orden ${o.orderId} rechazada por MT5: ${fallo.message} (${fallo.retcode})`)
    estado(o, o.filled > 0 ? "Cancelled" : "Inactive", fallo.message)
  }

  /** Entry stop or limit: a pending order on the broker. Already crossed → it triggers now, at market. */
  const ponerEntrada = async (o: OrdenVirtual, i: Instrumento, magic: number) => {
    const lado = o.action === "BUY" ? "buy" : "sell"
    const [tipo, precio] = o.orderType === "STP" ? ["stop", o.auxPrice] : ["limit", o.lmtPrice]
    const lots = lotes(i, o.qty - o.filled)
    const r = await entorno.comando(
      o.account,
      "PENDING",
      `${o.symbol};${lado};${tipo};${lots};${precio};${magic};${comentario(o)};${o.tif === "DAY" ? "1" : "0"}`,
    )
    if (r.ok) {
      o.ticket = numero(campo(r.data, "order"))
      estado(o, "Submitted", "")
    } else if (CRUZADO.has(r.retcode)) {
      entorno.log("info", o.system, `Orden ${o.orderId}: el precio ya pasó ${precio}; se ejecuta a mercado`)
      await ejecutarMercado(o, i, magic)
    } else if (REINTENTO.has(r.retcode)) {
      o.nextTry = Date.now() + 10_000
      estado(o, "Submitted", r.message)
    } else {
      entorno.log("error", o.system, `Orden ${o.orderId} rechazada por MT5: ${r.message} (${r.retcode})`)
      estado(o, "Inactive", r.message)
    }
  }

  const salidasActivas = (sistema: string, conId: number) =>
    [...ordenes.values()]
      .filter((o) => o.system === sistema && o.conId === conId && activa(o) && (o.role === "exit_sl" || o.role === "exit_tp"))
      .map((o) => ({ ...o, deals: [...o.deals] }))
      .sort((a, b) => a.updated - b.updated)

  /** Takes a cancelled exit's stop or target off the bot's positions. */
  const quitarProteccion = async (o: OrdenVirtual, magic: number) => {
    const siguen = salidasActivas(o.system, o.conId)
    const mantenerSl = siguen.some((x) => x.role === "exit_sl")
    const mantenerTp = siguen.some((x) => x.role === "exit_tp")
    for (const p of posicionesBot(o.account, magic, o.symbol)) {
      const sl = o.role === "exit_sl" && !mantenerSl ? 0 : p.sl
      const tp = o.role === "exit_tp" && !mantenerTp ? 0 : p.tp
      await entorno.comando(o.account, "SLTP", `${p.ticket};${sl};${tp}`)
    }
  }

  /** Keeps every position of the bot on that instrument carrying its working exit stop and
   * target, and books those exits when MT5 executed them. */
  const proteger = async (enlace: string, sistema: string, conId: number, magic: number) => {
    const salidas = salidasActivas(sistema, conId)
    if (salidas.length === 0) return
    const i = instrumentos.get(conId)
    if (i === undefined) return
    const posiciones = posicionesBot(enlace, magic, i.mt5)
    const ahora = Date.now()

    // 1) Exits MT5 already executed (stop loss / take profit deals of this bot since the order).
    const primera = Math.min(...salidas.map((o) => o.created))
    const usadas = new Set([...ordenes.values()].flatMap((o) => o.deals))
    const golpes = operaciones(enlace).filter(
      (d) =>
        d.magic === magic &&
        d.symbol === i.mt5 &&
        d.entry !== "in" &&
        d.time >= primera - 2_000 &&
        !usadas.has(d.deal) &&
        (d.reason === "sl" || d.reason === "tp"),
    )
    for (const motivo of ["sl", "tp"] as const) {
      const rol = motivo === "sl" ? "exit_sl" : "exit_tp"
      const ds = golpes.filter((d) => d.reason === motivo)
      if (ds.length === 0) continue
      const o = [...salidas].reverse().find((x) => x.role === rol)
      if (o === undefined) continue
      const lots = ds.reduce((s, d) => s + d.volume, 0)
      const px = ds.reduce((s, d) => s + d.price * d.volume, 0) / Math.max(lots, 1e-12)
      const at = Math.max(...ds.map((d) => d.time))
      const units = Math.max(Math.min(unidades(i, lots), o.qty - o.filled), 0)
      o.deals.push(...ds.map((d) => d.deal))
      sumarEjecucion(o, 0, units, px, at)
      if (posiciones.length === 0 || o.filled >= o.qty - 1e-9) {
        o.filled = o.qty
        estado(o, "Filled", "")
        entorno.log("info", sistema, `Orden ${o.orderId} (${motivo === "sl" ? "stop" : "objetivo"}) ejecutada por MT5 a ${px}`)
      }
      guardar(o)
    }

    // 2) No position left: the other exits (OCA siblings or orphans) end, like an OCA group on TWS.
    if (posiciones.length === 0) {
      for (const o of salidasActivas(sistema, conId)) {
        if (ahora - o.created < GRACIA_MS && golpes.length === 0) continue
        estado(o, "Cancelled", golpes.length === 0 ? "la posición ya no está abierta" : "OCA: el stop o el objetivo del grupo se ejecutó")
        guardar(o)
      }
      return
    }

    // 3) Each position carries the working stop and target.
    const vigentes = salidasActivas(sistema, conId).reverse()
    const sl = vigentes.find((o) => o.role === "exit_sl")?.auxPrice
    const tp = vigentes.find((o) => o.role === "exit_tp")?.lmtPrice
    const tolerancia = Math.max(i.tickSize / 2, 1e-9)
    for (const p of posiciones) {
      const quiereSl = sl ?? p.sl
      const quiereTp = tp ?? p.tp
      if (Math.abs(p.sl - quiereSl) < tolerancia && Math.abs(p.tp - quiereTp) < tolerancia) continue
      if (ahora - (sltpEnviado.get(p.ticket) ?? 0) < 3_000) continue
      sltpEnviado.set(p.ticket, ahora)
      const r = await entorno.comando(enlace, "SLTP", `${p.ticket};${quiereSl};${quiereTp}`)
      if (r.ok || !CRUZADO.has(r.retcode)) {
        if (!r.ok) entorno.log("warning", sistema, `MT5 no aceptó stop/objetivo en ${p.ticket}: ${r.message}`)
        continue
      }
      // Refused because the price is already beyond it: it would have triggered on TWS. Close now.
      const larga = p.side === "long"
      const tocaSl = quiereSl > 0 && (larga ? p.current <= quiereSl : p.current >= quiereSl)
      const tocaTp = quiereTp > 0 && (larga ? p.current >= quiereTp : p.current <= quiereTp)
      if (!(tocaSl || tocaTp)) continue
      const rol = tocaSl ? "exit_sl" : "exit_tp"
      const cierre = await entorno.comando(enlace, "CLOSEVOL", `${p.ticket};${p.volume}`)
      if (!cierre.ok) continue
      const o = salidasActivas(sistema, conId)
        .reverse()
        .find((x) => x.role === rol)
      if (o === undefined) continue
      const precio = numero(campo(cierre.data, "price")) > 0 ? numero(campo(cierre.data, "price")) : p.current
      sumarEjecucion(o, numero(campo(cierre.data, "deal")), Math.min(unidades(i, p.volume), o.qty - o.filled), precio, Date.now())
      const quedan = posicionesBot(enlace, magic, i.mt5).filter((q) => q.ticket !== p.ticket)
      if (o.filled >= o.qty - 1e-9 || quedan.length === 0) {
        o.filled = o.qty
        estado(o, "Filled", "")
      }
      guardar(o)
      entorno.log("info", sistema, `Orden ${o.orderId}: el precio ya había pasado el nivel; cerrada a mercado a ${precio}`)
    }
  }

  /** `placeOrder`: a new order, or a change to one still working. */
  const place = (sistema: string, req: PeticionOrden) =>
    enExclusiva(async () => {
      const i = instrumento(numero(req.conId))
      const enlace = enlaceOError(sistema)
      const accion = req.action.toUpperCase()
      if (accion !== "BUY" && accion !== "SELL") throw new Error(`acción desconocida: ${req.action}`)
      const tipo = req.orderType.toUpperCase()
      if (tipo !== "MKT" && tipo !== "STP" && tipo !== "LMT") throw new Error(`tipo de orden no soportado con MT5: ${req.orderType}`)
      const cantidad = numero(req.totalQuantity)
      if (!(cantidad > 0)) throw new Error("la cantidad debe ser mayor que 0")
      const magic = entorno.magic(sistema)
      const aux = numero(req.auxPrice)
      const lmt = numero(req.lmtPrice)
      const pedido = numero(req.orderId)

      // A change to an order that is still working.
      const existente = pedido > 0 ? ordenes.get(pedido) : undefined
      if (existente !== undefined && existente.system === sistema && activa(existente)) {
        const o = { ...existente, deals: [...existente.deals] }
        const cambiaPrecio = Math.abs(o.auxPrice - precioDe(i, aux)) > 1e-9 || Math.abs(o.lmtPrice - precioDe(i, lmt)) > 1e-9
        const cambiaCantidad = Math.abs(o.qty - cantidad) > 1e-9
        o.qty = cantidad
        o.auxPrice = precioDe(i, aux)
        o.lmtPrice = precioDe(i, lmt)
        o.ocaGroup = req.ocaGroup ?? ""
        o.updated = Date.now()
        if (o.role === "entry" && o.ticket > 0 && (cambiaPrecio || cambiaCantidad)) {
          const r = await entorno.comando(o.account, "DELETE", String(o.ticket))
          if (r.ok) {
            o.ticket = 0
            await ponerEntrada(o, i, magic)
          }
        } else if (o.role === "exit_sl" || o.role === "exit_tp") {
          guardar(o)
          await proteger(o.account, sistema, o.conId, magic)
          return ordenes.get(o.orderId) ?? o
        }
        guardar(o)
        return o
      }

      const id = pedido > 0 && !ordenes.has(pedido) ? Math.max(pedido, siguiente) : siguiente
      siguiente = id + 1
      const ahora = Date.now()
      const o: OrdenVirtual = {
        orderId: id,
        permId: id,
        system: sistema,
        clientId: numero(req.clientId),
        conId: i.conId,
        symbol: i.mt5,
        action: accion,
        orderType: tipo,
        qty: cantidad,
        auxPrice: precioDe(i, aux),
        lmtPrice: precioDe(i, lmt),
        tif: (req.tif ?? "") === "" ? "DAY" : (req.tif ?? "").toUpperCase(),
        ocaGroup: req.ocaGroup ?? "",
        role: "entry",
        status: "PendingSubmit",
        filled: 0,
        avgFillPrice: 0,
        ticket: 0,
        deals: [],
        message: "",
        account: enlace,
        created: ahora,
        updated: ahora,
        nextTry: 0,
      }
      const n = netoDe(o, magic)
      const contra = (accion === "BUY" && n < -1e-9) || (accion === "SELL" && n > 1e-9)
      o.role = tipo === "MKT" ? "market" : contra ? (tipo === "STP" ? "exit_sl" : "exit_tp") : "entry"
      guardar(o)
      const como =
        o.role === "market"
          ? "a mercado"
          : o.role === "entry"
            ? `${tipo === "STP" ? "stop" : "límite"} pendiente en ${tipo === "STP" ? o.auxPrice : o.lmtPrice}`
            : o.role === "exit_sl"
              ? `stop de salida en ${o.auxPrice}`
              : `objetivo en ${o.lmtPrice}`
      entorno.log(
        "info",
        sistema,
        `Orden ${o.orderId} ${o.action} ${o.qty} ${o.symbol} ${como} (${lotes(i, o.qty)} lotes)${o.ocaGroup === "" ? "" : ` · OCA ${o.ocaGroup}`}`,
      )
      if (o.role === "market") await ejecutarMercado(o, i, magic)
      else if (o.role === "entry") await ponerEntrada(o, i, magic)
      else {
        estado(o, "Submitted", "")
        guardar(o)
        await proteger(enlace, sistema, o.conId, magic)
        return ordenes.get(o.orderId) ?? o
      }
      guardar(o)
      return o
    })

  /** `cancelOrder`. */
  const cancel = (sistema: string, orderId: number) =>
    enExclusiva(async () => {
      const previa = ordenes.get(orderId)
      if (previa === undefined || previa.system !== sistema) throw new Error("orden desconocida")
      const o = { ...previa, deals: [...previa.deals] }
      if (!activa(o)) return o
      const magic = entorno.magic(sistema)
      if (o.role === "entry" && o.ticket > 0) {
        const r = await entorno.comando(o.account, "DELETE", String(o.ticket))
        // Gone already: it may have filled; the next check books it.
        if (r.ok) estado(o, "Cancelled", "")
        else o.message = r.message
      } else if (o.role === "exit_sl" || o.role === "exit_tp") {
        estado(o, "Cancelled", "")
        guardar(o)
        await quitarProteccion(o, magic)
      } else estado(o, "Cancelled", "")
      guardar(o)
      if (o.status === "Cancelled") entorno.log("info", sistema, `Orden ${o.orderId} cancelada`)
      return o
    })

  const podar = (ahora: number) => {
    const antes = ahora - RETENCION_MS
    for (const [id, o] of ordenes) if (!activa(o) && o.updated < antes) ordenes.delete(id)
    ejecuciones = ejecuciones.filter((f) => f.time >= antes)
    for (const [ticket, t] of sltpEnviado) if (ahora - t >= 60_000) sltpEnviado.delete(ticket)
  }

  /** Every second: entries the broker filled, exits it executed, protection on new positions,
   * and market orders waiting for the market to open. Skipped while another action runs. */
  const tick = async () => {
    if (ocupado) return
    await enExclusiva(async () => {
      const ahora = Date.now()
      const vivas = [...ordenes.values()].filter(activa).map((o) => ({ ...o, deals: [...o.deals] }))
      if (vivas.length === 0) {
        podar(ahora)
        return
      }
      const grupos = new Map<string, { enlace: string; sistema: string; conId: number }>()
      for (const o of vivas) {
        const libro = entorno.libro(o.account)
        if (libro === null) continue // terminal offline: nothing can be known or done now
        const i = instrumentos.get(o.conId)
        if (i === undefined) continue
        const magic = entorno.magic(o.system)
        if (o.role === "market") {
          if (o.tif === "DAY" && ahora - o.created > DIA_MS) {
            estado(o, "Cancelled", "no se pudo ejecutar en el día")
            guardar(o)
          } else if (ahora >= o.nextTry) {
            await ejecutarMercado(o, i, magic)
            guardar(o)
          }
        } else if (o.role === "entry" && o.ticket === 0) {
          if (ahora >= o.nextTry) {
            await ponerEntrada(o, i, magic)
            guardar(o)
          }
        } else if (o.role === "entry") {
          const ds = operaciones(o.account).filter((d) => d.order === o.ticket && !o.deals.includes(d.deal))
          for (const d of ds) sumarEjecucion(o, d.deal, Math.max(Math.min(unidades(i, d.volume), o.qty - o.filled), 0), d.price, d.time)
          const pendiente = libro.orders.some((p) => p.ticket === o.ticket)
          if (!pendiente && o.filled > 0) {
            estado(o, "Filled", "")
            entorno.log("info", o.system, `Orden ${o.orderId} ejecutada por MT5 a ${o.avgFillPrice}`)
            guardar(o)
          } else if (!pendiente && ahora - o.updated > GRACIA_MS) {
            estado(o, "Cancelled", "la orden ya no está en MT5 (caducada o borrada)")
            entorno.log("warning", o.system, `Orden ${o.orderId}: ${o.message}`)
            guardar(o)
          } else if (ds.length > 0) guardar(o)
        } else {
          grupos.set(`${o.account}|${o.system}|${o.conId}`, { enlace: o.account, sistema: o.system, conId: o.conId })
        }
      }
      for (const g of grupos.values()) await proteger(g.enlace, g.sistema, g.conId, entorno.magic(g.sistema))
    })
  }

  /** Cancels a stopped system's waiting market orders: nobody is left to follow them. */
  const sistemaParado = (sistema: string) => {
    for (const o of [...ordenes.values()]) {
      if (o.system !== sistema || !activa(o) || o.role !== "market") continue
      const copia = { ...o, deals: [...o.deals] }
      estado(copia, "Cancelled", "el sistema se paró")
      guardar(copia)
    }
  }

  /** Panic: every working bot order ends — pending entries leave the broker — so nothing
   * reopens after the positions close. Returns how many ended and the ones that could not. */
  const cancelarTodo = () =>
    enExclusiva(async () => {
      let canceladas = 0
      const fallos: string[] = []
      for (const previa of [...ordenes.values()].filter(activa)) {
        const o = { ...previa, deals: [...previa.deals] }
        if (o.role === "entry" && o.ticket > 0) {
          const r = await entorno.comando(o.account, "DELETE", String(o.ticket))
          if (!r.ok && r.retcode !== 10036) {
            fallos.push(`${o.orderId}: ${r.message}`)
            continue
          }
        }
        estado(o, "Cancelled", "pánico")
        guardar(o)
        canceladas += 1
      }
      return { canceladas, fallos }
    })

  return {
    cancelarTodo,
    hello,
    qualify,
    bars,
    place,
    cancel,
    tick,
    positions,
    accountSummary,
    sistemaParado,
    /** The bot's orders (working and recent). */
    ordenesDe: (sistema: string) => [...ordenes.values()].filter((o) => o.system === sistema),
    /** The bot's executions. */
    ejecucionesDe: (sistema: string) => ejecuciones.filter((f) => f.system === sistema),
    /** Whether any order still needs the 1 s reconcile. */
    hayActivas: () => [...ordenes.values()].some(activa),
  }
}

export type Traductor = ReturnType<typeof crearTraductor>
