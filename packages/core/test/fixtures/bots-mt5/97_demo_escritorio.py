"""Bot de demostración para ver el escritorio: compra 1 MNQ con stop y objetivo y espera."""
from ib_async import IB, ContFuture, Future, MarketOrder, LimitOrder, StopOrder
ib = IB(); ib.connect("127.0.0.1", 7497, clientId=97)
cont = ContFuture("MNQ", "CME"); ib.qualifyContracts(cont)
fut = Future(conId=cont.conId); ib.qualifyContracts(fut)
t = ib.placeOrder(fut, MarketOrder("BUY", 1)); ib.sleep(2)
p = t.orderStatus.avgFillPrice
so = StopOrder("SELL", 1, round(p - 300, 2)); so.ocaGroup = "demo"
lo = LimitOrder("SELL", 1, round(p + 300, 2)); lo.ocaGroup = "demo"
ib.placeOrder(fut, so); ib.placeOrder(fut, lo)
ib.placeOrder(fut, LimitOrder("BUY", 1, round(p - 150, 2)))
print("demo dentro a", p, flush=True)
while True:
    ib.sleep(5)
