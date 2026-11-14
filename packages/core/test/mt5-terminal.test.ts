import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TERMINAL_ABIERTO_PY } from "../src/trading/mt5.js"
import { ORDEN_PY } from "../src/trading/mt5-ordenes.js"

// `mt5.initialize()` launches a closed MetaTrader 5 terminal, and the app never opens MT5 on its
// own. So when the process list cannot say whether the terminal runs, the scripts must treat it
// as unknown and stay away; they used to assume it open and attach (which could launch it).
// The Microsoft Store's WindowsApps alias is a stub, not an interpreter: it counts as no Python.
const real = (ruta: string | null) => (ruta === null || /\\WindowsApps\\/i.test(ruta) ? null : ruta)
const python = real(Bun.which("python")) ?? real(Bun.which("python3"))

/** Runs python with `prelude` executed before `script`, a fake MetaTrader5 package on the path
 * whose initialize() only records the call, and `args` as the script's argv. */
const ejecutar = async (prelude: string, script: string, args: string[] = []) => {
  const carpeta = await mkdtemp(join(tmpdir(), "opencode-mt5-"))
  try {
    await mkdir(join(carpeta, "MetaTrader5"))
    await writeFile(join(carpeta, "MetaTrader5", "__init__.py"), 'def initialize():\n    print("INITIALIZE")\n    return False\n')
    await writeFile(join(carpeta, "script.py"), script)
    const proceso = Bun.spawn(
      [python!, "-c", `${prelude}\nimport sys\nsys.argv = ["script"] + sys.argv[1:]\nexec(open(${JSON.stringify(join(carpeta, "script.py"))}, encoding="utf-8").read())`, ...args],
      { env: { ...process.env, PYTHONPATH: carpeta }, stdout: "pipe", stderr: "pipe" },
    )
    return await new Response(proceso.stdout).text()
  } finally {
    await rm(carpeta, { recursive: true, force: true })
  }
}

const listaRota = "import subprocess\ndef _rota(*args, **kwargs):\n    raise OSError('tasklist blocked')\nsubprocess.run = _rota"
const listaFallida =
  "import subprocess\nclass _Hecho:\n    returncode = 1\n    stdout = ''\nsubprocess.run = lambda *args, **kwargs: _Hecho()"

// Python is what both scripts run on; a machine without it has nothing to test.
describe.skipIf(python === null)("MT5 terminal check", () => {
  test("an unreadable or failing process list reads as unknown, never as open", async () => {
    const pregunta = `import subprocess\n${TERMINAL_ABIERTO_PY}\nprint(repr(terminal_abierto()))`
    expect((await ejecutar(listaRota, pregunta)).trim()).toBe("None")
    expect((await ejecutar(listaFallida, pregunta)).trim()).toBe("None")
  })

  test("the close run refuses without attaching when it cannot see the terminal", async () => {
    const pedido = JSON.stringify({ accion: "cerrar", login: 5050001, server: "MetaQuotes-Demo", symbol: "EURUSD" })
    const salida = await ejecutar(listaRota, ORDEN_PY, [pedido])
    expect(salida).not.toContain("INITIALIZE")
    expect(JSON.parse(salida.trim())).toEqual({
      ok: false,
      message: "No puedo comprobar si el terminal de MetaTrader 5 está abierto (falla la lista de procesos): no se envió nada",
    })
  })
})
