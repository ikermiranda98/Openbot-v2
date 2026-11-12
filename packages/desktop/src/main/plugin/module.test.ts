import { expect, test } from "bun:test"
import os from "node:os"
import path from "node:path"
import { pluginWindowModules } from "@opencode/plugin/gui/host"
import { evaluateMain } from "./module"

// One `./gui-experimental` bundle for both processes, as Vite emits it with vite-plugin-solid: Solid's templates and
// event delegation run at module scope, beside the Node built-ins only the main setup uses.
const bundle = `
const web = require("solid-js/web")
const path = require("node:path")
const sdk = require("@opencode/plugin/gui")
const tmpl = web.template("<p>Notes</p>")
web.delegateEvents(["click"])
exports.default = sdk.Plugin.define({
  setup: () => void tmpl(),
  main: () => () => path.join("a", "b"),
})
`

test("main runs a plugin's main setup, with the window-only modules inert and Node built-ins real", async () => {
  const loaded = await evaluateMain(bundle)

  // SAFETY: the main setup reads no context; it returns a cleanup that uses a real Node built-in.
  const cleanup = await loaded.setup({} as never)

  expect(cleanup?.()).toBe(path.join("a", "b"))
})

test("main runs nothing for a plugin with only a window setup", async () => {
  const loaded = await evaluateMain(
    'const web = require("solid-js/web"); exports.default = { setup: () => void web.template("<p>")() }',
  )

  // SAFETY: the empty setup reads no context.
  expect(await loaded.setup({} as never)).toBeUndefined()
})

/** A bundle whose main setup runs `body` and reports what it returns through its cleanup. */
function probeBundle(body: string) {
  return `exports.default = { main: () => () => { ${body} } }`
}

/** Runs a probe bundle's main setup and returns the value its cleanup reports. */
async function mainValue(body: string): Promise<unknown> {
  const loaded = await evaluateMain(probeBundle(body))
  const cleanup = await loaded.setup({} as never)

  // SAFETY: the probe body returns a value, which the cleanup hands back as-is.
  return (cleanup as unknown as (() => unknown) | undefined)?.()
}

// The built-ins a main bundle may require, each probed through a real API: a placeholder or a different module would
// fail every expectation, and `node:path` must be the same instance as `path`, which is what makes both names safe.
test.each([
  ["path", 'const m = require("path"); return m.join("a", "b")', path.join("a", "b")],
  ["node:path", 'const m = require("node:path"); return m === require("path")', true],
  ["node:os", 'const m = require("node:os"); return m.platform()', os.platform()],
  [
    "node:crypto",
    'const m = require("node:crypto"); return m.randomUUID()',
    expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
  ],
  ["path/posix", 'const m = require("path/posix"); return m.join("a", "b")', "a/b"],
  ["path/win32", 'const m = require("path/win32"); return m.join("a", "b")', "a\\b"],
] as const)("main provides the real %s module", async (_name, body, expected) => {
  expect(await mainValue(body)).toEqual(expected)
})

// Bundlers hoist `require` to module scope, so a refused module fails evaluation before any setup runs. A refused
// module must reject: `rejects` fails on a resolved promise, so an allowed module cannot slip through.
const requiring = (name: string) => `require(${JSON.stringify(name)}); exports.default = { main: () => {} }`

test.each(["node:fs", "fs", "child_process", "net", "http", "vm", "worker_threads", "module"])(
  "main refuses the %s module",
  async (name) => {
    await expect(evaluateMain(requiring(name))).rejects.toThrow(`does not allow in main: ${name}`)
  },
)

test("main refuses a module it does not know", async () => {
  await expect(evaluateMain(requiring("lodash"))).rejects.toThrow("does not allow in main: lodash")
})

test("main's electron exposes the app and shell but not windows, IPC, sessions, protocols or networking", async () => {
  const forbidden = ["BrowserWindow", "WebContentsView", "ipcMain", "session", "protocol", "net"]
  const loadedProbe = (await mainValue(`
const electron = require("electron")
return {
  keys: Object.keys(electron),
  app: typeof electron.app,
  shell: typeof electron.shell,
  forbidden: ${JSON.stringify(forbidden)}.map((key) => electron[key]),
}
`)) as { keys: string[]; app: string; shell: string; forbidden: unknown[] }

  expect(loadedProbe.app).toBe("object")
  expect(loadedProbe.shell).toBe("object")
  expect(loadedProbe.forbidden).toEqual(forbidden.map(() => undefined))
  expect(loadedProbe.keys.filter((key) => forbidden.includes(key))).toEqual([])
})

test.each([...pluginWindowModules])("main gives %s an inert placeholder", async (name) => {
  const observed = (await mainValue(`
const m = require(${JSON.stringify(name)})
return {
  label: String(m),
  same: m === m.template() && m === new m() && m === m.anything,
}
`)) as { label: string; same: boolean }

  expect(observed.label).toBe(`[inert module ${name}]`)
  expect(observed.same).toBe(true)
})
