"""A fake ``MetaTrader5`` package for testing OpenBot's MT5 bridge without a broker.

Put this folder first on the bridge's PYTHONPATH (``TRADING_MT5_PYTHONPATH``) and the bridge
"attaches" to an in-process hedging demo account instead of a terminal. It is the Python twin
of DeepTrading's ``dte-sim``: prices follow a deterministic synthetic path per symbol (the
same for live ticks and for ``copy_rates_range``), pending orders trigger, stops and targets
execute, deals carry their order, entry and reason like MT5's, and the market closes from
Friday 21:00 to Sunday 22:00 UTC. Like a real broker it keeps server time, ahead of UTC by
``MT5_FALSO_DESFASE`` seconds (7200 by default), so the bridge's clock is tested too.

Environment: MT5_FALSO_LOGIN (5550001), MT5_FALSO_SERVIDOR ("OpenBot-Sim"),
MT5_FALSO_DESFASE (7200), MT5_FALSO_CERRADO=1 (every trade answers "market closed").

It never talks to anything outside this process.
"""
from __future__ import annotations

import math
import os
import time as _time
from types import SimpleNamespace as _N

__openbot_falso__ = True
__version__ = "5.0.falso"

# ----------------------------------------------------------------------------- constants (MT5's values)
TIMEFRAME_M1, TIMEFRAME_M2, TIMEFRAME_M3, TIMEFRAME_M5 = 1, 2, 3, 5
TIMEFRAME_M10, TIMEFRAME_M15, TIMEFRAME_M20, TIMEFRAME_M30 = 10, 15, 20, 30
TIMEFRAME_H1, TIMEFRAME_H2, TIMEFRAME_H3, TIMEFRAME_H4 = 16385, 16386, 16387, 16388
TIMEFRAME_H6, TIMEFRAME_H8, TIMEFRAME_H12, TIMEFRAME_D1, TIMEFRAME_W1 = 16390, 16392, 16396, 16408, 32769
ORDER_TYPE_BUY, ORDER_TYPE_SELL, ORDER_TYPE_BUY_LIMIT, ORDER_TYPE_SELL_LIMIT = 0, 1, 2, 3
ORDER_TYPE_BUY_STOP, ORDER_TYPE_SELL_STOP = 4, 5
POSITION_TYPE_BUY, POSITION_TYPE_SELL = 0, 1
DEAL_TYPE_BUY, DEAL_TYPE_SELL, DEAL_TYPE_BALANCE = 0, 1, 2
DEAL_ENTRY_IN, DEAL_ENTRY_OUT, DEAL_ENTRY_INOUT, DEAL_ENTRY_OUT_BY = 0, 1, 2, 3
DEAL_REASON_CLIENT, DEAL_REASON_EXPERT, DEAL_REASON_SL, DEAL_REASON_TP, DEAL_REASON_SO = 0, 3, 4, 5, 6
TRADE_ACTION_DEAL, TRADE_ACTION_PENDING, TRADE_ACTION_SLTP, TRADE_ACTION_MODIFY, TRADE_ACTION_REMOVE = 1, 5, 6, 7, 8
ORDER_FILLING_FOK, ORDER_FILLING_IOC, ORDER_FILLING_RETURN = 0, 1, 2
ORDER_TIME_GTC, ORDER_TIME_DAY = 0, 1
TRADE_RETCODE_PLACED, TRADE_RETCODE_DONE, TRADE_RETCODE_DONE_PARTIAL = 10008, 10009, 10010
TRADE_RETCODE_INVALID_VOLUME, TRADE_RETCODE_INVALID_PRICE, TRADE_RETCODE_INVALID_STOPS = 10014, 10015, 10016
TRADE_RETCODE_MARKET_CLOSED, TRADE_RETCODE_NO_MONEY, TRADE_RETCODE_CLIENT_DISABLES_AT = 10018, 10019, 10027
TRADE_RETCODE_POSITION_CLOSED = 10036
ACCOUNT_TRADE_MODE_DEMO, ACCOUNT_TRADE_MODE_CONTEST, ACCOUNT_TRADE_MODE_REAL = 0, 1, 2

LOGIN = int(os.environ.get("MT5_FALSO_LOGIN", "5550001"))
SERVIDOR = os.environ.get("MT5_FALSO_SERVIDOR", "OpenBot-Sim")
DESFASE = int(os.environ.get("MT5_FALSO_DESFASE", "7200"))
CERRADO = os.environ.get("MT5_FALSO_CERRADO", "") == "1"
M64 = (1 << 64) - 1

# name, base, digits, tick_size, tick_value (account money per tick per lot), contract size, profit currency
SPECS = {
    "US100": (21000.0, 2, 0.01, 0.01, 1.0, "USD"),
    "XAUUSD": (2650.0, 2, 0.01, 1.0, 100.0, "USD"),
    "US2000": (2300.0, 2, 0.01, 0.01, 1.0, "USD"),
    "USDJPY": (151.2, 3, 0.001, 0.66, 100000.0, "JPY"),
    "EURUSD": (1.085, 5, 0.00001, 1.0, 100000.0, "USD"),
}


def _hash(a: int) -> float:
    x = (a * 0x9E3779B97F4A7C15) & M64
    x ^= x >> 31
    x = (x * 0xBF58476D1CE4E5B9) & M64
    x ^= x >> 29
    return ((x >> 11) / float(1 << 53)) * 2.0 - 1.0


def _precio(nombre: str, t: float) -> float:
    """The symbol's price at a UTC second: slow waves plus minute-level noise."""
    base, digitos = SPECS[nombre][0], SPECS[nombre][1]
    semilla = 7
    for b in nombre.encode():
        semilla = (semilla * 31 + b) & M64
    k = math.floor(t / 60.0)
    f = t / 60.0 - k
    n0 = _hash(semilla ^ (k & M64))
    n1 = _hash(semilla ^ ((k + 1) & M64))
    ruido = n0 + (n1 - n0) * f
    ph = float(semilla % 1000)
    rel = (0.03 * math.sin(t / 86400.0 * 0.9 + ph) + 0.008 * math.sin(t / 5400.0 + ph)
           + 0.003 * math.sin(t / 700.0 + ph * 2) + 0.0008 * ruido)
    return round(base * (1 + rel), digitos)


def _abierto(t: int) -> bool:
    """Weekend gap like a CFD: Friday 21:00 UTC to Sunday 22:00 UTC."""
    dia = ((t // 86400) + 4) % 7  # 0 = Sunday
    h = (t % 86400) // 3600
    return not (dia == 6 or (dia == 5 and h >= 21) or (dia == 0 and h < 22))


_SEGUNDOS = {TIMEFRAME_M1: 60, TIMEFRAME_M2: 120, TIMEFRAME_M3: 180, TIMEFRAME_M5: 300, TIMEFRAME_M10: 600,
             TIMEFRAME_M15: 900, TIMEFRAME_M20: 1200, TIMEFRAME_M30: 1800, TIMEFRAME_H1: 3600, TIMEFRAME_H2: 7200,
             TIMEFRAME_H3: 10800, TIMEFRAME_H4: 14400, TIMEFRAME_H6: 21600, TIMEFRAME_H8: 28800, TIMEFRAME_H12: 43200,
             TIMEFRAME_D1: 86400, TIMEFRAME_W1: 604800}


class _Libro:
    def __init__(self) -> None:
        self.posiciones: list[dict] = []
        self.pendientes: list[dict] = []
        self.operaciones: list[dict] = []
        self.balance = 100000.0
        self.siguiente = 900000
        self.error = (1, "Success")
        ahora = _time.time()
        # The opening deposit: a balance deal the bridge must leave out of the P/L.
        self.operaciones.append({"ticket": self.id(), "order": 0, "position_id": 0, "symbol": "", "type": DEAL_TYPE_BALANCE,
                                 "volume": 0.0, "price": 0.0, "profit": 100000.0, "commission": 0.0, "swap": 0.0, "magic": 0,
                                 "comment": "deposit", "utc": ahora - 10 * 86400, "entry": DEAL_ENTRY_IN, "reason": DEAL_REASON_CLIENT})

    def id(self) -> int:
        self.siguiente += 1
        return self.siguiente

    def px(self, simbolo: str) -> float:
        return _precio(simbolo, _time.time())

    def pnl(self, p: dict, precio: float, volumen: float) -> float:
        _, _, tick, valor, _, _ = SPECS[p["symbol"]]
        d = (p["price_open"] - precio) if p["type"] == POSITION_TYPE_SELL else (precio - p["price_open"])
        return round(d / tick * valor * volumen, 2)

    def operacion(self, orden, posicion, simbolo, venta, volumen, precio, beneficio, magic, comentario, entrada, motivo) -> int:
        d = self.id()
        self.balance += beneficio
        self.operaciones.append({"ticket": d, "order": orden, "position_id": posicion, "symbol": simbolo,
                                 "type": DEAL_TYPE_SELL if venta else DEAL_TYPE_BUY, "volume": volumen, "price": precio,
                                 "profit": beneficio, "commission": 0.0, "swap": 0.0, "magic": magic, "comment": comentario,
                                 "utc": _time.time(), "entry": entrada, "reason": motivo})
        return d

    def abrir(self, orden, simbolo, venta, volumen, magic, comentario):
        precio = self.px(simbolo)
        t = self.id()
        self.posiciones.append({"ticket": t, "symbol": simbolo, "type": POSITION_TYPE_SELL if venta else POSITION_TYPE_BUY,
                                "volume": volumen, "price_open": precio, "sl": 0.0, "tp": 0.0, "magic": magic,
                                "comment": comentario, "utc": _time.time()})
        d = self.operacion(orden, t, simbolo, venta, volumen, precio, 0.0, magic, comentario, DEAL_ENTRY_IN, DEAL_REASON_EXPERT)
        return d, precio

    def cerrar(self, ticket, volumen, motivo):
        p = next((x for x in self.posiciones if x["ticket"] == ticket), None)
        if p is None:
            return None
        precio = p["sl"] if motivo == DEAL_REASON_SL else p["tp"] if motivo == DEAL_REASON_TP else self.px(p["symbol"])
        v = min(volumen, p["volume"])
        beneficio = self.pnl(p, precio, v)
        if v >= p["volume"] - 1e-9:
            self.posiciones.remove(p)
        else:
            p["volume"] = round(p["volume"] - v, 8)
        d = self.operacion(self.id(), p["ticket"], p["symbol"], p["type"] == POSITION_TYPE_BUY, v, precio, beneficio, p["magic"],
                           p["comment"], DEAL_ENTRY_OUT, motivo)
        return d, precio, v

    def paso(self) -> None:
        """Pending orders that trigger and stops/targets that execute at the current prices."""
        if CERRADO or not _abierto(int(_time.time())):
            return
        for o in list(self.pendientes):
            px = self.px(o["symbol"])
            compra = o["type"] in (ORDER_TYPE_BUY_STOP, ORDER_TYPE_BUY_LIMIT)
            stop = o["type"] in (ORDER_TYPE_BUY_STOP, ORDER_TYPE_SELL_STOP)
            toca = (px >= o["price"] if stop else px <= o["price"]) if compra else (px <= o["price"] if stop else px >= o["price"])
            if toca:
                self.pendientes.remove(o)
                self.abrir(o["ticket"], o["symbol"], not compra, o["volume"], o["magic"], o["comment"])
        for p in list(self.posiciones):
            px = self.px(p["symbol"])
            venta = p["type"] == POSITION_TYPE_SELL
            sl = p["sl"] > 0 and (px >= p["sl"] if venta else px <= p["sl"])
            tp = p["tp"] > 0 and (px <= p["tp"] if venta else px >= p["tp"])
            if sl:
                self.cerrar(p["ticket"], p["volume"], DEAL_REASON_SL)
            elif tp:
                self.cerrar(p["ticket"], p["volume"], DEAL_REASON_TP)


_libro = _Libro()
_iniciado = False


def _servidor(utc: float) -> float:
    return utc + DESFASE


# ----------------------------------------------------------------------------- the package's API

def initialize(*args, **kwargs) -> bool:
    global _iniciado
    _iniciado = True
    return True


def shutdown() -> None:
    global _iniciado
    _iniciado = False


def last_error():
    return _libro.error


def version():
    return (500, 4000, "falso")


def terminal_info():
    if not _iniciado:
        return None
    return _N(trade_allowed=True, build=4000, connected=True, name="MetaTrader 5 (falso)", company="OpenBot")


def account_info():
    if not _iniciado:
        return None
    _libro.paso()
    flotante = sum(_libro.pnl(p, _libro.px(p["symbol"]), p["volume"]) for p in _libro.posiciones)
    margen = 120.0 * len(_libro.posiciones)
    equity = _libro.balance + flotante
    return _N(login=LOGIN, server=SERVIDOR, name="Simulador OpenBot", company="OpenBot", currency="USD", leverage=100,
              trade_mode=ACCOUNT_TRADE_MODE_DEMO, balance=round(_libro.balance, 2), equity=round(equity, 2),
              profit=round(flotante, 2), margin=margen, margin_free=round(equity - margen, 2),
              margin_level=round(equity / margen * 100, 2) if margen else 0.0)


def _posicion(p: dict):
    px = _libro.px(p["symbol"])
    t = _servidor(p["utc"])
    return _N(ticket=p["ticket"], identifier=p["ticket"], symbol=p["symbol"], type=p["type"], volume=p["volume"],
              price_open=p["price_open"], price_current=px, sl=p["sl"], tp=p["tp"], profit=_libro.pnl(p, px, p["volume"]),
              swap=0.0, magic=p["magic"], comment=p["comment"], time=int(t), time_msc=int(t * 1000))


def positions_get(symbol=None, group=None, ticket=None):
    if not _iniciado:
        return None
    _libro.paso()
    return tuple(_posicion(p) for p in _libro.posiciones
                 if (ticket is None or p["ticket"] == ticket) and (symbol is None or p["symbol"] == symbol))


def positions_total():
    return len(_libro.posiciones)


def orders_get(symbol=None, group=None, ticket=None):
    if not _iniciado:
        return None
    _libro.paso()
    return tuple(_N(ticket=o["ticket"], symbol=o["symbol"], type=o["type"], volume_initial=o["volume"],
                    volume_current=o["volume"], price_open=o["price"], magic=o["magic"], comment=o["comment"])
                 for o in _libro.pendientes
                 if (ticket is None or o["ticket"] == ticket) and (symbol is None or o["symbol"] == symbol))


def history_deals_get(date_from, date_to, group=None):
    if not _iniciado:
        return None
    _libro.paso()
    desde, hasta = float(date_from), float(date_to)
    salida = []
    for d in _libro.operaciones:
        t = _servidor(d["utc"])
        if desde <= t <= hasta:
            salida.append(_N(ticket=d["ticket"], order=d["order"], position_id=d["position_id"], symbol=d["symbol"],
                             type=d["type"], volume=d["volume"], price=d["price"], profit=d["profit"],
                             commission=d["commission"], swap=d["swap"], magic=d["magic"], comment=d["comment"],
                             time=int(t), time_msc=int(t * 1000), entry=d["entry"], reason=d["reason"]))
    return tuple(salida)


def symbol_select(symbol, enable=True) -> bool:
    return symbol in SPECS


def symbol_info(symbol):
    if symbol not in SPECS:
        return None
    base, digitos, tick, valor, contrato, moneda = SPECS[symbol]
    px = _libro.px(symbol)
    return _N(name=symbol, digits=digitos, trade_contract_size=contrato, trade_tick_size=tick, trade_tick_value=valor,
              volume_min=0.01, volume_step=0.01, volume_max=100.0, currency_profit=moneda, bid=px, ask=px,
              filling_mode=3, visible=True)


def symbol_info_tick(symbol):
    if symbol not in SPECS:
        return None
    ahora = _time.time()
    # A closed market keeps its last tick: the bridge's clock must not read a stale one.
    t = ahora if _abierto(int(ahora)) else ahora - 3600
    px = _precio(symbol, t)
    return _N(time=int(_servidor(t)), time_msc=int(_servidor(t) * 1000), bid=px, ask=px, last=px, volume=0)


def symbols_get(group=None):
    return tuple(symbol_info(s) for s in SPECS)


def copy_rates_range(symbol, timeframe, date_from, date_to):
    paso = _SEGUNDOS.get(timeframe)
    if symbol not in SPECS or paso is None:
        _libro.error = (-2, "Invalid params")
        return None
    desde = int(float(date_from.timestamp() if hasattr(date_from, "timestamp") else date_from)) - DESFASE
    hasta = min(int(float(date_to.timestamp() if hasattr(date_to, "timestamp") else date_to)) - DESFASE, int(_time.time()))
    t = desde - desde % paso
    salida = []
    while t <= hasta and len(salida) < 60000:
        if _abierto(t):
            muestras = [_precio(symbol, min(t + paso * k / 6.0, hasta)) for k in range(7)]
            salida.append({"time": t + DESFASE, "open": muestras[0], "high": max(muestras), "low": min(muestras),
                           "close": muestras[6], "tick_volume": 100, "spread": 0, "real_volume": 0})
        t += paso
    return salida


def _hecho(retcode, comment, order=0, deal=0, price=0.0, volume=0.0):
    return _N(retcode=retcode, comment=comment, order=order, deal=deal, price=price, volume=volume, request_id=0)


def order_send(request):
    if not _iniciado:
        _libro.error = (-10004, "No IPC connection")
        return None
    _libro.paso()
    accion = request.get("action")
    if CERRADO or not _abierto(int(_time.time())):
        return _hecho(TRADE_RETCODE_MARKET_CLOSED, "Market closed")
    simbolo = request.get("symbol", "")
    if accion == TRADE_ACTION_DEAL:
        if simbolo not in SPECS:
            return _hecho(10013, "Invalid request")
        volumen = float(request.get("volume", 0.0))
        if volumen <= 0:
            return _hecho(TRADE_RETCODE_INVALID_VOLUME, "Invalid volume")
        posicion = request.get("position")
        if posicion:
            hecho = _libro.cerrar(int(posicion), volumen, DEAL_REASON_EXPERT)
            if hecho is None:
                return _hecho(TRADE_RETCODE_POSITION_CLOSED, "Position doesn't exist")
            d, precio, v = hecho
            return _hecho(TRADE_RETCODE_DONE, "Request executed", _libro.id(), d, precio, v)
        o = _libro.id()
        d, precio = _libro.abrir(o, simbolo, request.get("type") == ORDER_TYPE_SELL, volumen, int(request.get("magic", 0)),
                                 str(request.get("comment", "")))
        return _hecho(TRADE_RETCODE_DONE, "Request executed", o, d, precio, volumen)
    if accion == TRADE_ACTION_PENDING:
        if simbolo not in SPECS:
            return _hecho(10013, "Invalid request")
        tipo, precio = request.get("type"), float(request.get("price", 0.0))
        px = _libro.px(simbolo)
        valido = {ORDER_TYPE_BUY_STOP: precio > px, ORDER_TYPE_BUY_LIMIT: precio < px,
                  ORDER_TYPE_SELL_STOP: precio < px, ORDER_TYPE_SELL_LIMIT: precio > px}.get(tipo, False)
        if not valido:
            return _hecho(TRADE_RETCODE_INVALID_PRICE, "Invalid price")
        t = _libro.id()
        _libro.pendientes.append({"ticket": t, "symbol": simbolo, "type": tipo, "volume": float(request.get("volume", 0.0)),
                                  "price": precio, "magic": int(request.get("magic", 0)), "comment": str(request.get("comment", ""))})
        return _hecho(TRADE_RETCODE_PLACED, "Request placed", t)
    if accion == TRADE_ACTION_SLTP:
        ticket = int(request.get("position", 0))
        p = next((x for x in _libro.posiciones if x["ticket"] == ticket), None)
        if p is None:
            return _hecho(TRADE_RETCODE_POSITION_CLOSED, "Position doesn't exist")
        sl, tp = float(request.get("sl", 0.0)), float(request.get("tp", 0.0))
        px = _libro.px(p["symbol"])
        venta = p["type"] == POSITION_TYPE_SELL
        malo = (sl > 0 and (sl <= px if venta else sl >= px)) or (tp > 0 and (tp >= px if venta else tp <= px))
        if malo:
            return _hecho(TRADE_RETCODE_INVALID_STOPS, "Invalid stops")
        p["sl"], p["tp"] = sl, tp
        return _hecho(TRADE_RETCODE_DONE, "Request executed")
    if accion == TRADE_ACTION_REMOVE:
        ticket = int(request.get("order", 0))
        antes = len(_libro.pendientes)
        _libro.pendientes = [o for o in _libro.pendientes if o["ticket"] != ticket]
        if len(_libro.pendientes) == antes:
            return _hecho(10013, "Invalid request")
        return _hecho(TRADE_RETCODE_DONE, "Request executed")
    return _hecho(10013, "Invalid request")
