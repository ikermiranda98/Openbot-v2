# Bots de IBKR en una cuenta MetaTrader 5

Un sistema del pool (`NN_nombre/bot.py`, escrito con `ib_async` para TWS) opera en una cuenta
MT5 **sin cambiar una línea del bot** si su carpeta tiene un `system.json`:

```json
{ "broker": "mt5" }
```

Claves opcionales: `"login"` (y `"server"`) si hay varias cuentas MT5 enlazadas, `"symbol"`
con el nombre exacto del símbolo del bróker (gana a la lista interna) y `"magic"` (por defecto
`77000NN`). Sin `system.json`, el bot sigue yendo a TWS como siempre.

La cuenta MT5 tiene que estar enlazada en OpenBot (asistente de cuentas) y el terminal abierto,
con la sesión iniciada y **Algo Trading** activado.

## Piezas

| Fichero | Qué hace |
|---|---|
| `bots-py.ts` | `ib_async` (y `ib_insync`) sustituto. El motor lo escribe en `%APPDATA%\OpenBot\bots-mt5\pyshim` y lo pone primero en el `PYTHONPATH` del bot. |
| `servidor-bots.ts` | API local de los bots (`/bot/*`, solo 127.0.0.1, token por sistema). Su dirección queda en `engine.json`. |
| `bots-mt5.ts` | Traductor (port de `bots.rs` de DeepTrading): contratos → símbolos MT5, tamaños con la misma exposición, órdenes → DEAL / pendientes / SL / TP, OCA, ejecuciones. |
| `mt5.ts` (`PUENTE_PY`) | El puente Python de cada enlace MT5: lee la cuenta para el panel y, por su stdin, ejecuta los comandos de los bots solo en la cuenta del enlace. |
| `test/fixtures/mt5-falso` | Paquete `MetaTrader5` falso (gemelo de `dte-sim`) para probar sin bróker. |

| El bot hace | En MT5 |
|---|---|
| `qualifyContracts(ContFuture("MNQ"))` | símbolo equivalente (`US100`, `USTEC`, `NAS100`… o el `symbol` de `system.json`) |
| `reqHistoricalData` | velas del símbolo (`RATES`), en UTC |
| orden a mercado | `DEAL` con el magic; si va contra su posición, cierra sus posiciones (las más antiguas primero) |
| stop o límite de entrada (o promedio) | orden pendiente en el bróker |
| stop / límite de salida (también OCA) | SL / TP de cada posición del sistema |

Tamaño: misma exposición (`lotes = cantidad × valor_punto / (tick_value / tick_size)`); en forex
la cantidad son unidades de la divisa base (100.000 = 1 lote). Las cuentas demo se ven como
`DU<login>`, así que los bots que se niegan a operar en real siguen haciéndolo.

## Python del puente

El paquete `MetaTrader5` solo tiene wheels hasta Python 3.14. El instalador de Windows lleva su
propio Python (`packages/desktop/script/build-mt5-runtime.py` → `resources/mt5-runtime`); sin él,
el motor usa `TRADING_MT5_PYTHON` o el `pythonw` del sistema (con `pip install MetaTrader5`).
Los bots siguen corriendo con su Python de siempre.

## Probar sin bróker

```
set TRADING_MT5_PYTHONPATH=<repo>\packages\core\test\fixtures\mt5-falso
```

y enlaza la cuenta `5550001` / servidor `OpenBot-Sim`. Tests: `bun run test test/trading-bots-mt5.test.ts`
(la prueba OCA larga con `TRADING_MT5_E2E=1`).
