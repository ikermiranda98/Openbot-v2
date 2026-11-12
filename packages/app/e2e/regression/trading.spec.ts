import { expect, test } from "@playwright/test"
import type { Trading } from "@opencode/schema/trading"
import { SERVER, sessionHref, tradingNewHref } from "../utils/app"
import { mockTradingSnapshot, mockTradingSnapshotDown } from "../utils/mock-server"
import { mockWorkspace } from "../utils/workspace"

test("the trading desk reads its demo snapshot and keeps the pool's mass start gated", async ({ page }) => {
  // The trading engine never lives in these fixtures: the snapshot read answers as a
  // service down would, and the desk keeps its own demo showcase.
  await mockWorkspace(page, { name: "Trading", seed: { servers: [SERVER] } })
  mockTradingSnapshotDown(page)
  await page.goto(tradingNewHref())

  // The desk itself owns that fallback: opening the account's own dossier names the demo
  // paper account.
  await page.getByRole("button", { name: "Account details" }).click()
  await expect(page.getByText("Demo (paper) · IBKR")).toBeVisible()

  // The demo pool reuses real ids, so the desk stays read-only: opening the systems' panel
  // shows the pool's mass start waiting, disabled, until a real engine answers.
  await page.getByRole("button", { name: "Systems", exact: true }).click()
  await expect(page.getByRole("button", { name: "Start all" })).toBeDisabled()

  // Settings open from the desk with the same shortcut as from every other screen.
  await page.keyboard.press("ControlOrMeta+Comma")
  await expect(page.getByTestId("settings-screen")).toBeVisible()
})

test("the trading strip keeps the accounts, splits the systems by state and filters the log", async ({ page }) => {
  const at = Date.now()
  const account = { id: "DU5550001", type: "INDIVIDUAL", cash: 100_000, equity: 100_120, pnl_day: 120, pnl_realized: 0, updated_at: at, link: "127.0.0.1:7497", demo: true }

  const system = (id: string, name: string, running: boolean) => ({
    id,
    name,
    running,
    active: running,
    pid: running ? 4100 : null,
    started_at: running ? at : null,
    symbol: "NQ",
    timeframe: "5m",
    pnl_day: null,
  })

  await mockWorkspace(page, { name: "Trading", seed: { servers: [SERVER] } })
  mockTradingSnapshot(page, {
    version: "1",
    connected: true,
    account,
    accounts: [account],
    links: [
      { id: "127.0.0.1:7497", label: null, broker: "ibkr", connected: true, host: "127.0.0.1", port: 7497 },
      { id: "127.0.0.1:7496", label: "Live desk", broker: "ibkr", connected: false, host: "127.0.0.1", port: 7496 },
    ],
    systems: [system("01", "01_nasdaq_apertura_alcista", true), system("06", "06_nasdaq_pullback", false), system("11", "11_usdjpy_ruptura_bollinger", false)],
    // An S&P micro no running system trades: a manual or orphaned position.
    positions: [{ symbol: "MESZ6", side: "long", size: 1, entry: 7578.25, current: 7580, pnl: 8.75, pnl_pct: 0.02 }],
    logs: [
      { ts: at - 60_000, level: "info", system: "01_nasdaq_apertura_alcista", message: "DENTRO a 25145.25 x1", event: "open" },
      { ts: at - 30_000, level: "error", system: "06_nasdaq_pullback", message: "Error 201: order rejected" },
    ],
    tasks: [],
    trades: [],
    equity: [],
  })

  // The dashboard hosts the product's nav in its own header strip on every layout, so the
  // desk needs no interface-layout detour: the strip's rows are the same engine data.
  await page.goto(tradingNewHref())

  // Accounts only: the account itself, and the registered link that has none yet with its
  // state — the trading connection never reads as a row of its own. The rows live in the
  // row's docked panel (a portal), reached through its dialog, not the strip's descendants.
  const strip = page.getByRole("navigation", { name: "Trading dashboard sections" })
  await strip.getByRole("button", { name: "Accounts", exact: true }).click()
  const cuentasPanel = page.getByRole("dialog", { name: "Accounts" })
  await expect(cuentasPanel.getByRole("button", { name: "DU5550001, demo account, day P/L $120.00" })).toBeVisible()
  await expect(cuentasPanel.getByLabel("Live desk: Connecting…")).toBeVisible()
  await expect(cuentasPanel.getByText("Trading connection")).toHaveCount(0)
  await page.keyboard.press("Escape")

  // The running system leads under its readable name; the stopped ones fold under their count.
  await strip.getByRole("button", { name: "Systems", exact: true }).click()
  const sistemasPanel = page.getByRole("dialog", { name: "Systems" })
  await expect(sistemasPanel.getByRole("button", { name: "01_nasdaq_apertura_alcista", exact: true })).toContainText("Nasdaq apertura alcista")
  const stopped = sistemasPanel.getByRole("button", { name: /^Stopped\s*2$/ })
  await expect(stopped).toHaveAttribute("aria-expanded", "false")
  await expect(sistemasPanel.getByRole("button", { name: "11_usdjpy_ruptura_bollinger", exact: true })).toHaveCount(0)
  await stopped.click()
  await expect(sistemasPanel.getByRole("button", { name: "11_usdjpy_ruptura_bollinger", exact: true })).toContainText("USDJPY ruptura bollinger")
  await page.keyboard.press("Escape")

  // The log names what is new, and its loud view keeps the error alone.
  const log = strip.getByRole("button", { name: "System log", exact: true })
  await log.click()
  const panel = page.getByRole("dialog", { name: "System log" })
  await expect(panel.getByText("DENTRO a 25145.25 x1")).toBeVisible()
  await panel.getByRole("button", { name: "Warnings and errors" }).click()
  await expect(panel.getByText("Error 201: order rejected")).toBeVisible()
  await expect(panel.getByText("DENTRO a 25145.25 x1")).toHaveCount(0)

  // A system's entry opens that system's dossier.
  await panel.getByText("Error 201: order rejected").click()
  await expect(page.getByRole("dialog", { name: "Nasdaq pullback" })).toBeVisible()
  await page.keyboard.press("Escape")

  // The position no running system covers is flagged on the account the engine trades.
  await expect(page.getByRole("cell", { name: "No system", exact: true })).toBeVisible()
})

test("opening Trading creates no chat; the chat boots on the pane's first open and starts empty every run", async ({ page }) => {
  await mockWorkspace(page, { name: "Trading", seed: { servers: [SERVER] } })
  mockTradingSnapshotDown(page)
  const creates: string[] = []
  const seeds: string[] = []
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/session") creates.push(request.url())
    if (request.method() === "PUT" && new URL(request.url()).pathname.endsWith("/instructions/entries/trading.desk")) seeds.push(request.url())
  })
  await page.goto(tradingNewHref())

  // Opening the section itself creates nothing: no session, no seeding, no chat anywhere.
  // The desk stands alone and the route stays at its start.
  await expect(page.getByRole("button", { name: "Show chat" })).toBeVisible()
  await expect(page.locator('[data-slot="trading-chat-panel"]')).toHaveCount(0)
  await expect(page).toHaveURL(tradingNewHref())
  await expect.poll(() => creates.length).toBe(0)
  await expect.poll(() => seeds.length).toBe(0)

  // The pane's first open in the run boots the chat, once: create, seed, composer. The
  // seed's empty 204 is a success, not a reason to seed again on adoption.
  const opened = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/session")
  await page.getByRole("button", { name: "Show chat" }).click()
  await opened
  await expect(page).toHaveURL(/ses_mock_created/)
  await expect(page.locator('[data-slot="trading-chat-panel"] [data-component="composer-editor"]')).toBeVisible()
  await expect.poll(() => seeds.length).toBe(1)

  // A short window with a long draft: the welcome ends where the composer begins and its
  // suggestions step aside instead of landing on it, then come back once the draft is gone.
  const editor = page.locator('[data-slot="trading-chat-panel"] [data-component="composer-editor"]')
  const welcome = page.locator('[data-slot="trading-chat-welcome"]')
  const dock = page.locator('[data-slot="trading-chat-panel"] [data-component="session-composer-dock"]')
  const suggestion = page.getByRole("button", { name: "How is the day going?" })
  await page.setViewportSize({ width: 900, height: 360 })
  await editor.click()
  await page.keyboard.type("Which systems are running right now, how much has each one made today, how much is at stake in the open positions, and which positions are still open on the primary link?")
  await expect(suggestion).toBeHidden()
  await expect
    .poll(async () => {
      const [top, bottom] = await Promise.all([dock.boundingBox(), welcome.boundingBox()])

      return Math.round(bottom!.y + bottom!.height) - Math.round(top!.y)
    })
    .toBeLessThanOrEqual(0)
  await editor.press("Control+a")
  await editor.press("Delete")
  await expect(suggestion).toBeVisible()

  // A restart never resumes the chat: the desk comes back with it hidden, the route keeps
  // the restored tab's dead id, and nothing is created until the pane opens again.
  await page.reload()
  await expect(page.getByRole("button", { name: "Show chat" })).toBeVisible()
  await expect(page.locator('[data-slot="trading-chat-panel"]')).toHaveCount(0)
  await expect(page).toHaveURL(/ses_mock_created/)
  expect(creates).toHaveLength(1)

  // The pane's open starts the chat fresh again: the sweep cleared the last one, the
  // standing instructions seed once more, and the composer is empty.
  const reopened = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/session")
  await page.getByRole("button", { name: "Show chat" }).click()
  await reopened
  await expect(page.locator('[data-slot="trading-chat-panel"] [data-component="composer-editor"]')).toBeVisible()
  await expect(welcome).toBeVisible()
  await expect.poll(() => seeds.length).toBe(2)
  expect(creates).toHaveLength(2)

  // And the open pane stays the run's choice only: the next launch hides it again.
  await page.reload()
  await expect(page.getByRole("button", { name: "Show chat" })).toBeVisible()
  await expect(page.locator('[data-slot="trading-chat-panel"]')).toHaveCount(0)
  expect(creates).toHaveLength(2)
})

test("the desk names the programs it could not open and where to get them", async ({ page }) => {
  // A remembered paper account whose TWS is not up: the engine reads each program's state.
  const account = { id: "DU5550001", type: "INDIVIDUAL", cash: null, equity: null, pnl_day: null, pnl_realized: null, updated_at: null, link: "127.0.0.1:7497", demo: true }
  // Mutable, because the scenario moves the engine's state forward under the same mock.
  const snapshot: { -readonly [K in keyof Trading.Snapshot]: Trading.Snapshot[K] } = {
    version: "1",
    connected: false,
    account,
    accounts: [account],
    links: [{ id: "127.0.0.1:7497", label: null, broker: "ibkr", connected: false, host: "127.0.0.1", port: 7497 }],
    systems: [],
    positions: [],
    logs: [],
    tasks: [],
    programs: { tws: "missing", mt5: "missing" },
  }

  await mockWorkspace(page, { name: "Trading", seed: { servers: [SERVER] } })
  mockTradingSnapshot(page, snapshot)
  await page.clock.install()
  await page.goto(tradingNewHref())

  // Neither program is installed: the header says so and the IBKR account's notice leads to
  // TWS's download (MetaTrader 5's belongs to an MT5 account's view).
  const header = page.locator("header").filter({ hasText: "Panic" })
  const notices = page.locator('[data-slot="trading-program-notice"]')
  await expect(header.getByText("TWS not installed", { exact: true })).toBeVisible()
  await expect(notices).toHaveCount(1)
  await expect(notices.getByRole("button", { name: "Download TWS" })).toBeVisible()

  // The engine opening TWS, then TWS open without taking the app: the header follows it, and
  // the open TWS brings the two things that hold the link back, on the engine's own port.
  snapshot.programs = { tws: "opening" }
  await expect(header.getByText("Opening TWS…", { exact: true })).toBeVisible()
  await expect(notices).toHaveCount(0)
  snapshot.programs = { tws: "running" }
  await expect(header.getByText("Waiting for your TWS sign-in", { exact: true })).toBeVisible()
  // The user is likely signing in: the API hint waits a minute before it speaks.
  await expect(notices).toHaveCount(0)
  await page.clock.fastForward(61_000)
  await expect(notices).toHaveCount(1)
  await expect(notices).toContainText("Enable ActiveX and Socket Clients")
  await expect(notices).toContainText("port 7497")

  // Put away, it stays away for this window's run.
  await notices.getByRole("button", { name: "Hide notice" }).click()
  await expect(notices).toHaveCount(0)

  // TWS answers but refuses the engine's client id as taken by another API program: the
  // header and the notice name that and the way out, not the API switch.
  snapshot.client_in_use = 30
  await expect(header.getByText("TWS refuses the connection", { exact: true })).toBeVisible()
  await expect(notices).toHaveCount(1)
  await expect(notices).toContainText("client id 30")
  await expect(notices).toContainText("TRADING_CLIENT_ID")
  await expect(notices).not.toContainText("Enable ActiveX")
})

test("at phone width the KPI band shows its figures and captions whole", async ({ page }) => {
  // A seven-digit account: at 320px the band's two columns used to cut the net worth and the
  // longest caption ("$1,006,80…", "SYSTEMS RUNNI…") with no way to read them in full.
  const at = Date.now()
  const account = { id: "DU5550001", type: "INDIVIDUAL", cash: 1_000_000, equity: 1_006_806.45, pnl_day: -12_345.67, pnl_realized: 4_321.09, margin_used: 250_000.5, updated_at: at, link: "127.0.0.1:7497", demo: true }
  const system = (id: string) => ({ id, name: id, running: false, active: false, pid: null, started_at: null, symbol: "NQ", timeframe: "5m", pnl_day: null })

  await page.setViewportSize({ width: 320, height: 800 })
  await mockWorkspace(page, { name: "Trading", seed: { servers: [SERVER] } })
  mockTradingSnapshot(page, {
    version: "1",
    connected: true,
    account,
    accounts: [account],
    links: [{ id: "127.0.0.1:7497", label: null, broker: "ibkr", connected: true, host: "127.0.0.1", port: 7497 }],
    systems: Array.from({ length: 15 }, (_, índice) => system(`${String(índice + 1).padStart(2, "0")}_sistema`)),
    positions: [],
    logs: [],
    tasks: [],
  })
  await page.goto(tradingNewHref())

  // The widest figure and caption fit their tiles whole, and each keeps its full text as a
  // tooltip anyway (the tooltip is how the test finds them).
  for (const texto of ["Net worth", "$1,006,806.45", "Systems running", "0 / 15"]) {
    const kpi = page.getByTitle(texto, { exact: true })
    await expect(kpi).toHaveText(texto)
    expect(await kpi.evaluate((nodo) => nodo.scrollWidth <= nodo.clientWidth), texto).toBe(true)
  }
})

test("an MT5 account closes its own rows in its terminal", async ({ page }) => {
  const account = { id: "5050001", type: "MetaTrader 5 demo (MetaQuotes-Demo)", cash: 10_000, equity: 10_001, pnl_day: 1, pnl_realized: 0, updated_at: Date.now(), link: "mt5-5050001@MetaQuotes-Demo", demo: true }
  const closes: string[] = []

  await mockWorkspace(page, { name: "Trading", seed: { servers: [SERVER] } })
  mockTradingSnapshot(page, {
    version: "1",
    connected: false,
    account,
    accounts: [account],
    links: [
      { id: "127.0.0.1:7497", label: null, broker: "ibkr", connected: false, host: "127.0.0.1", port: 7497 },
      { id: "mt5-5050001@MetaQuotes-Demo", label: null, broker: "mt5", connected: true, mt5_login: 5050001, mt5_server: "MetaQuotes-Demo" },
    ],
    systems: [],
    positions: [{ symbol: "EURUSD", side: "long", size: 0.01, entry: 1.12345, current: 1.12401, pnl: 0.56, pnl_pct: 0.05 }],
    // The engine's whole exposure: the MT5 row the shown view carries, plus an IBKR row an
    // MT5 view hides — the panic's close-all sweeps both (P-1), so the dialog names both.
    open_positions: [
      { symbol: "MNQZ6", side: "long", size: 1, entry: 37_000, current: 37_050, pnl: 50, pnl_pct: 0.13 },
      { symbol: "EURUSD", side: "long", size: 0.01, entry: 1.12345, current: 1.12401, pnl: 0.56, pnl_pct: 0.05 },
    ],
    logs: [],
    tasks: [],
  })
  await page.route(/\/api\/experimental\/trading\/position\/[^/]+\/close(\?|$)/, async (route) => {
    closes.push(decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-2) ?? ""))
    await route.fulfill({ json: { data: { ok: true, message: "Cierre de EURUSD ejecutado (1 posición)" } } })
  })
  await page.goto(tradingNewHref())

  // The MT5 account trades: its orders line names it, the rate reads as a quote, and there is
  // no manual order — the systems open the trades.
  await expect(page.getByText("Orders: 5050001")).toBeVisible()
  await expect(page.getByRole("cell", { name: "1.12345", exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "New order" })).toHaveCount(0)

  // The row closes in the terminal; the IBKR close-all stays away from an MT5 account.
  await page.getByText("Allow manual close").click()
  await expect(page.getByRole("button", { name: "Close all", exact: true })).toHaveCount(0)
  await page.getByRole("row").filter({ hasText: "EURUSD" }).getByRole("button", { name: "Close" }).click()
  const confirm = page.getByRole("dialog")
  await expect(confirm).toContainText("MetaTrader 5 terminal")
  await confirm.getByRole("button", { name: "Close position" }).click()
  await expect.poll(() => closes).toEqual(["EURUSD"])
  await expect(page.getByRole("dialog")).toHaveCount(0)

  // The panic dialog confirms against the desk's facts: the close-all sweeps the connection's
  // exposure, so an MT5 view hides nothing — the IBKR row names itself next to the terminal's
  // own, and the MetaTrader line keeps its place.
  await page.getByRole("button", { name: "Panic" }).click()
  const panico = page.getByRole("dialog")
  await expect(panico).toContainText("Closes 2 open positions: MNQZ6, EURUSD")
  await expect(panico).toContainText("Also closes every position of the linked MetaTrader 5 accounts")
  // An engine predating the closable read cannot tell the lists apart: the plain exposure stands
  // in, and the dialog adds no line about rows it would leave standing.
  await expect(panico).not.toContainText("Panic does not close")
})

test("the panic dialog closes the engine's own rows and names the ones it leaves standing", async ({ page }) => {
  const at = Date.now()
  // A login that holds two accounts: the engine trades the first on the primary link and only
  // watches the second, so its close-all reaches the first account's rows alone (P-1).
  const cuenta = { id: "DU5550001", type: "INDIVIDUAL", cash: 100_000, equity: 100_010, pnl_day: 10, pnl_realized: 0, updated_at: at, link: "127.0.0.1:7497", demo: true }
  const vigilada = { id: "DU5550002", type: "INDIVIDUAL", cash: 50_000, equity: 50_030, pnl_day: 30, pnl_realized: 0, updated_at: at, link: "127.0.0.1:7496", demo: true }
  const fila = (symbol: string, entry: number): Trading.Position => ({ symbol, side: "long", size: 1, entry, current: entry, pnl: 0, pnl_pct: 0 })

  await mockWorkspace(page, { name: "Trading", seed: { servers: [SERVER] } })
  mockTradingSnapshot(page, {
    version: "1",
    connected: true,
    account: cuenta,
    accounts: [cuenta, vigilada],
    links: [
      { id: "127.0.0.1:7497", label: null, broker: "ibkr", connected: true, host: "127.0.0.1", port: 7497 },
      { id: "127.0.0.1:7496", label: "Watch desk", broker: "ibkr", connected: true, host: "127.0.0.1", port: 7496 },
    ],
    systems: [],
    // The shown account's own rows are the two the engine trades.
    positions: [fila("MNQZ6", 37_000), fila("EURUSD", 1.12345)],
    // The login's whole exposure: two rows the engine closes, and the watch account's GBPUSD,
    // which the close-all never reaches.
    open_positions: [fila("MNQZ6", 37_000), fila("EURUSD", 1.12345), fila("GBPUSD", 1.34)],
    closable_positions: [fila("MNQZ6", 37_000), fila("EURUSD", 1.12345)],
    logs: [],
    tasks: [],
  })
  await page.goto(tradingNewHref())

  await page.getByRole("button", { name: "Panic" }).click()
  const panico = page.getByRole("dialog")
  // The close-all names exactly the closable read — two rows, not the three the login sees — so
  // the confirmation never promises a row it leaves standing.
  await expect(panico.getByText("Closes 2 open positions: MNQZ6, EURUSD", { exact: true })).toBeVisible()
  // The row it does not close is named apart. The line speaks in symbols: the snapshot's rows
  // carry no account of their own, so the sentence does not count the accounts behind them.
  await expect(panico.getByText("Still open where Panic does not close: GBPUSD", { exact: true })).toBeVisible()
})

test("the panic dialog adds no line when every open position is one it closes", async ({ page }) => {
  const at = Date.now()
  const cuenta = { id: "DU5550001", type: "INDIVIDUAL", cash: 100_000, equity: 100_010, pnl_day: 10, pnl_realized: 0, updated_at: at, link: "127.0.0.1:7497", demo: true }
  const fila = (symbol: string, entry: number): Trading.Position => ({ symbol, side: "long", size: 1, entry, current: entry, pnl: 0, pnl_pct: 0 })

  await mockWorkspace(page, { name: "Trading", seed: { servers: [SERVER] } })
  mockTradingSnapshot(page, {
    version: "1",
    connected: true,
    account: cuenta,
    accounts: [cuenta],
    links: [{ id: "127.0.0.1:7497", label: null, broker: "ibkr", connected: true, host: "127.0.0.1", port: 7497 }],
    systems: [],
    positions: [fila("MNQZ6", 37_000), fila("EURUSD", 1.12345)],
    // The engine reads its own account alone: both reads carry the same rows as separate
    // records, so nothing is left out and the dialog says nothing extra.
    open_positions: [fila("MNQZ6", 37_000), fila("EURUSD", 1.12345)],
    closable_positions: [fila("MNQZ6", 37_000), fila("EURUSD", 1.12345)],
    logs: [],
    tasks: [],
  })
  await page.goto(tradingNewHref())

  await page.getByRole("button", { name: "Panic" }).click()
  const panico = page.getByRole("dialog")
  await expect(panico.getByText("Closes 2 open positions: MNQZ6, EURUSD", { exact: true })).toBeVisible()
  await expect(panico).not.toContainText("Panic does not close")
})

test("the titlebar shows no tabs, home or search while trading owns the shell", async ({ page }) => {
  // The desk is a separate section, not a chat tab: entering the trading product clears every
  // row from the strip — chats, dedicated rows, the new-session plus — and leaves the product
  // row without the OpenCode home and search buttons; going back to Openbot puts its own tabs back.
  const chat = { id: "ses_trading_chat_tab", title: "Chat tab session" }
  const workspace = await mockWorkspace(page, {
    name: "Trading",
    sessions: [chat],
    seed: { tabs: [chat.id] },
  })
  mockTradingSnapshotDown(page)

  await page.goto(sessionHref(chat.id, workspace.server))
  const stripSlots = page.locator("[data-titlebar-tab-slot]")
  await expect(stripSlots).toHaveCount(1)
  const stripTitles = page.locator("[data-titlebar-tab-slot] [data-titlebar-tab-title]")
  await expect(stripTitles).toHaveText([chat.title])

  await page.goto(tradingNewHref(workspace.server))
  await expect(stripSlots).toHaveCount(0)
  // The plus only makes chat tabs, so the desk's header leaves it out too — and home plus
  // session search belong to OpenCode's shell, not the desk's.
  await expect(page.getByRole("button", { name: "New session" })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Home", exact: true })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Search sessions" })).toHaveCount(0)

  // The switcher back to Openbot shows its own tabs again.
  await page.locator('[data-action="product-switcher-openCode"]').click()
  await expect(stripSlots).toHaveCount(1)
  await expect(stripTitles).toHaveText([chat.title])
  await expect(page.getByRole("button", { name: "Home", exact: true })).toHaveCount(1)
  await expect(page.getByRole("button", { name: "Search sessions" })).toHaveCount(1)
})
