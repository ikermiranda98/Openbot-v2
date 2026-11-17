"""Prueba del puente ib_async -> motor -> MT5 (simulador). No es un sistema real; nunca contra una cuenta del usuario."""
from ib_async import IB, ContFuture, Future, Forex, Contract, MarketOrder, LimitOrder, StopOrder
import ib_async

print("ib_async desde:", ib_async.__file__, flush=True)
ib = IB()
ib.connect("127.0.0.1", 7497, clientId=99)
print("cuentas", ib.managedAccounts(), flush=True)
assert all(c.startswith("DU") for c in ib.managedAccounts())
liq = next(float(v.value) for v in ib.accountSummary() if v.tag == "NetLiquidation" and v.currency == "USD")
print("NetLiquidation", liq, flush=True)

cont = ContFuture("MNQ", "CME"); ib.qualifyContracts(cont)
fut = Future(conId=cont.conId); ib.qualifyContracts(fut)
print("contrato", fut.conId, fut.localSymbol, fut.symbol, flush=True)
assert fut.conId == cont.conId

bars = ib.reqHistoricalData(fut, endDateTime="", durationStr="1 D", barSizeSetting="1 min", whatToShow="TRADES", useRTH=True, formatDate=2)
print("velas 1 min", len(bars), bars[-1].date, bars[-1].close, flush=True)
assert bars and bars[-1].date.tzinfo is not None
fin = bars[0].date.strftime("%Y%m%d-%H:%M:%S")
b2 = ib.reqHistoricalData(cont, endDateTime=fin, durationStr="1 M", barSizeSetting="1 hour", whatToShow="TRADES", useRTH=False, formatDate=2)
print("velas 1h hasta", fin, len(b2), b2[0].date, b2[-1].date, flush=True)
assert b2[-1].date <= bars[0].date


def esperar(t, s=10):
    for _ in range(s * 2):
        if t.orderStatus.status in ("Filled", "Cancelled", "Inactive"):
            break
        ib.sleep(0.5)
    return t.orderStatus.status


# 1) entrada a mercado + stop y objetivo OCA
t = ib.placeOrder(fut, MarketOrder("BUY", 1, tif="DAY"))
print("entrada", esperar(t), t.orderStatus.avgFillPrice, t.orderStatus.filled, flush=True)
assert t.orderStatus.status == "Filled"
p = t.orderStatus.avgFillPrice
so = StopOrder("SELL", 1, round(p - 200, 2), tif="DAY"); so.ocaGroup, so.ocaType = "prueba", 1
lo = LimitOrder("SELL", 1, round(p + 200, 2), tif="DAY"); lo.ocaGroup, lo.ocaType = "prueba", 1
ts = ib.placeOrder(fut, so); tl = ib.placeOrder(fut, lo)
ib.sleep(3)
print("stop", ts.orderStatus.status, "objetivo", tl.orderStatus.status, flush=True)
assert any(x.position == 1 for x in ib.positions())
# 2) promedio: limitada de compra (entrada pendiente) y luego se cancela
pr = ib.placeOrder(fut, LimitOrder("BUY", 1, round(p - 150, 2), tif="DAY"))
ib.sleep(2)
assert pr.orderStatus.status == "Submitted"
ib.cancelOrder(pr.order); ib.sleep(1)
assert pr.orderStatus.status == "Cancelled"
# 3) mover el stop (modificar)
so.auxPrice = round(p - 100, 2); ts = ib.placeOrder(fut, so); ib.sleep(3)
print("stop movido", ts.order.auxPrice, ts.orderStatus.status, flush=True)
# 4) cierre: cancelar stop y objetivo, vender a mercado
for x in (ts, tl):
    ib.cancelOrder(x.order)
ib.sleep(2)
c = ib.placeOrder(fut, MarketOrder("SELL", 1, tif="DAY"))
assert esperar(c) == "Filled"
assert not any(x.position for x in ib.positions())
# 5) stop de entrada ya cruzado -> mercado; stop de salida ya cruzado -> cierra a mercado
e = ib.placeOrder(fut, StopOrder("BUY", 1, round(p - 1000, 2), tif="DAY"))
print("stop ya cruzado", esperar(e), flush=True)
s2 = ib.placeOrder(fut, StopOrder("SELL", 1, round(e.orderStatus.avgFillPrice + 500, 2), tif="DAY"))
assert esperar(s2) == "Filled"
# 6) forex
fx = Forex("USDJPY"); ib.qualifyContracts(fx)
cfd = Contract(secType="CFD", symbol="USD", currency="JPY", exchange="SMART"); ib.qualifyContracts(cfd)
h = ib.reqHistoricalData(fx, endDateTime="", durationStr="1 M", barSizeSetting="1 hour", whatToShow="MIDPOINT", useRTH=False, formatDate=2)
print("velas usdjpy", len(h), flush=True)
f1 = ib.placeOrder(fx, MarketOrder("SELL", 100000, tif="DAY")); esperar(f1)
st = ib.placeOrder(fx, StopOrder("BUY", 100000, round(f1.orderStatus.avgFillPrice * 1.01, 3), tif="GTC")); ib.sleep(2)
assert any(x.order.orderId == st.order.orderId for x in ib.openTrades())
ib.cancelOrder(st.order); ib.sleep(1)
f2 = ib.placeOrder(fx, MarketOrder("BUY", 100000, tif="DAY")); esperar(f2)
print("ejecuciones", len(ib.reqExecutions()), "completadas", len(ib.reqCompletedOrders(apiOnly=True)), flush=True)
print("posiciones finales", [(x.contract.localSymbol, x.position) for x in ib.positions()], flush=True)
ib.disconnect()
print("PRUEBA OK", flush=True)
