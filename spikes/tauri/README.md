# Spike: la cáscara en Rust (Tauri 2) con el mismo renderer

La pregunta: la ventana de Openbot es Electron (Chromium + Node) por fuera y Bun
por dentro. Este spike mide **lo que cuesta la cáscara** — RAM en reposo, tamaño
del ejecutable y arranque en frío — cargando el **mismo bundle del renderer**
(el que genera `packages/desktop/out/renderer`) dentro de una ventana Tauri, en
la misma máquina.

## Qué se mide y qué no

| Se mide | No se mide |
| --- | --- |
| RAM en reposo de TODA la cadena de procesos (host + webview + GPU) | La velocidad del motor del agente (no se toca: sigue siendo el servidor sobre Bun) |
| Arranque en frío: desde el spawn del proceso hasta ventana visible | La latencia del LLM (red — nada que recortar aquí) |
| Tamaño del ejecutable real | El plugin de navegador/CDP, la voz y el updater (ninguna va) |

Honestidad del método: el renderer corre sin el proceso main de Electron — el
stub de `window.electron` existe para que el bootstrap no explote. Las
operaciones que dependen de IPC pintan su estado de error/carga en lugar de
datos reales; con eso basta para comparar el coste del shell, que es lo único
que este spike promete.

## Cómo construir

El shell se compila en GitHub Actions (el runner windows trae Rust y MSVC de
sopa fría, así que nadie instala el toolchain en la máquina solo para medir):

1. `gh workflow run spike-tauri.yml --repo ikermiranda98/openbot`
2. Bajar el artefacto `tauri-spike-win-x64` y descomprimirlo en local.
3. Medir contra la app Electron instalada (protocolo abajo).

Corregir el spike es iterar en esa misma workflow (se puede iterar sin tocar la
máquina; Webview2 ya está instalada en Windows).

## Protocolo de medición (la misma máquina, la sesión en curso activa, sin otras apps pesadas)

Implementado en `spikes/tauri/scripts/Measure-ShellBoot.ps1`:

1. **Instancia aislada por repetición**: cada lado corre con su propia carpeta
   de datos, nueva en cada repetición (`OPENCODE_DESKTOP_TEST_ROOT` para
   Electron —remapea el `userData` completo—, `WEBVIEW2_USER_DATA_FOLDER` para
   Tauri). Así una repetición no hereda estado del updater ("update ready") y
   el bloqueo de instancia única nunca toca la app viva.
2. **Arranque en frío**: una repetición de calentamiento sin contar y 3
   contadas: de `Start-Process` a la primera ventana principal propia (polling
   de `MainWindowHandle` cada 15 ms, con el árbol de hijos refrescado por WMI
   cada 500 ms para no atribuir ventanas ajenas). Cada árbol muere al terminar
   su repetición.
3. **RAM en reposo**: 30 s tras el arranque, suma de memoria privada del árbol
   completo (raíz, hijos y nietos). `Get-ReportPIDTree.ps1` da el desglose por
   proceso.
4. **Tamaño**: bytes por lado: en Tauri el `.exe` de release; en Electron el
   instalador NSIS subido a releases (que al instalarse expande a ~940 MB).

## Resultados (7 nov 2026 — mediana de 3 repeticiones con calentamiento previo)

| Métrica | Electron (cáscara actual) | Tauri spike | Δ |
| --- | --- | --- | --- |
| RAM en reposo (árbol completo a los 30 s) | 393,7 MB (388,8 · 398,1 · 393,7) | 172,6 MB (171,2 · 173,9 · 172,6) | **−56 %** (2,3× más ligera) |
| Arranque en frío (a ventana principal) | 289 ms (289 · 292 · 289) | 89 ms (89 · 90 · 88) | **−69 %** (3,2× más rápida) |
| Instalador / ejecutable | 300 437 297 B (NSIS) | 49 474 560 B (exe único) | **−83 %** |
| Huella en disco una vez instalado | ≈ 940 MB | ≈ 47 MB (WebView2 es runtime compartido del sistema, 0 propio) | **−95 %** |

Honestidad del contraste:

- El renderer es el mismo bundle en ambos lados; todo el delta es la cáscara
  (Electron + Node vs Rust + WebView2).
- En el arranque aislado, Electron solo levanta la cáscara (main, GPU, red,
  render y crashpad): el servidor CLI no nace en los primeros 30 s. Ese tramo
  (Bun) costará lo mismo bajo cualquier cáscara en la conversión, así que
  queda fuera de la promesa del spike. En Tauri el árbol son 7 procesos: host
  Rust ~6 MB y 6 `msedgewebview2`.
- La primera arrancada del spike (calentamiento) creó el perfil WebView2 y
  tardó 2968 ms; a partir de ahí el arranque frío real es el de la tabla. Con
  el perfil sembrado por el instalador, ese tirón ocurre una sola vez.
- Meta del encargo: ≥50 % de mejora. El arranque la cumple (−69 %), la RAM
  también (−56 %) y el disco rinde mucho más (−83 % y −95 % instalado).

Veredicto: lo que cuesta la cáscara desaparece con Tauri. El trabajo de la
conversión no está en el arranque ni en la RAM, sino en portar los features
del proceso main (IPC `window.electron`, updater con formato nuevo, CDP,
diálogos, deep links) sin quitar nada.
