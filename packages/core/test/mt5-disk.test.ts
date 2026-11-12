import { describe, expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { leerCuentasDisco } from "../src/trading/mt5.js"

/** A real MetaQuotes tree is UTF-16LE with a BOM; a BOM-less ASCII file still decodes
 * through utf8's safe core, so the fixtures come in both spellings. */
const utf16le = (texto: string): Buffer => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(texto, "utf16le")])

const terminal = async (raiz: string, carpeta: string): Promise<string> => {
  const ruta = join(raiz, carpeta)
  await mkdir(join(ruta, "config"), { recursive: true })
  await mkdir(join(ruta, "logs"), { recursive: true })
  return ruta
}

const log = (filas: string[]): string => `${filas.join("\n")}\n`

describe("MT5 accounts on disk", () => {
  // The wizard's list is this read: the terminal's own last-session login leads marked
  // active, and the logs' older connections follow without repeating anyone (the same
  // row belongs to the date's log and to the ini at once).
  test("the ini names the active login and the logs contribute the older ones", async () => {
    const raiz = await mkdtemp(join(tmpdir(), "opencode-mt5-"))
    try {
      const demo = await terminal(raiz, "0123456789ABCDEF0123456789ABCDEF")
      await writeFile(join(demo, "config", "common.ini"), utf16le("[Common]\r\nNews=1\r\nLogin=5058203356\r\nServer=MetaQuotes-Demo\r\n"))
      await writeFile(
        join(demo, "logs", "20261102.log"),
        utf16le(
          log([
            "'5058203356': authorized on MetaQuotes-Demo through Access Point 32",
            "'4137112345': authorized on AlfaTest-Demo through Rebroadcast",
            "new demo account '9000000001' opened on MetaQuotes-Demo",
          ]),
        ),
      )

      expect(await leerCuentasDisco(raiz)).toEqual([
        { login: 5058203356, server: "MetaQuotes-Demo", active: true },
        { login: 4137112345, server: "AlfaTest-Demo", active: false },
        { login: 9000000001, server: "MetaQuotes-Demo", active: false },
      ])
    } finally {
      await rm(raiz, { recursive: true, force: true })
    }
  })

  // The window is the terminal's recent history: once the newest seven log files are in,
  // the oldest day's logins fall out of the list, and a file kept in plain ASCII (no BOM)
  // is worth exactly the same as a UTF-16 one.
  test("the read keeps the newest seven logs and reads an ASCII diary the same way", async () => {
    const raiz = await mkdtemp(join(tmpdir(), "opencode-mt5-"))
    try {
      const demo = await terminal(raiz, "0123456789ABCDEF0123456789ABCDEF")
      await writeFile(join(demo, "logs", "20261026.log"), log(["'111': authorized on Old-Demo through Rebroadcast"]))
      await writeFile(join(demo, "logs", "20261102.log"), utf16le(log(["'222': authorized on Live-Demo through Rebroadcast"])))

      // Both diaries sit inside the newest seven and the days come out newest first: the
      // ASCII spelling contributes its row exactly like the UTF-16 one.
      expect(await leerCuentasDisco(raiz)).toEqual([
        { login: 222, server: "Live-Demo", active: false },
        { login: 111, server: "Old-Demo", active: false },
      ])
    } finally {
      await rm(raiz, { recursive: true, force: true })
    }
  })

  test("eight diaries leave only the newest seven in", async () => {
    const raiz = await mkdtemp(join(tmpdir(), "opencode-mt5-"))
    try {
      const demo = await terminal(raiz, "0123456789ABCDEF0123456789ABCDEF")
      // Eight diaries, one login apiece (days 1..8): the window keeps days 2..8 and the rows
      // come out newest first — day 1's login falls out of the list entirely.
      for (let dia = 1; dia <= 8; dia++) await writeFile(join(demo, "logs", `2026110${dia}.log`), utf16le(log([`'${dia}00': authorized on New-Demo through Rebroadcast`])))

      expect((await leerCuentasDisco(raiz)).map((fila) => fila.login)).toEqual([800, 700, 600, 500, 400, 300, 200])
    } finally {
      await rm(raiz, { recursive: true, force: true })
    }
  })

  // The umbrella holds terminals beside `Common`-family folders and stray files; only the
  // 32-hex installs count, an install with neither ini nor log contributes nothing, and
  // every folder's rows land in the same list.
  test("only 32-hex folders contribute, empty ones harmlessly, two installs aggregate", async () => {
    const raiz = await mkdtemp(join(tmpdir(), "opencode-mt5-"))
    try {
      await mkdir(join(raiz, "Common"), { recursive: true })
      await writeFile(join(raiz, "not-aterminal.txt"), "nada")
      await terminal(raiz, "7FFF0000FFFFFF0000000000FFFFFF00") // no ini, no logs: nothing added
      const activa = await terminal(raiz, "ABCDEF0123456789ABCDEF0123456789")
      await writeFile(join(activa, "config", "common.ini"), utf16le("[Common]\r\nLogin=900\r\nServer=Real-Demo\r\n"))
      await writeFile(join(activa, "logs", "20261102.log"), utf16le(log(["'800': authorized on Real-Demo through Rebroadcast"])))

      const filas = await leerCuentasDisco(raiz)
      expect(filas).toHaveLength(2)
      expect(filas.find((fila) => fila.login === 900)).toEqual({ login: 900, server: "Real-Demo", active: true })
      expect(filas.find((fila) => fila.login === 800)).toEqual({ login: 800, server: "Real-Demo", active: false })
    } finally {
      await rm(raiz, { recursive: true, force: true })
    }
  })
})
