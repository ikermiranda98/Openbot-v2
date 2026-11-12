import { execFile, spawn } from "node:child_process"
import type { BrowserWindow } from "electron"

const SERVICE = "CloudflareWARP"

// `sc query` answers RUNNING (or START_PENDING) once the service is up, and fails with 1060 when
// WARP is not installed at all; anyone may ask it.
const query = () =>
  new Promise<"running" | "stopped" | "missing">((resolve) =>
    execFile("sc", ["query", SERVICE], { windowsHide: true }, (error, stdout) => {
      if (/RUNNING|START_PENDING/.test(String(stdout))) return resolve("running")
      resolve(error && "code" in error && error.code === 1060 ? "missing" : "stopped")
    }),
  )

const running = async () => (await query()) === "running"

/**
 * Starts WARP's service, which only an administrator may start. The elevation prompt is asked from
 * this process while its window is in front, so Windows shows it in front instead of only flashing
 * the taskbar, as it does for a prompt asked from a background process. Once started the service
 * stays up (it starts with Windows on its own), so the prompt does not come back.
 */
export const startWarpService = async (win: BrowserWindow | null) => {
  if (process.platform !== "win32") return false

  const state = await query()

  if (state === "running") return true
  // No service to start: an elevation prompt would only fail behind the user's back.
  if (state === "missing") return false

  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }

  const accepted = await new Promise<boolean>((resolve) => {
    const child = spawn(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `try { Start-Process -FilePath sc.exe -ArgumentList 'start','${SERVICE}' -Verb RunAs -WindowStyle Hidden -Wait -ErrorAction Stop; exit 0 } catch { exit 1 }`,
      ],
      { windowsHide: true, stdio: "ignore" },
    )
    child.on("error", () => resolve(false))
    child.on("exit", (code) => resolve(code === 0))
  })

  if (!accepted) return false

  for (let poll = 0; poll < 30; poll++) {
    if (await running()) return true
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  return false
}
