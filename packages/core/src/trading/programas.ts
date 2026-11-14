// The desktop programs the engine needs: Trader Workstation for IBKR, and the MetaTrader 5
// terminal for MT5 watches. The engine finds them where Windows records their install (the
// uninstall entries every installer writes), falling back to the installers' default folders,
// tells whether each one is running, and opens one only behind the user's own connect intent
// (a closed one stays closed while nothing is asked for). Signing in to TWS stays the user's:
// it asks for the account's own password.
import { execFile, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"

export type Programa = "tws" | "mt5"

/** abierto: running; abriendo: opened by the engine, still loading; cerrado: installed and
 * not running; falta: not installed on this computer. */
export type EstadoPrograma = "abierto" | "abriendo" | "cerrado" | "falta"

/** Where the user gets each program when it is missing. */
export const DESCARGA: Record<Programa, string> = {
  tws: "https://www.interactivebrokers.com/en/trading/tws.php",
  mt5: "https://www.metatrader5.com/en/download",
}

/** The process images each program runs as. */
const IMAGENES: Record<Programa, readonly string[]> = {
  // IB Gateway serves the same API: a desk running it instead of TWS has its program open,
  // and Connect must not launch a second TWS beside it.
  tws: ["tws.exe", "ibgateway.exe"],
  mt5: ["terminal64.exe"],
}

/** The uninstall entries' display names, and the executable inside each install folder. */
const INSTALACION: Record<Programa, { nombre: RegExp; ejecutables: readonly string[] }> = {
  tws: { nombre: /^Trader Workstation/i, ejecutables: ["tws.exe"] },
  mt5: { nombre: /MetaTrader 5/i, ejecutables: ["terminal64.exe"] },
}

const POR_DEFECTO: Record<Programa, readonly string[]> = {
  tws: [join("C:\\", "Jts", "tws.exe")],
  mt5: [join(process.env.ProgramFiles ?? "C:\\Program Files", "MetaTrader 5", "terminal64.exe")],
}

const ejecutar = (comando: string, args: readonly string[], ms = 15_000) =>
  new Promise<string>((resolver) =>
    execFile(comando, [...args], { windowsHide: true, timeout: ms, maxBuffer: 8 * 1024 * 1024 }, (_error, stdout) =>
      resolver(String(stdout ?? "")),
    ),
  )

/** Every install folder the uninstall entries record, by display name (machine and user). */
const instalaciones = async () => {
  const claves = [
    "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  ]
  const filas: { nombre: string; carpeta: string }[] = []

  for (const clave of claves) {
    const salida = await ejecutar("reg", ["query", clave, "/s"])
    let nombre: string | undefined
    let carpeta: string | undefined
    const cerrar = () => {
      if (nombre && carpeta) filas.push({ nombre, carpeta })
      nombre = undefined
      carpeta = undefined
    }

    for (const linea of salida.split(/\r?\n/)) {
      if (linea.startsWith("HKEY_")) {
        cerrar()
        continue
      }
      const valor = /^\s+(DisplayName|InstallLocation|DisplayIcon)\s+REG_\w+\s+(.*)$/.exec(linea)
      if (!valor) continue
      const texto = valor[2]!.trim().replace(/^"|"$/g, "")
      if (valor[1] === "DisplayName") nombre = texto
      else if (valor[1] === "InstallLocation" && texto) carpeta = texto
      // An entry without InstallLocation still names its folder through its icon.
      else if (valor[1] === "DisplayIcon" && texto && carpeta === undefined) carpeta = dirname(texto.split(",")[0]!)
    }
    cerrar()
  }

  return filas
}

const cache = new Map<Programa, Promise<string | null>>()

/** The program's executable on this computer, or null when it is not installed. A found
 * path is kept; a miss is asked again next time (the user may have just installed it). */
export const localizar = (programa: Programa): Promise<string | null> => {
  if (process.platform !== "win32") return Promise.resolve(null)

  const previa = cache.get(programa)
  if (previa) return previa

  const busqueda = (async () => {
    const { nombre, ejecutables } = INSTALACION[programa]
    const registradas = (await instalaciones())
      .filter((fila) => nombre.test(fila.nombre))
      .flatMap((fila) => ejecutables.map((exe) => join(fila.carpeta, exe)))

    return [...registradas, ...POR_DEFECTO[programa]].find((ruta) => existsSync(ruta)) ?? null
  })()

  cache.set(programa, busqueda)
  void busqueda.then((ruta) => {
    if (ruta === null) cache.delete(programa)
  })

  return busqueda
}

/** The process images running right now, lowercased. */
export const procesos = async () => {
  if (process.platform !== "win32") return new Set<string>()

  const salida = await ejecutar("tasklist", ["/FO", "CSV", "/NH"])

  return new Set(
    salida
      .split(/\r?\n/)
      .map((linea) => /^"([^"]+)"/.exec(linea)?.[1]?.toLowerCase())
      .filter((imagen): imagen is string => imagen !== undefined),
  )
}

export const enMarcha = (programa: Programa, vivos: ReadonlySet<string>) => IMAGENES[programa].some((imagen) => vivos.has(imagen))

/** Opens the program detached from the engine, so it outlives the app like any program the
 * user opens. TWS reads its settings folder from the install's own shortcut argument. */
export const abrir = (programa: Programa, ruta: string) => {
  const carpeta = dirname(ruta)
  const args = programa === "tws" ? [`-J-DjtsConfigDir=${carpeta}`] : []
  const hijo = spawn(ruta, args, { cwd: carpeta, detached: true, stdio: "ignore" })

  hijo.on("error", () => undefined)
  hijo.unref()
}
