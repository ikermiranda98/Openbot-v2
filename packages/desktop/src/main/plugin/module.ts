import { createRequire } from "node:module"
import {
  evaluatePluginBundle,
  inertModule,
  pluginWindowModules,
  type pluginSharedModules,
} from "@opencode/plugin/gui/host"
import type { Plugin } from "@opencode/plugin/gui/main"

const native = createRequire(import.meta.url)

// Plugin bundles share the host's module instances, so tokens and schemas they import are the same objects the host
// checks against. In main, the window SDK's name resolves to the main SDK.
const shared = {
  effect: () => import("effect"),
  "@opencode/plugin/gui": () => import("@opencode/plugin/gui/main"),
  "@opencode/plugin/gui/main": () => import("@opencode/plugin/gui/main"),
  "@opencode/plugin/rpc": () => import("@opencode/plugin/rpc"),
  "@opencode/schema/rpc": () => import("@opencode/schema/rpc"),
  "@opencode/client": () => import("@opencode/client"),
  "@opencode/client/effect": () => import("@opencode/client/effect"),
} satisfies Record<(typeof pluginSharedModules)[number], () => Promise<object>>

const windowOnly = new Set<string>(pluginWindowModules)

// The Node built-ins a plugin's main bundle may require. Normalized without a `node:` prefix; the original name,
// prefix included, is what `native` receives so `node:path` and `path` resolve to the same module.
const allowedBuiltins = new Set<string>(["path", "path/posix", "path/win32", "os", "crypto"])

const appApi = [
  "getName",
  "getVersion",
  "getLocale",
  "getLocaleCountryCode",
  "getPath",
  "getAppPath",
  "isPackaged",
  "isReady",
  "whenReady",
] as const

const shellApi = ["openExternal", "openPath", "showItemInFolder", "beep"] as const

/**
 * Picks the named keys from `source`, binding any function to `source` so it keeps its `this`. Tolerates a missing or
 * non-object source by returning an object whose keys are `undefined`.
 */
export function pickBound(source: unknown, keys: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  if (source !== null && typeof source === "object") {
    const object = source as Record<string, unknown>

    for (const key of keys) {
      const value = object[key]
      result[key] = typeof value === "function" ? value.bind(object) : value
    }

    return result
  }

  for (const key of keys) result[key] = undefined

  return result
}

/**
 * A version of Electron's module exposing only the APIs a plugin's main bundle may use. `app` is limited to its
 * read-only/launch helpers and `whenReady`; `shell` is limited to opening external resources. The rest of Electron's
 * surface (windows, menus, IPC, ...) stays out of a plugin's reach.
 */
export function safeElectron(native: unknown): Record<string, unknown> {
  const object = native !== null && typeof native === "object" ? (native as Record<string, unknown>) : undefined

  return {
    app: pickBound(object?.app, appApi),
    clipboard: object?.clipboard,
    nativeImage: object?.nativeImage,
    dialog: object?.dialog,
    screen: object?.screen,
    Notification: object?.Notification,
    shell: pickBound(object?.shell, shellApi),
  }
}

/**
 * Evaluates a plugin's `./gui-experimental` bundle in main and returns what main runs: its `Plugin.define`'s `main`
 * setup, or one that does nothing for a plugin with none, and its `os` and catalog. `electron`
 * and the allowlisted Node built-ins are the real modules; the window-only modules are inert placeholders.
 */
export async function evaluateMain(code: string) {
  const modules = new Map<string, object>(
    await Promise.all(Object.entries(shared).map(async ([name, load]) => [name, await load()] as const)),
  )

  const bundle = evaluatePluginBundle(code, {
    process: "main",
    require: (name) => {
      const loaded = modules.get(name)

      if (loaded) return loaded

      if (name === "electron") return safeElectron(native("electron"))

      const normalized = name.startsWith("node:") ? name.slice(5) : name
      if (allowedBuiltins.has(normalized)) return native(name)

      if (windowOnly.has(name)) return inertModule(name)

      throw new Error(`Plugin GUI bundle requires a module the app does not allow in main: ${name}`)
    },
  })

  return {
    setup: bundle.main ?? ((() => {}) satisfies Plugin.MainSetup),
    i18n: bundle.definition.i18n,
    os: bundle.definition.os,
  }
}