export * as GhostEngine from "./ghost.js"

import { Context, Effect, Layer, Option } from "effect"
import { spawn } from "node:child_process"
import { Resolver } from "node:dns/promises"
import { closeSync, existsSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs"
import { appendFile, readFile, stat, unlink, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Ghost } from "@opencode/schema/ghost"
import { Flag } from "./flag.js"
import { GhostEgress } from "./ghost-egress.js"

// The ghost engine is OpenCode's port of the desktop bat's own double-click program: take
// the shared lock, make sure WARP's daemon is up, flip the UTC day file when the quota
// renewed, dedupe the WARP egress against the day's memory until an unseen /64 lands, then
// pin opencode.ai over it when no live session already manages the exit. It shares every
// state file the bat and its monitor use — same lock, same memory, same events, same day
// file — so the button and the bat never rotate at once and never count one /64 twice.
// What it deliberately does not port: the app kill+relaunch, the window hide, the winget
// install and the matinal task. This runs inside OpenCode itself, so a failed rotation is
// an honest ok:false on the button — never a closed app.

const WARP_CLI = join(process.env.ProgramFiles ?? "C:\\Program Files", "Cloudflare", "Cloudflare WARP", "warp-cli.exe")
const HOSTS = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "drivers", "etc", "hosts")
const MEMORY_LOG = join(homedir(), "opencode-warp-ips.log")
const EVENT_LOG = join(homedir(), "ghost-eventos.log")
const DAY_FILE = join(homedir(), "ghost-dia.txt")
const HISTORY_FILE = join(homedir(), "ghost-historial.jsonl")
const PIN_LOG = join(homedir(), "ghost-pin.log")
const LOCK_FILE = join(tmpdir(), "ghost.lock")
const EPOCH_FILE = join(tmpdir(), "ghost.epoch")

const PIN_DEFAULT = "2606:4700:78::90:0:141"
// The bat's literal fallback order after the resolve and the verified-pin cache: 141, 140, 142.
const PIN_LITERALS = ["2606:4700:78::90:0:141", "2606:4700:78::90:0:140", "2606:4700:78::90:0:142"]

const MAX_ATTEMPTS = 10
const TRACE_TRIES = 20
const DISCONNECT_POLLS = 4
const DAEMON_POLLS = 6

// The bat's lock helper writes its own PowerShell's PID and exits at once, so a lock the bat
// holds always names a dead process. A lock younger than a whole worst-case run (ten attempts of
// up to ~3 min each) still belongs to a run in progress, whoever wrote it.
const LOCK_FRESH_MS = 30 * 60_000

// Bounded timeouts for external commands: warp-cli has no --max-time of its own, and a
// hung child would otherwise hold the ghost lock for the whole stale-lock window. curl
// keeps its own --max-time and is left unbounded here.
const WARP_VERB_TIMEOUT_MS = 30_000
const SERVICE_CONTROL_TIMEOUT_MS = 60_000
const POWERSHELL_TIMEOUT_MS = 30_000
const QUICK_COMMAND_TIMEOUT_MS = 15_000

// The apps a ghost session serves: the official OpenCode the bat launches, Openbot itself and
// its dev build. The monitor's process watch carries the same names.
const APP_IMAGES = ["opencode.exe", "opencode dev.exe", "openbot.exe", "openbot dev.exe"]

type Salida = { status: number; stdout: string }
/** One shield trace's exit facts (the `ip=` value and, when present, `warp=`). */
type Traza = { ip: string; warp?: string }
/** One landed rotation: the probe's exact exit address and its /64 bucket. */
type Ganada = { ip: string; bucket: string }

const textLines = (body: string) => body.split(/\r?\n/).filter((line) => line.length > 0)

const stamp = () => {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
}

const evt = (message: string) => Effect.asVoid(appendLine(EVENT_LOG, `[${stamp()}] ${message}`))

const appendLine = (file: string, line: string, encoding: BufferEncoding = "utf8") =>
  Effect.promise(() => appendFile(file, `${line}\n`, encoding))

/** A missing file reads as none — several of the shared files may not exist yet. */
const readText = (file: string, encoding: BufferEncoding = "utf8") =>
  Effect.option(Effect.tryPromise(() => readFile(file, encoding)))

const textOf = (file: string, encoding: BufferEncoding = "utf8") =>
  Effect.gen(function* () {
    return Option.getOrUndefined(yield* readText(file, encoding)) ?? ""
  })

const linesOf = (file: string, encoding: BufferEncoding = "utf8") =>
  Effect.gen(function* () {
    return textLines(Option.getOrUndefined(yield* readText(file, encoding)) ?? "")
  })

const writeText = (file: string, body: string, encoding: BufferEncoding = "utf8") =>
  Effect.promise(() => writeFile(file, body, encoding))

const erase = (file: string) =>
  Effect.gen(function* () {
    if (existsSync(file)) yield* Effect.asVoid(Effect.promise(() => unlink(file)))
  })

/** Runs one console command collecting its status and stdout. A child that cannot start
 * reports as a failed exit rather than defecting. An optional bound kills the process and
 * resolves as a failed exit (-1) once it elapses, so a hung warp-cli can no longer hold the
 * ghost lock; curl keeps its own --max-time and is left unbounded. */
const run = (command: string, args: readonly string[], timeoutMs?: number) =>
  Effect.promise<Salida>(
    () =>
      new Promise((done) => {
        let stdout = ""
        const child = spawn(command, args, { windowsHide: true })
        let settled = false
        const finish = (result: Salida) => {
          if (settled) return
          settled = true
          if (timer !== undefined) clearTimeout(timer)
          done(result)
        }
        child.stdout?.on("data", (chunk) => (stdout += String(chunk)))
        child.on("error", () => finish({ status: -1, stdout }))
        child.on("close", (status) => finish({ status: status ?? -1, stdout }))
        let timer: ReturnType<typeof setTimeout> | undefined
        if (timeoutMs !== undefined) {
          timer = setTimeout(() => {
            // An already-exited child takes the kill as a false, not a throw.
            child.kill()
            finish({ status: -1, stdout })
          }, timeoutMs)
        }
      }),
  )

const warp = (cli: string, args: readonly string[], timeoutMs?: number) => Effect.asVoid(run(cli, args, timeoutMs))

/** The shield's own trace: one curl fired until an `ip=` shows — exactly the bat's 20
 * shots with the 1 s breath between them. */
const sondear = (): Effect.Effect<Option.Option<Traza>> =>
  Effect.gen(function* () {
    for (let turn = 0; turn < TRACE_TRIES; turn++) {
      const salida = yield* run("curl", ["-6", "-s", "--max-time", "8", "https://cloudflare.com/cdn-cgi/trace"])
      const ip = trazo("ip", salida.stdout)
      if (ip !== undefined) return Option.some({ ip, warp: trazo("warp", salida.stdout) })
      yield* Effect.sleep("1 second")
    }
    return Option.none()
  })

const trazo = (clave: string, cuerpo: string) => {
  const line = cuerpo.split(/\r?\n/).find((line) => line.toLowerCase().startsWith(`${clave}=`))
  return line?.slice(clave.length + 1).trim()
}

/** opencode.ai's trace only proves a pin when curl itself exits clean. */
const tracerOk = (seconds: number) =>
  Effect.map(
    run("curl", ["-6", "-s", "--max-time", String(seconds), "https://opencode.ai/cdn-cgi/trace"]),
    (salida) => salida.status === 0,
  )

/** The /64 bucket: the first four hextets of the expanded address — the bat's own
 * `[System.Net.IPAddress]` form (`2a09:bac5:6de7:31e1`). */
const cubo = (ip: string) => {
  const mitad = ip.indexOf("::")
  const left = mitad >= 0 ? (ip.slice(0, mitad) === "" ? [] : ip.slice(0, mitad).split(":")) : ip.split(":")
  const right = mitad >= 0 ? (ip.slice(mitad + 2) === "" ? [] : ip.slice(mitad + 2).split(":")) : []
  if (left.length + right.length > 8) return undefined
  const huecos = Math.max(8 - left.length - right.length, 0)
  const segs = [...left, ...Array.from({ length: huecos }, () => "0"), ...right]
  if (segs.length !== 8) return undefined
  const bytes: number[] = []
  for (const seg of segs) {
    const value = Number.parseInt(seg === "" ? "0" : seg, 16)
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff) return undefined
    bytes.push(value >> 8, value & 0xff)
  }
  const hextet = (at: number) => (bytes[at] * 256 + bytes[at + 1]).toString(16)
  return `${hextet(0)}:${hextet(2)}:${hextet(4)}:${hextet(6)}`
}

/** The bat's `dir /b /s` fallback lives behind one PowerShell search; the default path
 * short-circuits it. */
const locateWarpCli = Effect.gen(function* () {
  if (existsSync(WARP_CLI)) return WARP_CLI
  const salida = yield* run(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "Get-ChildItem -Path ($env:ProgramFiles + '\\Cloudflare') -Filter warp-cli.exe -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName",
    ],
    POWERSHELL_TIMEOUT_MS,
  )
  return textLines(salida.stdout)[0] ?? ""
})

/** The bat's :havewarp preflight: both service names poked, a 3 s breath, the event tail
 * trimmed to its bound, then the daemon's own "Status update" heartbeat — a service that
 * will not answer is caught here instead of costing the whole ladder. */
const preflight = (cli: string) =>
  Effect.gen(function* () {
    yield* Effect.asVoid(run("net", ["start", "CloudflareWARP"], SERVICE_CONTROL_TIMEOUT_MS))
    yield* Effect.asVoid(run("net", ["start", "Cloudflare WARP"], SERVICE_CONTROL_TIMEOUT_MS))
    yield* Effect.sleep("3 seconds")
    yield* podarEventos
    for (let turn = 0; turn < DAEMON_POLLS; turn++) {
      const salida = yield* run(cli, ["status"], WARP_VERB_TIMEOUT_MS)
      if (salida.stdout.includes("Status update")) return true
      yield* Effect.sleep("1 second")
    }
    return false
  })

const podarEventos = Effect.gen(function* () {
  const lines = yield* linesOf(EVENT_LOG)
  if (lines.length > 200) yield* writeText(EVENT_LOG, `${lines.slice(-200).join("\n")}\n`)
})

/** Midnight UTC: one first-line read, one write back, and the day's memory wiped when the
 * day moved — the /64 history stops counting the instant the counter does. */
const girarDia = Effect.gen(function* () {
  const hoy = new Date().toISOString().slice(0, 10)
  const anterior = (yield* textOf(DAY_FILE)).split(/\r?\n/)[0] ?? ""
  yield* writeText(DAY_FILE, `${hoy}\n`)
  if (anterior.length > 0 && anterior !== hoy) {
    yield* erase(MEMORY_LOG)
    yield* evt("dia UTC nuevo: memoria de /64 borrada - la cuota se ha renovado")
  }
})

const ajustarMemoria = Effect.gen(function* () {
  const lines = yield* linesOf(MEMORY_LOG)
  if (lines.length <= 60) return
  yield* writeText(MEMORY_LOG, `${lines.slice(-50).join("\n")}\n`)
  yield* evt("memoria de /64 ajustada: se queda con los ultimos 50")
})

/** Whether this exact bucket already sits in the memory — read fresh on every attempt, so
 * a bucket one attempt records counts for the next one, exactly as the bat's findstr did. */
const recordado = (bucket: string) =>
  Effect.map(linesOf(MEMORY_LOG), (lines) => lines.includes(bucket))

/** Reads the hosts with latin1 so the user's own bytes round-trip through unpin and
 * rewrite untouched. A failed read is a none: every writer below refuses to touch the
 * file when it could not read what stands there. */
const hostText = readText(HOSTS, "latin1")

/** The pincheck regex is the bat's helper's own: a hex-led line naming opencode-pin. A
 * hosts read that failed reads as no pin — nothing writes against a file it cannot see. */
const pinVivo = Effect.gen(function* () {
  const texto = yield* hostText
  return Option.isSome(texto) && /^[0-9A-Fa-f]{2}.*opencode-pin/m.test(texto.value)
})

const despintar = Effect.gen(function* () {
  const texto = yield* hostText
  if (Option.isNone(texto)) {
    yield* evt("hosts: la lectura fallo - no se reescribe el archivo")
    return false
  }
  yield* writeText(HOSTS, texto.value.replace(/^.*opencode-pin.*\r?\n?/gm, ""), "latin1")
  yield* Effect.asVoid(run("ipconfig", ["/flushdns"], QUICK_COMMAND_TIMEOUT_MS))
  yield* evt("hosts: pin quitado y flushdns")
  // Re-read after writing and flushing: only a read that proves the pin line is gone counts.
  const despues = yield* hostText
  if (Option.isNone(despues)) return false
  return !/^[0-9A-Fa-f]{2}.*opencode-pin/m.test(despues.value)
})

const marcadoresFijos = linesOf(PIN_LOG).pipe(Effect.map((lines) => lines.slice(-3)))

/** opencode.ai's AAAA at 1.1.1.1, the bat's Resolve-DnsName ask; a failure falls to the
 * week's literal. */
const dirigirAAAA = Effect.option(
  Effect.tryPromise({
    try: () => {
      const resolver = new Resolver({ timeout: 4_000, tries: 1 })
      resolver.setServers(["1.1.1.1"])
      return resolver.resolve6("opencode.ai")
    },
    // A refusal from the resolver is not a rotation failure by itself: the literal
    // ladder still stands. Any error folds into none.
    catch: (cause) => cause,
  }),
).pipe(Effect.map(Option.map((addresses) => addresses[0])))

/** The pin flow verbatim from the bat: fresh bak first, then the three sources in order,
 * each one written to the hosts, flushed and curl-proved before it may stay. */
const asegurarPin = Effect.gen(function* () {
  if (yield* pinVivo) return
  yield* despintar
  const hostsAhora = yield* hostText
  if (Option.isNone(hostsAhora)) {
    yield* evt("pin: la lectura de hosts fallo - el bak y el pin no se escriben")
    return
  }
  yield* writeText(`${HOSTS}.bak`, hostsAhora.value, "latin1")
  const resuelta = yield* dirigirAAAA
  const primero = Option.getOrUndefined(resuelta) ?? PIN_DEFAULT
  if (Option.isNone(resuelta)) yield* evt("pin: resolucion AAAA fallo - uso el literal")
  const marcadores = yield* marcadoresFijos
  for (const candidato of [primero, ...marcadores, ...PIN_LITERALS]) {
    // The pin lands on its own line: a hosts file ending without a newline would glue it
    // onto the user's last entry — the pin check would miss that line, and the unpin's
    // line-wide removal would take the user's entry with it. A read that fails writes
    // nothing at all: the ladder stops instead of guessing what stands in the file.
    const previo = yield* hostText
    if (Option.isNone(previo)) {
      yield* evt("pin: la lectura de hosts fallo - el pin no se escribe")
      return
    }
    const salto = previo.value.length > 0 && !previo.value.endsWith("\n") ? "\n" : ""
    yield* appendLine(HOSTS, `${salto}${candidato} opencode.ai # opencode-pin`, "latin1")
    yield* Effect.asVoid(run("ipconfig", ["/flushdns"], QUICK_COMMAND_TIMEOUT_MS))
    if (yield* tracerOk(6)) {
      yield* appendLine(PIN_LOG, candidato)
      yield* evt(`pin: ${candidato} apunta a opencode.ai - verificado con curl`)
      return
    }
    yield* evt(`pin: ${candidato} no respondio - pruebo el siguiente candidato`)
    const quitado = yield* despintar
    if (!quitado) {
      yield* evt("pin: no pudo quitarse la linea anterior - no apilo otra")
      return
    }
  }
})

/** The hidden session monitor is the bat's own one-liner: an epoch swap retires it, its
 * app watch (OpenCode the bat launches, Openbot this fork serves) drops the pin when the
 * session's app goes, and ten seconds later it hangs WARP up — leaving the service alone,
 * so the next rotation needs no elevation. Only a NEW session's epoch retires it. */
const monitorCommand = (cli: string) =>
  `$t0=Get-Date; $e=$env:TEMP+'\\ghost.epoch'; $mine=Get-Content $e -First 1 -ErrorAction SilentlyContinue; Start-Sleep 20; $m=0; while ($m -lt 2) { if (((Get-Content $e -First 1 -ErrorAction SilentlyContinue)) -ne $mine) { Add-Content ($env:USERPROFILE+'\\ghost-eventos.log') ('['+(Get-Date -Format 'dd/MM/yyyy HH:mm:ss')+'] monitor: retirado por epoch nueva - sesion sustituida o stop manual'); exit }; if (Get-Process -Name 'OpenCode','OpenCode Dev','Openbot','Openbot Dev' -ErrorAction SilentlyContinue) { $m=0 } else { $m++ }; Start-Sleep 3 }; $h=$env:windir+'\\System32\\drivers\\etc\\hosts'; (Get-Content $h) -notmatch 'opencode-pin' | Out-File -Encoding ascii $h; ipconfig /flushdns; Add-Content ($env:USERPROFILE+'\\ghost-eventos.log') (('['+(Get-Date -Format 'dd/MM/yyyy HH:mm:ss')+'] sesion cerrada: pin fuera de hosts y flushdns (duracion ' + [int]((New-TimeSpan $t0 (Get-Date)).TotalMinutes) + ' min)')); Start-Sleep 10; if (-not (Get-Process -Name 'OpenCode','OpenCode Dev','Openbot','Openbot Dev' -ErrorAction SilentlyContinue)) { & '${cli}' disconnect; Add-Content ($env:USERPROFILE+'\\ghost-eventos.log') (('['+(Get-Date -Format 'dd/MM/yyyy HH:mm:ss')+'] WARP desconectado - el pin fuera de hosts y el servicio queda para la proxima rotacion (duracion ' + [int]((New-TimeSpan $t0 (Get-Date)).TotalMinutes) + ' min)')) }`

/** The spawn must keep the bat's own `-WindowStyle Hidden` shape: the monitor counter the
 * engine and the bat share (the `mon` helper) recognizes exactly that command line. */
const spawnMonitor = (cli: string) =>
  Effect.sync(() => {
    spawn("powershell", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", monitorCommand(cli)], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref()
  })

const digito = () => Math.floor(Math.random() * 32768)
const epochNueva = () => writeText(EPOCH_FILE, `${digito()}${digito()}\n`)

const contarMonitores = () =>
  Effect.map(
    run(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "@(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { ($_.CommandLine -ne $null) -and ($_.CommandLine -match 'ghost.epoch') -and ($_.CommandLine -match '-WindowStyle Hidden') -and ($_.ProcessId -ne $PID) }).Count",
      ],
      POWERSHELL_TIMEOUT_MS,
    ),
    (salida) => {
      const cuenta = Number.parseInt(salida.stdout.trim(), 10)
      return Number.isSafeInteger(cuenta) && cuenta > 0 ? cuenta : 0
    },
  )

const contarApp = () =>
  Effect.map(run("tasklist", ["/FO", "CSV", "/NH"], QUICK_COMMAND_TIMEOUT_MS), (salida) => {
    const lower = salida.stdout.toLowerCase()

    return APP_IMAGES.some((image) => lower.includes(`"${image}"`))
  })

const createLock = Effect.option(
  Effect.try(() => {
    const fd = openSync(LOCK_FILE, "wx")
    writeSync(fd, String(process.pid))
    closeSync(fd)
  }),
).pipe(Effect.map(Option.isSome))

/** The bat's lock helper translated: an exclusive create, a live-holder check on the pid
 * it holds, one stale recycle, and one retry — the same LOCKOK / LOCKOK-2 ladder. */
const librarCerrojo = Effect.gen(function* () {
  if (yield* createLock) return true
  const holder = Number.parseInt((yield* textOf(LOCK_FILE)).split(/\r?\n/)[0] ?? "", 10)

  if (Number.isSafeInteger(holder) && holder > 0 && (yield* pidVivo(holder))) return false

  const escrito = yield* Effect.option(Effect.tryPromise(() => stat(LOCK_FILE)))

  if (Option.isSome(escrito) && Date.now() - escrito.value.mtimeMs < LOCK_FRESH_MS) return false
  yield* erase(LOCK_FILE)
  return yield* createLock
})

const pidVivo = (pid: number) =>
  Effect.map(Effect.option(Effect.try(() => process.kill(pid, 0))), Option.isSome)

/** The append-open probe is the bat's `net session` stand-in: it answers whether this
 * process may write the hosts at all (the pin section's one real elevation need). */
const hostPermite = Effect.option(
  Effect.try(() => {
    const fd = openSync(HOSTS, "a")
    closeSync(fd)
  }),
).pipe(Effect.map(Option.isSome))

/** One finished rotation, one JSON line: the settings page's history and its day count read
 * this. Optional fields drop out by the stringify itself, and the file is the engine's own
 * — the bat keeps its truth in the event log, which the first page read migrates here. */
const registrar = (
  salida: Ghost.RotateResult,
  origin: Ghost.RotateOrigin | undefined,
  previa: string | undefined,
  started: number,
  intento: number,
) =>
  Effect.asVoid(
    appendLine(
      HISTORY_FILE,
      JSON.stringify({
        at: started,
        origin: origin ?? "manual",
        ok: salida.ok,
        attempts: intento,
        durationMs: Date.now() - started,
        ...(previa !== undefined ? { from: previa } : {}),
        ...(salida.ok && salida.address !== undefined ? { to: cubo(salida.address) } : {}),
      }),
    ),
  )

/** The status read answers from the shared files and WARP's own client — nothing is written
 * and nothing is rotated, so an open page may poll it. The day's count is the memory: the
 * counter wipes it the instant its day turned. */
const estado = (state: { runs: number; attempt: number }) =>
  Effect.gen(function* () {
    const hoy = new Date().toISOString().slice(0, 10)
    const dia = (yield* textOf(DAY_FILE)).split(/\r?\n/)[0] ?? ""
    const memoria = dia === hoy ? yield* linesOf(MEMORY_LOG) : []
    let warp: Ghost.Status["warp"] = process.platform === "win32" && existsSync(WARP_CLI) ? "unavailable" : "missing"

    if (warp === "unavailable") {
      const consulta = yield* run("sc", ["query", "CloudflareWARP"], SERVICE_CONTROL_TIMEOUT_MS)

      if (/RUNNING|START_PENDING/.test(consulta.stdout)) {
        const salida = yield* run(WARP_CLI, ["status"], WARP_VERB_TIMEOUT_MS)

        if (salida.stdout.includes("Status update: Connected")) warp = "connected"
        else if (salida.stdout.includes("Disconnected")) warp = "disconnected"
      }
    }

    return {
      warp,
      rotating: state.runs > 0,
      attempts: MAX_ATTEMPTS,
      attempt: state.runs > 0 && state.attempt > 0 ? state.attempt : undefined,
      rotations: memoria.length,
      current: memoria.length > 0 ? memoria[memoria.length - 1] : undefined,
      pin: (yield* pinVivo) || undefined,
    } satisfies Ghost.Status
  })

/** Today's landed rotations from the event log, one JSON line each: the bat and this engine
 * land with the same words, so one pattern catches both. */
const seed = (events: string) => {
  const ahora = new Date()
  const cotizada = [
    String(ahora.getDate()).padStart(2, "0"),
    String(ahora.getMonth() + 1).padStart(2, "0"),
    String(ahora.getFullYear()).padStart(4, "0"),
  ]
  const aterrizada = /^\[(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})\] (?:sesion|rotate): \/64 nuevo (\S+)/
  const runs: string[] = []

  for (const line of existsSync(events) ? textLines(readFileSync(events, "utf8")) : []) {
    const partes = aterrizada.exec(line)

    if (partes === null) continue
    if (partes[1] !== cotizada[0] || partes[2] !== cotizada[1] || partes[3] !== cotizada[2]) continue

    runs.push(
      JSON.stringify({
        at: new Date(
          Number(partes[3]),
          Number(partes[2]) - 1,
          Number(partes[1]),
          Number(partes[4]),
          Number(partes[5]),
          Number(partes[6]),
        ).getTime(),
        origin: "manual",
        ok: true,
        to: partes[7],
        attempts: 1,
        durationMs: 0,
      }),
    )
  }

  writeFileSync(HISTORY_FILE, `${runs.join("\n")}${runs.length > 0 ? "\n" : ""}`)
}

/** The engine's own history, oldest first. The first read on a machine whose runs predate
 * this log migrates today's landed rotations out of the event log, synchronously — a second
 * reader finds the file already there. */
const historial = () =>
  Effect.gen(function* () {
    if (!existsSync(HISTORY_FILE)) seed(EVENT_LOG)

    const runs: Ghost.Run[] = []
    for (const line of textLines(Option.getOrUndefined(yield* readText(HISTORY_FILE)) ?? "")) {
      const option = yield* Effect.option(Effect.try(() => JSON.parse(line) as Ghost.Run))

      if (Option.isSome(option)) runs.push(option.value)
    }

    return runs
  })

export interface Interface {
  /** Runs the desktop bat's rotation program once. Failures are ordinary outcomes
   * (ok:false): the ladder exhausted, a dead tunnel, a daemon that does not answer, or an
   * egress that stopped serving the app. A concurrent run retires via the shared lock. The
   * origin says who asked — the ring's button or the gateway's limit — and is
   * recorded in the run's history only. */
  readonly rotate: (origin?: Ghost.RotateOrigin) => Effect.Effect<Ghost.RotateResult>
  /** Ends the exit's job when the free day renewed for this machine's own address: the pin
   * comes off the hosts and the WARP tunnel hangs up, so the app rides its own address
   * again. The answer reads ok:false — WARP left up, nothing touched — when a rotation is
   * running, the ghost flag is off, the hosts file cannot be read (a pin may stand that
   * nothing would then serve), the pin stands and cannot be removed, or the disconnect
   * never lands; the caller asks again after its next status read. The tunnel hangs up only
   * over verifiably clean hosts: a disconnect over a live pin would leave the pinned
   * address pointing at a dead tunnel. */
  readonly release: () => Effect.Effect<Ghost.ReleaseResult>
  /** What the engine and WARP answer right now — the shared files, the service and one
   * client probe. It writes nothing and never rotates, so an open page may poll it. */
  readonly status: Effect.Effect<Ghost.Status>
  /** This engine's finished runs, oldest first, for a rotation page's history list. */
  readonly history: Effect.Effect<readonly Ghost.Run[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/GhostEngine") {}

export const layer = () =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      // A counter, not a boolean: a concurrent run the lock retires must not turn the page's
      // indicator off while the winning run is still working.
      const flags = yield* Flag.Service
      // Captured while the graph builds: the egress is a dependency of this node, while the
      // rotate effect itself runs in the caller's context, where it is not a service of its own.
      const egress = yield* Effect.serviceOption(GhostEgress.Service)
      const state = { runs: 0, attempt: 0 }
      const rotate = (origin?: Ghost.RotateOrigin) =>
        Effect.gen(function* () {
          if (!(yield* flags.enabled("ghost"))) {
            yield* evt("rotate: ghost deshabilitado por flag")
            return { ok: false } satisfies Ghost.RotateResult
          }
          return yield* Effect.ensuring(
            Effect.gen(function* () {
              const started = Date.now()
              const memoria = yield* linesOf(MEMORY_LOG)
              state.runs += 1
              state.attempt = 0
              const salida = yield* programar((intento) => {
                state.attempt = intento
              }, egress)

              yield* registrar(
                salida,
                origin,
                memoria.length > 0 ? memoria[memoria.length - 1] : undefined,
                started,
                state.attempt,
              )
              return salida
            }),
            Effect.sync(() => {
              state.runs -= 1
            }),
          )
        })

      return { status: estado(state), history: historial(), rotate, release: () => soltar(flags, egress) } satisfies Interface
    }),
  )

export const node = makeLocationNode({ service: Service, layer: layer(), deps: [Flag.node, GhostEgress.node] })

/** Boot-scope mount for the server's boot graph, which binds no location: same engine and gate, fed by boot flags.
 * Same tag as `node` so the boot graph can swap them. */
export const bootNode = makeLocationNode({ service: Service, layer: layer(), deps: [Flag.boot, GhostEgress.node] })

/** One rotate call owns its lock claim in its own closure, so the finalizer releases
 * exactly the lock this run took and nothing else's. The probe reports each ladder attempt,
 * read-only: a page polls "3/10" while a run lasts. */
const programar = (
  señal: (intento: number) => void,
  egress: Option.Option<GhostEgress.Interface>,
): Effect.Effect<Ghost.RotateResult> => {
  const own = { lock: false }
  const release = Effect.gen(function* () {
    if (!own.lock) return
    own.lock = false
    yield* erase(LOCK_FILE)
  })

  const done = Effect.gen(function* () {
    if (process.platform !== "win32") return { ok: false }

    // ---- the shared cerrojo: a live second run retires with its own event line ----
    if (!(yield* librarCerrojo)) {
      yield* evt("cerrojo: rotate descartado - ya hay un run en marcha")
      return { ok: false }
    }
    own.lock = true

    // ---- warp-cli: the bat would install WARP here; the engine refuses, honestly ----
    const cli = yield* locateWarpCli
    if (cli === "") {
      yield* evt("rotate: warp-cli no encontrado - imposible rotar")
      return { ok: false }
    }

    // ---- :havewarp ----
    if (!(yield* preflight(cli))) {
      yield* evt("abortar: daemon WARP inalcanzable tras el net start")
      return { ok: false }
    }

    yield* girarDia
    yield* ajustarMemoria
    yield* warp(cli, ["--accept-tos", "mode", "warp"], WARP_VERB_TIMEOUT_MS)

    // ---- the session the rotation serves: a live app, and the bat's own monitor when one still
    // watches it. Neither the pin nor that monitor is a condition of the rotation any more — the
    // egress below carries it — so a machine that never granted the hosts write rotates too. ----
    const appViva = yield* contarApp()
    const monitores = yield* contarMonitores()
    if (appViva && monitores > 0) yield* evt("auto-hot: sesion viva detectada - rotacion en caliente de su /64")

    const puedeHosts = yield* hostPermite
    let ganada: Ganada | undefined = undefined
    let sinIp = 0
    let repetidos = 0

    // ---- the ladder: MAX_ATTEMPTS of dedupe against the day's memory; one label each
    // and, exactly on the swings with no IP at all, the re-registration rescue ----
    for (let intento = 1; intento <= MAX_ATTEMPTS && ganada === undefined; intento++) {
      señal(intento)
      yield* warp(cli, ["disconnect"], WARP_VERB_TIMEOUT_MS)
      for (let poll = 0; poll < DISCONNECT_POLLS; poll++) {
        const salida = yield* run(cli, ["status"], WARP_VERB_TIMEOUT_MS)
        if (salida.stdout.includes("Disconnected")) break
        yield* Effect.sleep("1 second")
      }
      yield* warp(cli, ["connect"], WARP_VERB_TIMEOUT_MS)

      const cuerpo = Option.getOrUndefined(yield* sondear())
      const ip = cuerpo?.ip
      const warpFlag = cuerpo?.warp
      const bucket = ip !== undefined ? cubo(ip) : undefined
      const vista = bucket !== undefined ? yield* recordado(bucket) : false

      if (warpFlag === "on" && ip !== undefined && bucket !== undefined && !vista) {
        ganada = { ip, bucket }
        break
      }
      if (ip !== undefined) repetidos++
      else sinIp++
      if (bucket !== undefined && !vista) yield* appendLine(MEMORY_LOG, bucket)
      yield* evt(
        bucket === undefined
          ? `intento ${intento}: sin IP de WARP`
          : vista
            ? `intento ${intento}: /64 ${bucket} repetido`
            : `intento ${intento}: /64 ${bucket} fuera de WARP (warp=${warpFlag ?? "?"})`,
      )
      if (ip === undefined) {
        yield* evt("rescate: re-registro de WARP")
        yield* warp(cli, ["registration", "delete"], WARP_VERB_TIMEOUT_MS)
        yield* Effect.sleep("3 seconds")
        yield* warp(cli, ["--accept-tos", "registration", "new"], WARP_VERB_TIMEOUT_MS)
        yield* Effect.sleep("5 seconds")
      }
    }

    if (ganada === undefined) {
      yield* warp(cli, ["disconnect"], WARP_VERB_TIMEOUT_MS)
      yield* evt(
        sinIp >= repetidos
          ? `fin sin conectar: ${sinIp} intentos sin IP`
          : `pool agotado: ${repetidos} bloques repetidos`,
      )
      return { ok: false }
    }

    // ---- the hot egress: a fresh /64 only serves the app when its next gateway request leaves
    // by it. The egress opens the gateway over a verified IPv6 and drops every pooled socket, so
    // the app's next step rides the new exit with no reload, no hosts write and no elevation.
    // The answer is real only when that same path answers over IPv6 inside WARP; anything else is
    // an honest ok:false, never a rotation that cannot serve the app.
    yield* appendLine(MEMORY_LOG, ganada.bucket)
    const resuelta = yield* dirigirAAAA

    // An embedder's graph may mount no egress at all: the old trace verdict is all that stands
    // there, and nothing is promised about the app's path.
    if (Option.isNone(egress)) {
      yield* evt("egress: el grafo no monto el transporte - veredicto solo por traza")
      return (yield* tracerOk(8)) ? { ok: true, address: ganada.ip } : { ok: false }
    }

    const apuntado = yield* egress.value.point([...Option.toArray(resuelta), ...PIN_LITERALS])

    if (Option.isNone(apuntado)) {
      yield* evt("egress: ningun IPv6 de opencode.ai respondio - la rotacion no sirve a la app")
      if (puedeHosts) yield* despintar
      return { ok: false }
    }

    // The pin stays for the machines that may write it — the bat's own hygiene, and the path the
    // desktop app's own resolver still reads. It is no longer what makes the rotation work.
    if (puedeHosts) yield* asegurarPin

    // The monitor is the session's hygiene, not the pin's: on a live app it rides along whether or
    // not this process could pin, so the exit is let go when that app closes. A session with no
    // app to watch would only ever stop the service behind a false alarm.
    if (appViva) {
      yield* epochNueva()
      yield* spawnMonitor(cli)
    }

    yield* evt(`rotate: /64 nuevo ${ganada.bucket} en caliente - OpenCode intacto (salida ${apuntado.value.exit})`)
    return { ok: true, address: ganada.ip }
  })

  return Effect.ensuring(Effect.uninterruptible(done), release)
}

/** The episode's close: the day renewed for the machine's own address, so the pin comes off
 * the hosts and the WARP tunnel hangs up — the app rides its own address again, and a later
 * limit error rotates back the same way. The disconnect is checked the ladder's way (a status
 * poll until "Disconnected" shows): an answer that stays up turns ok:false, so its caller asks
 * again. A pin that cannot be removed is never overridden by a disconnect: with the pin still
 * steering opencode.ai at a WARP IPv6, taking the tunnel down would leave opencode.ai
 * unresolvable, so the release returns ok:false and leaves WARP up — the ring's retries ask
 * again. Only when the pin is already out (or never was) does the disconnect run. A rotation
 * running right now keeps its exit: this retires through the lock's busy check. The service is
 * left running, so the next rotation never raises an elevation prompt. */
const soltar = (
  flags: Flag.Interface,
  egress: Option.Option<GhostEgress.Interface>,
): Effect.Effect<Ghost.ReleaseResult> => {
  const own = { lock: false }
  const drop = Effect.gen(function* () {
    if (!own.lock) return
    own.lock = false
    yield* erase(LOCK_FILE)
  })

  const done = Effect.gen(function* () {
    if (process.platform !== "win32") return { ok: false }

    if (!(yield* librarCerrojo)) {
      yield* evt("release: descartado - ya hay un run en marcha")
      return { ok: false }
    }
    own.lock = true

    // Gate: ghost flag.
    if (!(yield* flags.enabled("ghost"))) {
      yield* evt("release: ghost deshabilitado por flag")
      return { ok: false }
    }

    // An unreadable hosts file cannot prove or disprove a pin: with a pin possibly standing,
    // disconnecting would leave it pointing at a WARP address nothing serves — so the release
    // refuses and leaves the working tunnel up, exactly as it does for a pin it cannot remove.
    const hostsAhora = yield* hostText
    if (Option.isNone(hostsAhora)) {
      yield* evt("release: la lectura de hosts fallo - el pin no se puede verificar - WARP se deja arriba")
      return { ok: false }
    }

    if (/^[0-9A-Fa-f]{2}.*opencode-pin/m.test(hostsAhora.value)) {
      if (!(yield* hostPermite)) {
        yield* evt("release: pin vivo y hosts deniega la escritura - WARP se deja arriba")
        return { ok: false }
      }
      const quitado = yield* despintar
      if (!quitado) {
        yield* evt("release: pin: no pudo quitarse la linea - WARP se deja arriba")
        return { ok: false }
      }
    }

    const cli = yield* locateWarpCli
    if (cli === "") {
      if (Option.isSome(egress)) yield* egress.value.release
      yield* evt("release: sin warp-cli - el pin fuera y la salida ya es la propia del equipo")
      return { ok: true }
    }

    // The hot egress goes with the pin, before the tunnel: the gateway returns to the machine's
    // own route, so no request is left aimed at an address the disconnect is about to take away.
    if (Option.isSome(egress)) yield* egress.value.release

    yield* warp(cli, ["disconnect"], WARP_VERB_TIMEOUT_MS)
    let colgado = false
    for (let poll = 0; poll < DISCONNECT_POLLS; poll++) {
      const salida = yield* run(cli, ["status"], WARP_VERB_TIMEOUT_MS)
      if (salida.stdout.includes("Disconnected")) {
        colgado = true
        break
      }
      yield* Effect.sleep("1 second")
    }

    if (!colgado) {
      yield* evt("release: WARP sigue conectado tras el disconnect - reintenten las llamadas")
      return { ok: false }
    }

    yield* evt("release: WARP desconectado - la salida vuelve a la propia del equipo (servicio arriba)")
    return { ok: true }
  })

  return Effect.ensuring(Effect.uninterruptible(done), drop)
}
