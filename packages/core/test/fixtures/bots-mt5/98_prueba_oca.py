"""Prueba: promedio + stop/objetivo OCA que ejecuta el bróker (simulador). Esperado: stop Filled por 2, objetivo Cancelled."""
from ib_async import IB, ContFuture, Future, MarketOrder, LimitOrder, StopOrder

ib = IB(); ib.connect("127.0.0.1", 7497, clientId=98)
cont = ContFuture("MNQ", "CME"); ib.qualifyContracts(cont)
fut = Future(conId=cont.conId); ib.qualifyContracts(fut)
t = ib.placeOrder(fut, MarketOrder("BUY", 1))
ib.sleep(2); p = t.orderStatus.avgFillPrice
so = StopOrder("SELL", 1, round(p - 4, 2)); so.ocaGroup, so.ocaType = "g", 1
lo = LimitOrder("SELL", 1, round(p + 400, 2)); lo.ocaGroup, lo.ocaType = "g", 1
ts, tl = ib.placeOrder(fut, so), ib.placeOrder(fut, lo)
# promedio: segunda compra a mercado; el stop y el objetivo pasan a 2
ib.placeOrder(fut, MarketOrder("BUY", 1)); ib.sleep(2)
for o in (ts.order, tl.order):
    o.totalQuantity = 2
ts, tl = ib.placeOrder(fut, ts.order), ib.placeOrder(fut, tl.order)
for _ in range(240):
    ib.sleep(1)
    if ts.orderStatus.status == "Filled" or tl.orderStatus.status == "Filled":
        break
print("stop", ts.orderStatus.status, ts.orderStatus.filled, "| objetivo", tl.orderStatus.status, flush=True)
print("PRUEBA OCA", "OK" if ts.orderStatus.status == "Filled" and tl.orderStatus.status == "Cancelled" and ts.orderStatus.filled == 2 else "FALLO", flush=True)
