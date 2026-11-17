"""Solo lectura: cualifica contratos y pide velas. No envía órdenes."""
from ib_async import IB, ContFuture, Future, Forex
ib = IB(); ib.connect("127.0.0.1", 7497, clientId=96)
print("cuentas", ib.managedAccounts(), flush=True)
for c in (ContFuture("MNQ", "CME"), ContFuture("MGC", "COMEX"), ContFuture("M2K", "CME"), Forex("USDJPY")):
    ib.qualifyContracts(c)
    bars = ib.reqHistoricalData(c, endDateTime="", durationStr="2 D", barSizeSetting="1 hour", whatToShow="TRADES", useRTH=False, formatDate=2)
    print(c.symbol, "->", c.localSymbol, "| velas", len(bars), "| última", bars[-1].date if bars else None, bars[-1].close if bars else None, flush=True)
print("posiciones", ib.positions(), "| ejecuciones", len(ib.reqExecutions()), flush=True)
ib.disconnect()
print("LECTURA OK", flush=True)
