# Openbot

**Escritorio con trading nativo: agentes, IBKR TWS, MT5 y sistemas algorítmicos.**

Openbot es la plataforma de OpenCode V2 convertida en aplicación de escritorio para Windows con un
módulo de trading nativo: los bots viven dentro de la app, junto a los agentes y las sesiones.

## Qué trae

- **Agentes y sesiones**: el núcleo de OpenCode V2 — agentes build/plan, herramientas, MCP,
  compactación y protocolo de sesión — con su interfaz de escritorio.
- **Trading nativo**: motor de trading con bots sobre **IBKR TWS** y **MT5**, ciclos de cierre con
  claims duraderos por terminal y símbolo, veredictos traducidos y un gate de cierre que avisa sobre
  la exposición de todas las cuentas antes de salir de la app.
- **Anillo de uso gratis**: rotación de salidas sobre **Cloudflare WARP** que responde al rechazo
  del gateway y libera el pin de hosts al renovar el día (el servicio WARP queda arriba, de modo que
  la siguiente rotación no necesita elevación).
- **Actualizador propio**: las releases se publican en este repositorio; la app se actualiza sola,
  instala en silencio y relanza la nueva versión.

## Instalación

Descarga `openbot-win-x64.exe` desde [Releases](https://github.com/ikermiranda98/openbot/releases) y
ejecútalo. Una sola instalación por equipo (`ai.opencode.desktop`); las actualizaciones llegan solas
desde aquí.

Para el trading hacen falta **IBKR TWS** (o MT5) en el mismo equipo. Cuando varias instalaciones
comparten base de datos, cada una declara su `TRADING_CLIENT_ID`.

## Construir desde el código

```bash
bun install
bun run check              # lint + typecheck de todo el árbol
cd packages/desktop
bun run hex:fetch          # sidecar empaquetado, contra su pin
bun run build && bun run pack
```

El árbol integra semanalmente [`anomalyco/opencode:dev`](https://github.com/anomalyco/opencode) con
genealogía propia: las novedades de upstream entran con chequeos completos y solo aterrizan en la
rama cuando todo pasa. El trading, el anillo y el actualizador son exclusivos de este fork.
