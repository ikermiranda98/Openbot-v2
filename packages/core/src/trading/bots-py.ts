// OpenBot's stand-in for `ib_async` (and its old name `ib_insync`), ported from DeepTrading.
// The engine writes these files into its data folder and puts that folder first on the
// PYTHONPATH of every bot it starts against a MetaTrader 5 account: the bot's
// `from ib_async import IB, �` resolves here, and every call reaches the engine's local bot
// API (`/bot/*`, see `servidor-bots.ts`) with the system's own token instead of TWS.
//
// Environment the engine sets: OPENBOT_BOT_TOKEN (the system's token), OPENBOT_ENGINE_URL
// (the API's address at launch) and OPENBOT_ENGINE_FILE (a JSON file `{ "api": url }` the
// stand-in re-reads when the address stops answering, e.g. after an app restart).
export const IB_ASYNC_INIT = String.raw`"""OpenBot's stand-in for 'ib_async'.

The OpenBot engine puts this package first on a bot's 'PYTHONPATH' when it
starts it, so 'from ib_async import IB, Future, MarketOrder...' keeps working
unchanged while every call goes to the engine (and from there to MetaTrader 5)
instead of TWS. Only the part of the API the bots use is here, with the same
names, fields and behaviour:

* 'IB.connect' / 'disconnect' / 'isConnected' / 'managedAccounts' /
  'accountSummary' / 'positions'
* 'qualifyContracts' / 'reqContractDetails' / 'reqHistoricalData'
* 'placeOrder' / 'cancelOrder' / 'openTrades' / 'trades' /
  'reqCompletedOrders' / 'reqExecutions' / 'fills' / 'executions'
* 'sleep' (keeps the orders' status current, like the real event loop)

Contracts become the engine's MT5 symbol ('MNQ' -> 'US100'...), quantities
keep the same exposure, and order statuses follow IBKR's ('Submitted',
'Filled', 'Cancelled', 'Inactive').
"""
from __future__ import annotations

import datetime as _dt
import json as _json
import logging as _logging
import os as _os
import sys as _sys
import time as _time
import urllib.error as _uerr
import urllib.request as _ureq
from collections import namedtuple as _namedtuple

from . import util  # noqa: F401  ('from ib_async import util')

__version__ = "2.1.0+openbot"
__all__ = [
    "IB", "Contract", "Stock", "Future", "ContFuture", "Forex", "CFD", "Index", "Commodity",
    "Order", "MarketOrder", "LimitOrder", "StopOrder", "StopLimitOrder", "OrderStatus", "Trade",
    "Fill", "Execution", "CommissionReport", "Position", "AccountValue", "BarData", "BarDataList",
    "ContractDetails", "ExecutionFilter", "util",
]

_log = _logging.getLogger("ib_async")
UNSET_DOUBLE = _sys.float_info.max
UNSET_INTEGER = 2 ** 31 - 1
_ACTIVE = ("PendingSubmit", "ApiPending", "PreSubmitted", "Submitted")
_DONE = ("Filled", "Cancelled", "ApiCancelled", "Inactive")


# ----------------------------------------------------------------------------- engine

class _EngineError(Exception):
    pass


class _Engine:
    """The engine's bot API: address from the environment, refreshed from the engine's file after a restart."""

    def __init__(self) -> None:
        self.url = _os.environ.get("OPENBOT_ENGINE_URL", "")
        self.token = _os.environ.get("OPENBOT_BOT_TOKEN", "")
        self.file = _os.environ.get("OPENBOT_ENGINE_FILE", "")
        if not self.url:
            self._reload()

    def _reload(self) -> None:
        try:
            with open(self.file, encoding="utf-8") as fh:
                self.url = _json.load(fh).get("api", self.url)
        except Exception:
            pass

    def call(self, method: str, path: str, body=None, timeout: float = 90.0, tries: int = 15):
        data = None if body is None else _json.dumps(body).encode("utf-8")
        last = None
        for attempt in range(max(1, tries)):
            if not self.url:
                self._reload()
            req = _ureq.Request(self.url + path, data=data, method=method,
                                headers={"Content-Type": "application/json", "X-OpenBot-Bot": self.token})
            try:
                with _ureq.urlopen(req, timeout=timeout) as resp:
                    return _json.loads(resp.read().decode("utf-8") or "null")
            except _uerr.HTTPError as e:
                try:
                    msg = _json.loads(e.read().decode("utf-8")).get("error", str(e))
                except Exception:
                    msg = str(e)
                raise _EngineError(msg) from None
            except (_uerr.URLError, ConnectionError, TimeoutError, OSError) as e:
                last = e
                self._reload()  # the app restarted: new port
                if attempt + 1 < tries:
                    _time.sleep(2)
        raise ConnectionRefusedError(f"OpenBot: el motor no responde ({last})")


_engine = _Engine()


def _utc(ms) -> _dt.datetime:
    return _dt.datetime.fromtimestamp((ms or 0) / 1000.0, tz=_dt.timezone.utc)


# ----------------------------------------------------------------------------- objects

class _Obj:
    _defaults: dict = {}

    def __init__(self, *args, **kwargs):
        for k, v in self._defaults.items():
            setattr(self, k, list(v) if isinstance(v, list) else v)
        names = list(self._defaults)
        for name, value in zip(names, args):
            setattr(self, name, value)
        for k, v in kwargs.items():
            setattr(self, k, v)

    def __repr__(self):
        shown = {k: getattr(self, k) for k in self._defaults if getattr(self, k) != self._defaults[k]}
        return f"{type(self).__name__}({', '.join(f'{k}={v!r}' for k, v in shown.items())})"

    def dict(self):
        return {k: getattr(self, k) for k in self._defaults}


class Contract(_Obj):
    _defaults = dict(secType="", conId=0, symbol="", lastTradeDateOrContractMonth="", strike=0.0, right="",
                     multiplier="", exchange="", primaryExchange="", currency="", localSymbol="", tradingClass="",
                     includeExpired=False, secIdType="", secId="", description="", issuerId="",
                     comboLegsDescrip="", comboLegs=[], deltaNeutralContract=None)

    def __eq__(self, other):
        return isinstance(other, Contract) and self.conId != 0 and self.conId == other.conId

    def __hash__(self):
        return hash(self.conId) if self.conId else id(self)

    def isHashable(self):
        return self.conId != 0


class Stock(Contract):
    def __init__(self, symbol="", exchange="", currency="", **kwargs):
        super().__init__(secType="STK", symbol=symbol, exchange=exchange, currency=currency, **kwargs)


class Future(Contract):
    def __init__(self, symbol="", lastTradeDateOrContractMonth="", exchange="", localSymbol="", multiplier="",
                 currency="", **kwargs):
        super().__init__(secType="FUT", symbol=symbol, lastTradeDateOrContractMonth=lastTradeDateOrContractMonth,
                         exchange=exchange, localSymbol=localSymbol, multiplier=multiplier, currency=currency, **kwargs)


class ContFuture(Contract):
    def __init__(self, symbol="", exchange="", localSymbol="", multiplier="", currency="", **kwargs):
        super().__init__(secType="CONTFUT", symbol=symbol, exchange=exchange, localSymbol=localSymbol,
                         multiplier=multiplier, currency=currency, **kwargs)


class Forex(Contract):
    def __init__(self, pair="", exchange="IDEALPRO", symbol="", currency="", **kwargs):
        if pair:
            symbol, currency = pair[:3], pair[3:]
        super().__init__(secType="CASH", symbol=symbol, exchange=exchange, currency=currency, **kwargs)

    def pair(self):
        return self.symbol + self.currency


class CFD(Contract):
    def __init__(self, symbol="", exchange="", currency="", **kwargs):
        super().__init__(secType="CFD", symbol=symbol, exchange=exchange, currency=currency, **kwargs)


class Index(Contract):
    def __init__(self, symbol="", exchange="", currency="", **kwargs):
        super().__init__(secType="IND", symbol=symbol, exchange=exchange, currency=currency, **kwargs)


class Commodity(Contract):
    def __init__(self, symbol="", exchange="", currency="", **kwargs):
        super().__init__(secType="CMDTY", symbol=symbol, exchange=exchange, currency=currency, **kwargs)


class ContractDetails(_Obj):
    _defaults = dict(contract=None, marketName="", minTick=0.0, longName="", timeZoneId="", tradingHours="",
                     liquidHours="", contractMonth="", realExpirationDate="")


class Order(_Obj):
    _defaults = dict(orderId=0, clientId=0, permId=0, action="", totalQuantity=0.0, orderType="",
                     lmtPrice=UNSET_DOUBLE, auxPrice=UNSET_DOUBLE, tif="", ocaGroup="", ocaType=0, orderRef="",
                     transmit=True, parentId=0, outsideRth=False, goodTillDate="", goodAfterTime="", account="")


class MarketOrder(Order):
    def __init__(self, action, totalQuantity, **kwargs):
        super().__init__(orderType="MKT", action=action, totalQuantity=totalQuantity, **kwargs)


class LimitOrder(Order):
    def __init__(self, action, totalQuantity, lmtPrice, **kwargs):
        super().__init__(orderType="LMT", action=action, totalQuantity=totalQuantity, lmtPrice=lmtPrice, **kwargs)


class StopOrder(Order):
    def __init__(self, action, totalQuantity, stopPrice, **kwargs):
        super().__init__(orderType="STP", action=action, totalQuantity=totalQuantity, auxPrice=stopPrice, **kwargs)


class StopLimitOrder(Order):
    def __init__(self, action, totalQuantity, lmtPrice, stopPrice, **kwargs):
        super().__init__(orderType="STP LMT", action=action, totalQuantity=totalQuantity, lmtPrice=lmtPrice,
                         auxPrice=stopPrice, **kwargs)


class OrderStatus(_Obj):
    _defaults = dict(orderId=0, status="", filled=0.0, remaining=0.0, avgFillPrice=0.0, permId=0, parentId=0,
                     lastFillPrice=0.0, clientId=0, whyHeld="", mktCapPrice=0.0)


class Execution(_Obj):
    _defaults = dict(execId="", time=None, acctNumber="", exchange="", side="", shares=0.0, price=0.0, permId=0,
                     clientId=0, orderId=0, liquidation=0, cumQty=0.0, avgPrice=0.0, orderRef="", evRule="",
                     evMultiplier=0.0, modelCode="", lastLiquidity=0)


class CommissionReport(_Obj):
    _defaults = dict(execId="", commission=0.0, currency="", realizedPNL=0.0, yield_=0.0, yieldRedemptionDate=0)


class Fill(_Obj):
    _defaults = dict(contract=None, execution=None, commissionReport=None, time=None)


class TradeLogEntry(_Obj):
    _defaults = dict(time=None, status="", message="", errorCode=0)


class Trade(_Obj):
    _defaults = dict(contract=None, order=None, orderStatus=None, fills=[], log=[], advancedError="")

    def isActive(self):
        return self.orderStatus.status in _ACTIVE

    def isDone(self):
        return self.orderStatus.status in _DONE

    def filled(self):
        return self.orderStatus.filled

    def remaining(self):
        return self.order.totalQuantity - self.orderStatus.filled


class ExecutionFilter(_Obj):
    _defaults = dict(clientId=0, acctCode="", time="", symbol="", secType="", exchange="", side="")


Position = _namedtuple("Position", "account contract position avgCost")
AccountValue = _namedtuple("AccountValue", "account tag value currency modelCode")


class BarData(_Obj):
    _defaults = dict(date=None, open=0.0, high=0.0, low=0.0, close=0.0, volume=0.0, average=0.0, barCount=0)


class BarDataList(list):
    def __init__(self, *args):
        super().__init__(*args)
        self.reqId = 0
        self.contract = None
        self.endDateTime = None
        self.durationStr = ""
        self.barSizeSetting = ""
        self.whatToShow = ""
        self.useRTH = True
        self.formatDate = 1
        self.keepUpToDate = False
        self.chartOptions = []


class _Event:
    """Enough of eventkit's Event for 'ib.errorEvent += handler'."""

    def __init__(self, name=""):
        self.name = name
        self._handlers = []

    def __iadd__(self, handler):
        self._handlers.append(handler)
        return self

    def __isub__(self, handler):
        if handler in self._handlers:
            self._handlers.remove(handler)
        return self

    connect = __iadd__
    disconnect = __isub__

    def emit(self, *args):
        for h in list(self._handlers):
            try:
                h(*args)
            except Exception:
                _log.exception("error en un manejador de %s", self.name)


# ----------------------------------------------------------------------------- IB

def _end_seconds(end) -> int | None:
    """IB's endDateTime ('' = now, 'YYYYMMDD-HH:MM:SS' UTC, 'YYYYMMDD HH:MM:SS [tz]', datetime or date) -> UTC seconds."""
    if end in (None, ""):
        return None
    if isinstance(end, _dt.datetime):
        if end.tzinfo is None:
            end = end.astimezone()
        return int(end.timestamp())
    if isinstance(end, _dt.date):
        return int(_dt.datetime.combine(end, _dt.time(23, 59, 59)).astimezone().timestamp())
    text = str(end).strip()
    if "-" in text[:9]:
        return int(_dt.datetime.strptime(text[:17], "%Y%m%d-%H:%M:%S").replace(tzinfo=_dt.timezone.utc).timestamp())
    parts = text.split()
    base = _dt.datetime.strptime(" ".join(parts[:2]), "%Y%m%d %H:%M:%S")
    if len(parts) > 2:
        try:
            import zoneinfo
            return int(base.replace(tzinfo=zoneinfo.ZoneInfo(parts[2])).timestamp())
        except Exception:
            pass
    return int(base.astimezone().timestamp())


class IB:
    """The 'ib_async.IB' the bots use, backed by the OpenBot engine."""

    RequestTimeout = 0.0
    RaiseRequestErrors = False
    MaxSyncedSubAccounts = 50

    def __init__(self):
        self._connected = False
        self.clientId = 0
        self._accounts: list[str] = []
        self._trades: dict[int, Trade] = {}
        self._contracts: dict[int, Contract] = {}
        self._last_sync = 0.0
        self._local_id = -1
        self.errorEvent = _Event("errorEvent")
        self.orderStatusEvent = _Event("orderStatusEvent")
        self.execDetailsEvent = _Event("execDetailsEvent")
        self.connectedEvent = _Event("connectedEvent")
        self.disconnectedEvent = _Event("disconnectedEvent")
        self.newOrderEvent = _Event("newOrderEvent")
        self.updateEvent = _Event("updateEvent")
        self.pendingTickersEvent = _Event("pendingTickersEvent")

    def __repr__(self):
        return f"<IB {'connected' if self._connected else 'not connected'} via OpenBot (clientId={self.clientId})>"

    # -- connection
    def connect(self, host="127.0.0.1", port=7497, clientId=1, timeout=4, readonly=False, account="",
                raiseSyncErrors=False, fetchFields=None):
        if not _engine.token:
            raise ConnectionRefusedError("OpenBot: este bot no lo arrancó el motor (falta OPENBOT_BOT_TOKEN)")
        try:
            hello = _engine.call("GET", "/bot/hello", tries=3, timeout=15)
        except _EngineError as e:
            raise ConnectionRefusedError(f"OpenBot: {e}") from None
        self._connected = True
        self.clientId = clientId
        self._accounts = list(hello.get("accounts", []))
        _log.info("Conectado a OpenBot (%s, cuenta %s, magic %s) en lugar de TWS %s:%s",
                  hello.get("broker", "mt5").upper(), hello.get("account"), hello.get("magic"), host, port)
        self._sync(force=True)
        self.connectedEvent.emit()
        return self

    async def connectAsync(self, *args, **kwargs):
        return self.connect(*args, **kwargs)

    def disconnect(self):
        if self._connected:
            self._connected = False
            self.disconnectedEvent.emit()

    def isConnected(self):
        return self._connected

    def managedAccounts(self):
        return list(self._accounts)

    # -- time
    def sleep(self, secs: float = 0.02) -> bool:
        end = _time.monotonic() + max(0.0, float(secs))
        while True:
            self._sync()
            left = end - _time.monotonic()
            if left <= 0:
                return True
            _time.sleep(min(0.5, left))

    def waitOnUpdate(self, timeout: float = 0) -> bool:
        self.sleep(min(timeout or 1.0, 1.0))
        return True

    def reqCurrentTime(self):
        return _dt.datetime.now(_dt.timezone.utc)

    def reqMarketDataType(self, marketDataType):
        pass

    def run(self, *awaitables, timeout=None):
        if not awaitables:
            while True:
                self.sleep(1)
        return None

    # -- account
    def accountSummary(self, account=""):
        return [AccountValue(v["account"], v["tag"], v["value"], v["currency"], v.get("modelCode", ""))
                for v in _engine.call("GET", "/bot/account")]

    reqAccountSummary = accountSummary

    def accountValues(self, account=""):
        return self.accountSummary(account)

    def positions(self, account=""):
        out = []
        for p in _engine.call("GET", "/bot/positions"):
            c = self._contract_from(p["contract"])
            out.append(Position(p["account"], c, p["position"], p["avgCost"]))
        return out

    reqPositions = positions

    def portfolio(self, account=""):
        return []

    # -- contracts
    def _contract_from(self, d: dict) -> Contract:
        c = self._contracts.get(d.get("conId", 0))
        if c is None:
            c = Contract()
            for k in ("conId", "secType", "symbol", "currency", "exchange", "localSymbol", "tradingClass",
                      "multiplier", "lastTradeDateOrContractMonth"):
                if k in d:
                    setattr(c, k, d[k])
            self._contracts[c.conId] = c
        return c

    def qualifyContracts(self, *contracts):
        done = []
        for c in contracts:
            try:
                d = _engine.call("POST", "/bot/qualify", {"secType": c.secType, "symbol": c.symbol,
                                                          "currency": c.currency, "exchange": c.exchange,
                                                          "conId": c.conId})
            except _EngineError as e:
                _log.error("Error 200, reqId 0: %s, contract: %r", e, c)
                self.errorEvent.emit(0, 200, str(e), c)
                continue
            for k in ("conId", "symbol", "currency", "localSymbol", "tradingClass", "multiplier",
                      "lastTradeDateOrContractMonth"):
                setattr(c, k, d.get(k, getattr(c, k)))
            if not c.exchange:
                c.exchange = d.get("exchange", "")
            self._contracts.setdefault(c.conId, c)
            done.append(c)
        return done

    async def qualifyContractsAsync(self, *contracts):
        return self.qualifyContracts(*contracts)

    def reqContractDetails(self, contract):
        if not contract.conId:
            if not self.qualifyContracts(contract):
                return []
        return [ContractDetails(contract=contract, marketName=contract.tradingClass, timeZoneId="UTC")]

    # -- data
    def reqHistoricalData(self, contract, endDateTime="", durationStr="1 D", barSizeSetting="1 hour",
                          whatToShow="TRADES", useRTH=True, formatDate=1, keepUpToDate=False, chartOptions=None,
                          timeout=60):
        if not contract.conId and not self.qualifyContracts(contract):
            return BarDataList()
        try:
            rows = _engine.call("POST", "/bot/bars", {"conId": contract.conId, "end": _end_seconds(endDateTime),
                                                      "duration": durationStr, "barSize": barSizeSetting})
        except _EngineError as e:
            _log.error("Error 162, reqId 0: Historical Market Data Service error message: %s", e)
            self.errorEvent.emit(0, 162, str(e), contract)
            return BarDataList()
        daily = "day" in barSizeSetting or "week" in barSizeSetting or "month" in barSizeSetting
        bars = BarDataList()
        for ms, o, h, l, c, v in rows:
            t = _utc(ms)
            if daily:
                t = t.date()
            elif formatDate != 2:
                t = t.astimezone()
            bars.append(BarData(date=t, open=o, high=h, low=l, close=c, volume=v, average=(h + l + c) / 3.0, barCount=0))
        bars.contract, bars.endDateTime, bars.durationStr = contract, endDateTime, durationStr
        bars.barSizeSetting, bars.whatToShow, bars.useRTH, bars.formatDate = barSizeSetting, whatToShow, useRTH, formatDate
        return bars

    async def reqHistoricalDataAsync(self, *args, **kwargs):
        return self.reqHistoricalData(*args, **kwargs)

    # -- orders
    def _apply(self, d: dict) -> Trade:
        oid = d["orderId"]
        t = self._trades.get(oid)
        if t is None:
            c = self._contracts.get(d["conId"]) or self._contract_from({"conId": d["conId"], "localSymbol": d["symbol"]})
            o = Order(orderId=oid, clientId=d.get("clientId", 0), permId=d["permId"], action=d["action"],
                      totalQuantity=d["qty"], orderType=d["orderType"], tif=d["tif"], ocaGroup=d["ocaGroup"])
            if d["orderType"] == "STP":
                o.auxPrice = d["auxPrice"]
            if d["orderType"] == "LMT":
                o.lmtPrice = d["lmtPrice"]
            t = Trade(contract=c, order=o, orderStatus=OrderStatus(orderId=oid, permId=d["permId"]), fills=[], log=[])
            self._trades[oid] = t
        before = (t.orderStatus.status, t.orderStatus.filled)
        s = t.orderStatus
        s.status, s.filled, s.avgFillPrice = d["status"], d["filled"], d["avgFillPrice"]
        s.remaining = max(0.0, d["qty"] - d["filled"])
        s.permId = d["permId"]
        t.order.permId = d["permId"]
        if d["filled"]:
            s.lastFillPrice = d["avgFillPrice"]
        if (s.status, s.filled) != before:
            t.log.append(TradeLogEntry(time=_dt.datetime.now(_dt.timezone.utc), status=s.status, message=d.get("message", "")))
            if d.get("message") and s.status == "Inactive":
                _log.warning("Orden %s %s: %s", oid, s.status, d["message"])
            elif d.get("message") and s.status == "Cancelled":
                _log.info("Orden %s %s: %s", oid, s.status, d["message"])
            self.orderStatusEvent.emit(t)
        return t

    def _sync(self, force: bool = False):
        now = _time.monotonic()
        if not self._connected or (not force and now - self._last_sync < 1.0):
            return
        if not force and not any(t.isActive() for t in self._trades.values()):
            if now - self._last_sync < 5.0:
                return
        self._last_sync = now
        try:
            for d in _engine.call("GET", "/bot/orders", tries=1, timeout=10):
                self._apply(d)
        except Exception as e:  # the app may be closed for a moment: keep the last known state
            _log.debug("sin respuesta del motor: %s", e)

    def placeOrder(self, contract, order) -> Trade:
        if not contract.conId and not self.qualifyContracts(contract):
            return self._rejected(contract, order, "contrato no cualificado")
        body = {
            "orderId": order.orderId if order.orderId in self._trades else 0,
            "clientId": self.clientId,
            "conId": contract.conId,
            "action": order.action,
            "orderType": order.orderType,
            "totalQuantity": float(order.totalQuantity),
            "auxPrice": 0.0 if order.auxPrice in (None, UNSET_DOUBLE) else float(order.auxPrice),
            "lmtPrice": 0.0 if order.lmtPrice in (None, UNSET_DOUBLE) else float(order.lmtPrice),
            "tif": order.tif or "DAY",
            "ocaGroup": order.ocaGroup or "",
        }
        try:
            d = _engine.call("POST", "/bot/order", body)
        except _EngineError as e:
            return self._rejected(contract, order, str(e))
        new = d["orderId"] not in self._trades
        order.orderId, order.permId, order.clientId = d["orderId"], d["permId"], self.clientId
        t = self._trades.get(d["orderId"])
        if t is None:
            self._contracts.setdefault(contract.conId, contract)
            t = Trade(contract=contract, order=order, orderStatus=OrderStatus(orderId=order.orderId), fills=[], log=[])
            self._trades[order.orderId] = t
        else:
            t.order = order
        self._apply(d)
        if new:
            self.newOrderEvent.emit(t)
        return t

    def _rejected(self, contract, order, message) -> Trade:
        oid = self._local_id
        self._local_id -= 1
        order.orderId = oid
        _log.error("Error 201, reqId %s: Order rejected - reason: %s", oid, message)
        self.errorEvent.emit(oid, 201, message, contract)
        t = Trade(contract=contract, order=order,
                  orderStatus=OrderStatus(orderId=oid, status="Inactive", remaining=order.totalQuantity), fills=[],
                  log=[TradeLogEntry(time=_dt.datetime.now(_dt.timezone.utc), status="Inactive", message=message, errorCode=201)])
        self._trades[oid] = t
        return t

    def cancelOrder(self, order, manualCancelOrderTime=""):
        t = self._trades.get(order.orderId)
        if order.orderId <= 0:
            return t
        try:
            d = _engine.call("POST", "/bot/cancel", {"orderId": order.orderId})
            return self._apply(d)
        except _EngineError as e:
            _log.error("Error 10147, reqId %s: %s", order.orderId, e)
            return t

    def reqGlobalCancel(self):
        for t in self.openTrades():
            self.cancelOrder(t.order)

    def trades(self):
        self._sync(force=True)
        return list(self._trades.values())

    def openTrades(self):
        return [t for t in self.trades() if t.isActive()]

    def orders(self):
        return [t.order for t in self.trades()]

    def openOrders(self):
        return [t.order for t in self.openTrades()]

    def reqOpenOrders(self):
        return self.openOrders()

    def reqAllOpenOrders(self):
        return self.openOrders()

    def reqCompletedOrders(self, apiOnly: bool = False):
        return [t for t in self.trades() if t.isDone() and t.order.orderId > 0]

    # -- executions
    def _fills(self):
        out = []
        for f in _engine.call("GET", "/bot/fills"):
            c = self._contracts.get(f["conId"]) or self._contract_from({"conId": f["conId"], "localSymbol": f["symbol"]})
            when = _utc(f["time"])
            ex = Execution(execId=f["execId"], time=when, acctNumber=f.get("account", ""), side=f["side"],
                           shares=f["shares"], price=f["price"], permId=f["permId"], clientId=f.get("clientId", 0),
                           orderId=f["orderId"], cumQty=f["shares"], avgPrice=f["price"])
            out.append(Fill(contract=c, execution=ex, commissionReport=CommissionReport(execId=f["execId"]), time=when))
        return out

    def reqExecutions(self, execFilter=None):
        fills = self._fills()
        if execFilter is not None:
            if getattr(execFilter, "clientId", 0):
                fills = [f for f in fills if f.execution.clientId == execFilter.clientId]
            if getattr(execFilter, "side", ""):
                fills = [f for f in fills if f.execution.side.startswith(execFilter.side[:1])]
        return fills

    def fills(self):
        return self._fills()

    def executions(self):
        return [f.execution for f in self._fills()]
`

export const IB_ASYNC_UTIL = String.raw`"""The parts of 'ib_async.util' a bot may call."""
import logging
import time


def sleep(secs: float = 0.02) -> bool:
    time.sleep(secs)
    return True


def df(objs, labels=None):
    import pandas as pd

    if not objs:
        return None
    first = objs[0]
    if hasattr(first, "dict"):
        rows = [o.dict() for o in objs]
    elif hasattr(first, "_asdict"):
        rows = [o._asdict() for o in objs]
    else:
        rows = list(objs)
    frame = pd.DataFrame(rows)
    if labels:
        frame = frame[[c for c in labels if c in frame.columns]]
    return frame


def startLoop():
    pass


def patchAsyncio():
    pass


def useQt(*args, **kwargs):
    pass


def logToConsole(level=logging.INFO):
    logging.basicConfig(level=level)


def logToFile(path, level=logging.INFO):
    logging.basicConfig(filename=path, level=level)
`

export const IB_INSYNC_INIT = String.raw`"""'ib_insync' is 'ib_async''s old name: same stand-in."""
from ib_async import *  # noqa: F401,F403
from ib_async import util  # noqa: F401
`
