// Copia el bundle del renderer construido con electron-vite al directorio de
// assets del spike: Tauri incrusta ese mismo contenido y lo sirve en su propio
// esquema. Se ejecuta desde la raíz del repo.
import { cp, mkdir } from "node:fs/promises"

const from = "packages/desktop/out/renderer"
const to = "spikes/tauri/assets"

await mkdir(to, { recursive: true })
await cp(from, to, { recursive: true })
