import type { OpenCodeEvent } from "@opencode/client/promise"
import { expect, test, type Page } from "@playwright/test"
import {
  expectPath,
  holdRoute,
  NO_PROVIDER,
  project,
  REMOTE_SERVER,
  seed,
  SERVER,
  session,
  sessionHref,
  T0,
} from "../utils/app"
import { mockOpenCodeServer, mockServers } from "../utils/mock-server"
import { fixture, mockStressTimeline } from "../utils/session-fixture"
import { mockRemoteServer, mockWorkspace, newSessionLocation } from "../utils/workspace"
import { APP_READY_TIMEOUT, expectAppVisible } from "../utils/waits"

test.use({ serviceWorkers: "block" })

const row = (page: Page, title: string) =>
  page.locator('[data-component="home-session-row"]').filter({ hasText: title })

async function openHome(
  page: Page,
  input: Parameters<typeof mockStressTimeline>[1] = {},
  seedInput: Parameters<typeof seed>[1] = {},
) {
  await mockStressTimeline(page, input)
  await seed(page, { usedProjects: { local: [fixture.project.id] }, ...seedInput })
  await page.goto("/")
}

test("Home keeps the session list in every interface mode", async ({ page }) => {
  const earlier = { id: "ses_home_earlier", title: "Finished earlier" }
  await mockWorkspace(page, { name: "Home", sessions: [earlier] })
  await page.goto("/")
  const search = page.getByRole("textbox", { name: /Search sessions/ })
  await expect(search).toBeVisible()
  await expect(row(page, earlier.title)).toBeVisible()

  // The Inbox mode moves session tabs into the sidebar inbox; Home stays the session list.
  for (const mode of ["Side tabs", "Inbox", "Top tabs"]) {
    await page.keyboard.press("Control+,")
    const settings = page.getByTestId("settings-screen")
    const option = settings.getByRole("radio", { name: mode, exact: true })
    await settings
      .getByRole("group", { name: "Interface layout", exact: true })
      .getByText(mode, { exact: true })
      .click()
    await expect(option).toBeChecked()
    await settings.getByRole("button", { name: "Back to app", exact: true }).click()
    await expect(page).toHaveURL("/")
    await expect(search).toBeVisible()
    await expect(row(page, earlier.title)).toBeVisible()
  }
})

test("a working Home session keeps its project avatar and shows its activity ring at the end of the row", async ({
  page,
}) => {
  const working = { id: "ses_home_working", title: "Working session" }
  const idle = { id: "ses_home_idle", title: "Idle session" }
  await mockWorkspace(page, {
    name: "HomeActivity",
    sessions: [working, idle],
    sessionStatus: { [working.id]: { type: "running" } },
  })
  await page.goto("/")
  const ring = row(page, working.title).locator('[data-component="activity-ring"]')
  await expect(ring).toBeVisible()
  await expect(row(page, working.title).locator('[data-component="project-avatar-v2"]')).toBeVisible()
  await expect(row(page, idle.title).locator('[data-component="activity-ring"]')).toHaveCount(0)

  // The ring trails the title rather than standing in for the avatar.
  const title = await row(page, working.title).getByText(working.title, { exact: true }).boundingBox()
  const box = await ring.boundingBox()
  expect(box!.x).toBeGreaterThan(title!.x + title!.width)
})

test("Home lists projects and sessions when stored state hides every server", async ({ page }) => {
  await mockStressTimeline(page)
  await seed(page, { usedProjects: { local: [fixture.project.id] } })
  // A second seed merges into the server entry the first one wrote.
  await seed(page, { storage: { "opencode.global.dat:server": { hidden: { [fixture.serverKey]: true } } } })
  await page.goto("/")

  await expect(
    page.locator('[data-component="home-project-row"]').filter({ hasText: fixture.project.name }),
  ).toBeVisible()
  await expect(row(page, fixture.expected.targetTitle)).toBeVisible()
})

test("the session context menu renames, exports, and deletes a Home session", async ({ page }) => {
  // The rename lands its tab in the chrome, and the web harness hides the whole titlebar under
  // the side-tabs default (the Windows desktop keeps it, native controls included). The test's
  // subject is the session menu, not the layout, so it pins the horizontal chrome the way an
  // explicit choice through Settings would — tabLayoutChosen keeps the value from migrating.
  await openHome(page, {}, { settings: { appearance: { tabLayout: "horizontal", tabLayoutChosen: true } } })
  const target = row(page, fixture.expected.targetTitle)
  await expect(target).toBeVisible()

  await target.focus()
  await target.press("Shift+F10")
  await expect(page.getByRole("menuitem", { name: "Rename" })).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("menuitem", { name: "Rename" })).toBeHidden()
  await expect(target).toBeFocused()

  const box = await target.boundingBox()
  await target.click({ button: "right", position: { x: 48, y: 12 } })
  await expect(page).toHaveURL("/")
  await expect(page.getByRole("menuitem")).toHaveText(["Rename", "Export…", "Delete…"])
  const menu = await page.locator('[data-component="menu-v2-content"]').boundingBox()
  expect(Math.abs((menu?.x ?? 0) - (box?.x ?? 0) - 48)).toBeLessThan(4)

  await page.getByRole("menuitem", { name: "Rename" }).click()
  const title = page.locator('[data-component="home-session-rename"]')
  await expect(title).toBeFocused()
  await expect(title).toHaveValue(fixture.expected.targetTitle)
  await title.fill("Renamed from Home")

  const renamed = page.waitForRequest(
    (request) =>
      request.method() === "PATCH" && new URL(request.url()).pathname.endsWith(`/session/${fixture.targetID}`),
  )

  await title.press("Enter")
  expect((await renamed).postDataJSON()).toEqual({ title: "Renamed from Home" })
  const renamedRow = row(page, "Renamed from Home")
  await renamedRow.click()
  await expect(page).toHaveURL(new RegExp(`/session/${fixture.targetID}$`))
  await expect(page.locator('[data-slot="titlebar-tabs"] a').filter({ hasText: "Renamed from Home" })).toBeVisible()
  await page.getByRole("button", { name: "Home" }).click()
  await expect(page).toHaveURL("/")

  await renamedRow.click({ button: "right" })
  const download = page.waitForEvent("download")
  await page.getByRole("menuitem", { name: "Export…" }).click()
  expect((await download).suggestedFilename()).toBe("renamed-from-home.json")

  await renamedRow.click({ button: "right" })
  await page.getByRole("menuitem", { name: "Delete…" }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog).toContainText('Delete session "Renamed from Home"?')
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused()

  const removed = await holdRoute(page, (url) => url.pathname.endsWith(`/session/${fixture.targetID}`), {
    method: "DELETE",
  })

  // A double click claims one delete: the dialog stays open, with both buttons disabled, until the server answers.
  await dialog.getByRole("button", { name: "Delete session" }).dblclick()
  await removed.arrived
  await expect(dialog.getByRole("button", { name: "Delete session" })).toBeDisabled()
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled()
  removed.release()
  await expect(dialog).toBeHidden()
  await expect(renamedRow).toBeHidden()
  expect(removed.requests).toHaveLength(1)
})

test("a failed session list says so and loads again on Try again, instead of showing the empty state", async ({
  page,
}) => {
  const earlier = { id: "ses_home_failed_load", title: "Listed after retry" }
  await mockWorkspace(page, { name: "HomeLoad", sessions: [earlier], seed: { tabs: [] } })
  const list = /\/api\/session\?/
  await page.route(list, (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          status: 500,
          json: { message: "Index unavailable" },
          headers: { "access-control-allow-origin": "*" },
        })
      : route.fallback(),
  )
  await page.goto("/")

  const alert = page.getByRole("alert").filter({ hasText: "Couldn't load sessions" })
  await expect(alert).toBeVisible({ timeout: APP_READY_TIMEOUT })
  await expect(page.getByText("Nothing here yet")).toHaveCount(0)
  await expect(page.locator('[data-component="home-session-skeleton"]')).toHaveCount(0)

  await page.unroute(list)
  await alert.getByRole("button", { name: "Try again", exact: true }).click()
  await expect(row(page, earlier.title)).toBeVisible()
  await expect(alert).toHaveCount(0)
})

test("tabbing out of session search closes its results, and tabbing back reopens them", async ({ page }) => {
  const earlier = { id: "ses_home_search_tab", title: "Finished earlier" }
  await mockWorkspace(page, { name: "HomeSearch", sessions: [earlier] })
  await page.goto("/")
  const search = page.getByRole("textbox", { name: /Search sessions/ })
  const panel = page.locator('[data-component="home-session-search-panel"]')
  await expect(row(page, earlier.title)).toBeVisible()

  await search.click()
  await page.keyboard.type("Finished")
  await expect(panel.getByRole("option")).toHaveCount(1)
  await expect(panel.getByRole("option")).toContainText(earlier.title)

  // The clear button is part of the search; the next stop is outside it.
  await page.keyboard.press("Tab")
  await expect(search).not.toBeFocused()
  await expect(panel).toBeVisible()
  await page.keyboard.press("Tab")
  await expect(panel).toHaveCount(0)
  await expect(search).toHaveValue("Finished")

  await page.keyboard.press("Shift+Tab")
  await page.keyboard.press("Shift+Tab")
  await expect(search).toBeFocused()
  await expect(panel.getByRole("option")).toContainText(earlier.title)
})

test("Escape cancels an inline rename whose save does not answer", async ({ page }) => {
  const target = { id: "ses_home_rename_hang", title: "Rename me" }
  await mockWorkspace(page, { name: "HomeRename", sessions: [target] })
  const save = await holdRoute(page, /\/api\/session\/ses_home_rename_hang$/, { method: "PATCH" })
  await page.goto("/")
  const session = row(page, target.title)
  await expect(session).toBeVisible()

  await session.click({ button: "right" })
  await page.getByRole("menuitem", { name: "Rename" }).click()
  const title = page.locator('[data-component="home-session-rename"]')
  await expect(title).toBeFocused()
  await title.fill("Never saved")
  await title.press("Enter")
  await save.arrived

  // The input keeps focus while the save is pending, so Escape reaches it.
  await expect(title).toBeFocused()
  await expect(title).toHaveAttribute("aria-busy", "true")
  await page.keyboard.press("Escape")
  await expect(title).toHaveCount(0)
  await expect(session).toBeFocused()
  await expect(session).toContainText(target.title)
  save.release()
})

test("the Home shortcut focuses session search, and the Home button leaves focus alone", async ({ page }) => {
  await mockStressTimeline(page)
  await seed(page, {
    tabs: [fixture.sourceID],
  })
  await page.goto(sessionHref(fixture.sourceID))
  const editor = page.locator('[data-component="composer-editor"]')
  await expect(editor).toBeEditable({ timeout: APP_READY_TIMEOUT })
  await editor.click()

  await page.keyboard.press("ControlOrMeta+b")
  const search = page.getByRole("textbox", { name: /Search sessions/ })
  await expect(search).toBeFocused()
  await page.keyboard.type("jump")
  await expect(page.getByRole("option")).toHaveCount(1)
  await expect(page.getByRole("option")).toContainText(fixture.expected.targetTitle)

  await page.keyboard.press("ControlOrMeta+b")
  await expectPath(page, sessionHref(fixture.sourceID))

  await page.getByRole("button", { name: "Home", exact: true }).click()
  await expect(search).toHaveValue("")
  await expect(search).not.toBeFocused()
})

const entry = (name: string, active: number, id = `proj_${name}`) =>
  project({
    id,
    directory: `C:/OpenCode/${name}`,
    name,
    time: { created: T0, updated: T0, active: T0 + active },
  })

async function homeProjects(page: Page, projects: unknown[]) {
  const directory = "C:/OpenCode/home"

  const server = await mockOpenCodeServer(page, {
    directory,
    project: project({ id: "proj_home", directory }),
    projects: () => projects,
    provider: NO_PROVIDER,
    sessions: [],
    pageMessages: () => ({ items: [] }),
  })

  return { server, rows: page.locator('[data-component="home-project-row"] [data-slot="home-row-label"]') }
}

test("Home lists the used server projects by recent activity, hides them, and lists them again once used", async ({
  page,
}) => {
  // `recent` was first resolved under another ID, so one directory has two projects.
  const listed = [entry("unused", 4), entry("recent", 3), entry("older", 2), entry("oldest", 1)]
  listed.push(entry("recent", 0, "proj_recent_before_git"))
  const view = await homeProjects(page, listed)
  await seed(page, { usedProjects: { local: ["proj_recent_before_git", "proj_older", "proj_oldest"] } })
  await page.goto("/")
  await expect(view.rows).toHaveText(["recent", "older", "oldest"])

  // Activity moves a project up and an archived project leaves; a project this client never used stays out.
  const active = { ...listed[3]!, time: { ...listed[3]!.time, active: T0 + 5 } }
  const archived = { ...listed[2]!, time: { ...listed[2]!.time, archived: T0 + 6 } }
  const fresh = entry("fresh", 7)
  listed.splice(0, listed.length, fresh, active, listed[0]!, listed[1]!, listed[4]!)
  await view.server.push(
    [active, archived, fresh].map(
      (data, index): OpenCodeEvent => ({
        id: `evt_home_project_${index}`,
        created: T0 + index,
        type: "project.updated",
        data,
      }),
    ),
  )
  await expect(view.rows).toHaveText(["oldest", "recent"])

  const recent = page.locator('[data-component="home-project-row"]').filter({ hasText: "recent" })
  await recent.locator("..").getByRole("button", { name: "More options", exact: true }).click()
  await page.getByRole("menuitem", { name: "Close", exact: true }).click()
  await expect(view.rows).toHaveText(["oldest"])

  // Closing a project moves it out of the added list, but it remains discoverable in the server inventory.
  await page
    .locator('[data-component="home-project-row"]')
    .filter({ hasText: "oldest" })
    .locator("..")
    .getByRole("button", { name: "New session", exact: true })
    .click()
  await newSessionLocation(page).click()
  const options = page.getByRole("dialog").getByRole("option")
  await expect(options.locator(".command-palette-title")).toHaveText(["oldest", "Other projects", "Add project"])
  await options.filter({ hasText: "Other projects" }).click()
  await expect(options.locator(".command-palette-title")).toHaveText(["fresh", "unused", "recent"])
  await options.filter({ hasText: "C:/OpenCode/recent" }).click()
  await expect(newSessionLocation(page)).toContainText("recent")
  await page.getByRole("button", { name: "Home", exact: true }).click()
  await expect(view.rows).toHaveText(["oldest", "recent"])
})

test("Home migrates the directories an older build listed to the server's current projects", async ({ page }) => {
  const view = await homeProjects(page, [
    entry("api", 3),
    entry("web", 2),
    entry("api", 1, "proj_api_before_remote"),
    entry("docs", 0),
  ])

  await seed(page, {
    legacyProjects: {
      local: [
        { worktree: "C:/OpenCode/api", expanded: true },
        { worktree: "C:/OpenCode/web/packages/app" },
        { worktree: "C:/OpenCode/gone" },
      ],
    },
  })
  await page.goto("/")
  await expect(view.rows).toHaveText(["api", "web"])
  await expect
    .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("opencode.global.dat:server") ?? "{}")))
    .toMatchObject({ usedProjectIDs: { local: ["proj_api", "proj_web"] }, projects: {} })
})

test("selecting a Home project lists its worktrees once, however often the project updates", async ({ page }) => {
  const listed = [entry("alpha", 2), entry("beta", 1)]
  const view = await homeProjects(page, listed)
  await seed(page, { usedProjects: { local: ["proj_alpha", "proj_beta"] } })
  const lists: string[] = []
  page.on("request", (request) => {
    const url = new URL(request.url())

    if (request.method() === "GET" && url.pathname === "/api/worktree") lists.push(url.searchParams.get("projectID")!)
  })
  await page.goto("/")
  await expect(view.rows).toHaveText(["alpha", "beta"])
  const alpha = page.locator('[data-component="home-project-row"]').filter({ hasText: "alpha" })

  const refreshed = page.waitForRequest(
    (request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/worktree/refresh",
  )

  await alpha.click()
  await expect(alpha).toHaveAttribute("data-selected", "")
  await refreshed

  // Each update replaces the selected project's object in the store.
  const renamed: OpenCodeEvent = {
    id: "evt_home_worktrees",
    created: T0,
    type: "project.updated",
    data: { ...listed[0]!, name: "alpha renamed" },
  }

  await view.server.push([renamed])
  await expect(view.rows).toHaveText(["alpha renamed", "beta"])

  const beta = page.waitForRequest((request) => new URL(request.url()).searchParams.get("projectID") === "proj_beta")
  await page.locator('[data-component="home-project-row"]').filter({ hasText: "beta" }).click()
  await beta
  expect(lists).toEqual(["proj_alpha", "proj_beta"])
})

test("Home keeps a restored remote selection while the desktop server list loads", async ({ page }) => {
  const local = session({ id: "ses_home_local", directory: "/repo", title: "Local session" })
  const remote = session({ id: "ses_home_remote", directory: "/remote/project", title: "Remote session" })
  const selection = { server: REMOTE_SERVER, directory: "/remote/project" }

  await mockServers(page, {
    [SERVER]: {
      directory: "/repo",
      project: project({ id: "proj_local", directory: "/repo" }),
      provider: NO_PROVIDER,
      sessions: [local],
      pageMessages: () => ({ items: [] }),
    },
    [REMOTE_SERVER]: {
      directory: selection.directory,
      project: project({ id: "proj_remote", directory: selection.directory, name: "remote-project" }),
      provider: NO_PROVIDER,
      sessions: [remote],
      pageMessages: () => ({ items: [] }),
    },
  })
  await seed(page, {
    servers: [{ url: REMOTE_SERVER, name: "Remote" }],
    usedProjects: { [REMOTE_SERVER]: ["proj_remote"] },
    storage: { "opencode.global.dat:layout": { home: { selection } } },
  })
  // Desktop storage is asynchronous; the stored servers load after the layout here.
  await page.goto(
    `/e2e/utils/settings-wsl.html?${new URLSearchParams({ server: SERVER, mode: "stopped", storage: "async", hold: "^server$", path: "/" })}`,
  )

  // Until then Home shows this computer's sessions, not filtered by the remote server's directory.
  await expect(row(page, local.title)).toBeVisible()
  await page.getByRole("button", { name: "Load held storage", exact: true }).click()

  await expect(row(page, remote.title)).toBeVisible()
  await expect(
    page.locator('[data-component="home-project-row"]').filter({ hasText: "remote-project" }),
  ).toHaveAttribute("data-selected", "")
  await expect(row(page, local.title)).toHaveCount(0)
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem("opencode.global.dat:layout") ?? "{}").home.selection),
  ).toEqual(selection)
})

test("Home shows loaded sessions before the location request resolves", async ({ page }) => {
  const location = await holdRoute(page, (url) => url.pathname === "/api/location")
  await openHome(page)
  await expectAppVisible(row(page, fixture.expected.sourceTitle))
  location.release()
})

test("Home and the directory picker load without newer browser APIs", async ({ page }) => {
  await page.addInitScript(() => {
    // Safari 16.6 has none of these APIs. Remove them before the web entry runs.
    // SAFETY: `Partial` only makes the static method optional so `delete` type-checks; the target is the real global.
    delete (Map as Partial<typeof Map>).groupBy
    // SAFETY: as above, for the real global `Promise`.
    delete (Promise as Partial<typeof Promise>).withResolvers
    // SAFETY: as above, for the real global `Promise`.
    delete (Promise as Partial<typeof Promise>).try
  })
  await openHome(page, { fileList: () => [] })
  const target = row(page, fixture.expected.targetTitle)
  await expect(target).toBeVisible()

  await page.getByRole("button", { name: "Add project", exact: true }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByRole("button", { name: "Select folder", exact: true })).toBeEnabled()
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(target).toBeVisible()
})

test("adding a project to a signed-out server re-pairs it, then continues at the paired address", async ({ page }) => {
  // The saved address rejects the new token, so saving moves the server to the link's address.
  const paired = "http://127.0.0.1:4098"
  await mockRemoteServer(page, { name: "Remote", password: "old-password" })
  await mockOpenCodeServer(page, {
    server: paired,
    directory: "/remote/paired",
    project: project({ id: "proj_paired", directory: "/remote/paired" }),
    provider: NO_PROVIDER,
    sessions: [],
    pageMessages: () => ({ items: [] }),
    fileList: () => [],
    password: "session-token",
    pairing: { code: "one-time-code", token: "session-token" },
  })
  await openHome(page, { fileList: () => [] })
  const remote = page.locator("[data-home-row]").filter({ hasText: "Remote" })
  await expect(page.getByRole("button", { name: "Authenticate", exact: true })).toBeVisible()

  await remote.getByRole("button", { name: "Add project", exact: true }).click()
  const editor = page.getByRole("dialog", { name: "Edit server" })
  await editor.getByLabel("Pairing link", { exact: true }).fill(`${paired}/auth/connect/one-time-code`)
  await editor.getByRole("button", { name: "Save", exact: true }).click()

  // The folder picker reads the paired address; the removed one would reject the request.
  const picker = page.getByRole("dialog").filter({ has: page.getByRole("button", { name: "Select folder" }) })
  await expect(picker.getByRole("button", { name: "Select folder", exact: true })).toBeEnabled()
  await expect(picker.getByText("Unable to read this folder")).toHaveCount(0)
})

test("a server whose saved password changes works with the new password", async ({ page }) => {
  const accepted = { password: "old-password" }
  await mockOpenCodeServer(page, {
    server: REMOTE_SERVER,
    directory: "/remote/project",
    project: project({ id: "proj_remote", directory: "/remote/project" }),
    provider: NO_PROVIDER,
    sessions: [],
    pageMessages: () => ({ items: [] }),
    fileList: () => [],
    password: () => accepted.password,
  })
  // Saved with the password the server accepts until the test changes it.
  await seed(page, {
    storage: {
      "opencode.global.dat:server": {
        list: [{ type: "http", displayName: "Remote", http: { url: REMOTE_SERVER, password: "old-password" } }],
      },
    },
  })
  await openHome(page, { fileList: () => [] })
  const remote = page.locator("[data-home-row]").filter({ hasText: "Remote" })
  const picker = page.getByRole("dialog").filter({ has: page.getByRole("button", { name: "Select folder" }) })

  // Use the server once, so its controller exists with the old password.
  await remote.getByRole("button", { name: "Add project", exact: true }).click()
  await expect(picker.getByRole("button", { name: "Select folder", exact: true })).toBeEnabled()
  await picker.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(picker).toHaveCount(0)

  await remote.getByRole("button", { name: "More options", exact: true }).click()
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click()
  const editor = page.getByRole("dialog", { name: "Edit server" })
  await editor.getByPlaceholder("password").fill("new-password")
  // The server now rejects the old password, as after `opencode service set password`.
  accepted.password = "new-password"
  await editor.getByRole("button", { name: "Save", exact: true }).click()
  await expect(editor).toHaveCount(0)

  // The picker reads the folder through the server's controller, which must use the saved password now.
  await remote.getByRole("button", { name: "Add project", exact: true }).click()
  await expect(picker.getByRole("button", { name: "Select folder", exact: true })).toBeEnabled()
  await expect(picker.getByText("Unable to read this folder")).toHaveCount(0)
})

const recovery = "C:/OpenCode/Worktrees/project-menu-recovery"

const worktree =
  "C:/OpenCode/Worktrees/project-42/long-folder-name-for-checking-wrapped-worktree-paths/another-long-folder-name"

for (const state of [
  { name: "local", directory: fixture.directory },
  { name: "worktree", directory: worktree, worktree: "another-long-folder-name" },
  { name: "unopened worktree", directory: recovery, worktree: "project-menu-recovery", recovery: "unopened" },
]) {
  test(`the session location card opens settings and Home for a ${state.name} project`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    const workspace = state.directory !== fixture.directory
    const messages = Promise.withResolvers<void>()
    await mockStressTimeline(page, {
      directory: state.directory,
      // An image icon keeps the avatar initial out of the menu item text.
      project: {
        ...fixture.project,
        sandboxes: workspace ? [state.directory] : [],
        icon: {
          url: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"/>')}`,
        },
      },
      sessions: fixture.sessions.map((item) => ({ ...item, directory: state.directory })),
      beforeMessagesResponse: (input) =>
        state.recovery && input.sessionID === fixture.targetID ? messages.promise : Promise.resolve(),
    })

    // An unopened project has no stored tabs.
    if (state.recovery !== "unopened") await seed(page, { tabs: [fixture.sourceID, fixture.targetID] })
    const name = fixture.project.name
    await page.goto(sessionHref(fixture.targetID))

    const header = page.locator("[data-session-title]")
    const trigger = header.locator('[data-slot="session-location-trigger"]')
    const menu = page.locator('[data-slot="session-location-card"]')
    const projectItem = menu.getByRole("menuitem", { name, exact: true })
    const settings = page.getByTestId("settings-screen")
    await expect(header.getByRole("heading")).toHaveText(fixture.expected.targetTitle)

    for (const loaded of state.recovery ? [false, true] : [true]) {
      if (state.recovery && loaded) {
        messages.resolve()
        await expect(header.getByRole("button", { name: "Session details", exact: true })).toBeVisible()
      }

      await expect(trigger.locator('[data-slot="session-location-project"]')).toHaveText(name)
      await expect(trigger.locator('[data-slot="session-location-worktree"]')).toHaveText(
        state.worktree ? [state.worktree] : [],
      )
      await trigger.click()
      await expect(menu.locator('[data-slot="session-location-path"]')).toHaveText(state.directory)
      await page.keyboard.press("Escape")
      await expect(menu).toBeHidden()
      await expect(trigger).toBeFocused()
      await trigger.press("ArrowDown")
      await expect(projectItem).toBeFocused()
      await menu.getByRole("menuitem", { name: "Edit project", exact: true }).press("Enter")
      await expect(settings.getByRole("textbox", { name: "Project name", exact: true })).toHaveValue(name)
      await settings.getByRole("button", { name: "Back to projects", exact: true }).click()
      await settings.getByRole("button", { name: "Back to app", exact: true }).click()
      await expect(settings).toBeHidden()
    }

    await trigger.click()
    await projectItem.click()
    await expect(page).toHaveURL(new URL("/", page.url()).href)
    const project = page.locator('[data-component="home-project-row"]').filter({ hasText: name })
    await expect(project).toHaveAttribute("data-selected", "")
    await expect(
      page.locator(`[data-component="home-session-row-container"][data-session-id="${fixture.targetID}"]`),
    ).toBeVisible()
  })
}

test("the titlebar's free-usage ring counts the current exit and rotates it on the gateway's block, then hands the machine's own address back", async ({ page }) => {
  const free = (steps: number) => ({
    model: { providerID: "opencode", id: "big-pickle" },
    steps,
    tokens: { input: 100_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    cost: 0,
  })

  const empty = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

  let models: ReturnType<typeof free>[] = []
  // The engine's current /64, set only when the scenario's out-of-band rotation has landed one.
  let bucket: string | undefined
  // The engine's pin, set only when the scenario's rotation program has pinned the hosts.
  let pin = false
  // The resumes the ring itself sends: one admission-less call per rotation landing that lifts.
  const resumes: Array<{ sessionID: string }> = []
  const view = await mockWorkspace(page, {
    name: "Free usage",
    // The ring lives in the titlebar, and the web harness hides that whole titlebar under the
    // side-tabs default (the Windows desktop keeps it, native controls included). The keeper's
    // subject is the ring, not the layout, so it pins the horizontal chrome the way an explicit
    // choice through Settings would — tabLayoutChosen keeps the stored value from migrating.
    seed: { settings: { appearance: { tabLayout: "horizontal", tabLayoutChosen: true } } },
    dayModels: () => models,
    ghostCurrent: () => bucket,
    ghostPin: () => pin,
    onResume: ({ sessionID }) => resumes.push({ sessionID }),
  })

  // Every rotation the ghost engine runs is held until the test releases it with its verdict.
  const engine: { calls: number; release?: () => void; body: object } = { calls: 0, body: { ok: true, address: "2001:db8::42" } }
  await page.route(/\/api\/experimental\/ghost\/rotate$/, async (route) => {
    engine.calls += 1
    await new Promise<void>((resolve) => (engine.release = resolve))
    await route.fulfill({ json: { data: engine.body } })
  })
  await page.goto("/")

  const sessionID = view.sessions[0]!.id
  const durable = (seq: number) => ({ aggregateID: sessionID, seq, version: 1 as const })

  // The server reports each stored step's usage; the ring re-reads the day on that report alone.
  const stored = (seq: number) =>
    view.push([
      { id: `evt_free_usage_${seq}`, created: T0 + seq, type: "session.usage.updated", data: { sessionID, cost: 0, tokens: empty } },
    ])

  const refused = (seq: number) =>
    view.push([
      {
        id: `evt_free_usage_blocked_${seq}`,
        created: T0 + seq,
        type: "session.step.failed",
        durable: durable(seq),
        data: {
          sessionID,
          assistantMessageID: `msg_free_usage_blocked_${seq}`,
          error: { type: "provider.free-limit", message: "Free usage limit reached.", status: 429, retryAfterMs: 3_600_000 },
        },
      },
    ])

  const ring = page.getByRole("button", { name: /^Free daily usage:/ })
  const arc = ring.locator('[data-component="progress-circle"]')
  const hueco = ring.locator("span").first()
  // While a rotation runs the comet laps the dimmed arc on its own SMIL: one looping lap.
  const loader = hueco.locator('[data-slot="ring-comet"] animate')
  await expect(ring).toHaveAccessibleName("Free daily usage: 0%")

  // Requests alone fill it: half the cap stays blue, past 60% it turns to the warning colour, and
  // neither rotates anything.
  models = [free(122)]
  await stored(1)
  await expect(ring).toHaveAccessibleName("Free daily usage: 50%")
  await expect(arc).toHaveAttribute("style", /--v2-state-fg-info/)

  models = [free(182)]
  await stored(2)
  await expect(ring).toHaveAccessibleName("Free daily usage: 75%")
  await expect(arc).toHaveAttribute("style", /--v2-state-fg-warning/)
  expect(engine.calls).toBe(0)

  // Hovering slides the figures out to the ring's right, in two lines, and the row makes room:
  // the ring's neighbours move right while it holds, nothing rides over them, and they slide back
  // on the way out.
  const details = page.locator('[data-slot="free-daily-usage-details"]')
  await expect(details).toHaveCSS("opacity", "0")
  const pill = ring.locator("xpath=../..")
  const slot = await pill.boundingBox()
  const search = page.getByRole("button", { name: "Search sessions" })
  const searchX = (await search.boundingBox())!.x
  await ring.hover()
  await expect(details).toHaveCSS("opacity", "1")
  await expect(details).toContainText("Free usage · 75%")
  await expect(details).toContainText("Resets")
  await expect.poll(async () => (await pill.boundingBox())?.width ?? 0).toBeGreaterThan(slot!.width * 4)
  expect((await details.boundingBox())!.height).toBeLessThanOrEqual(slot!.height)
  expect((await pill.boundingBox())!.x).toBe(slot!.x)

  // The push, settled: the search button rode exactly the width the pill added, its gap intact.
  await expect
    .poll(async () => {
      const box = (await pill.boundingBox())!
      return Math.round((await search.boundingBox())!.x - searchX - (box.width - slot!.width))
    })
    .toBe(0)

  // The ring itself is the rotate button: on hover the centre stays clear — the comet's lap and
  // the pill carry the wake, and no centre art ever draws — while the coloured arc keeps all
  // the way around.
  await expect(hueco.locator("svg:has(ellipse)")).toHaveCount(0)
  await expect(arc.locator("xpath=..")).toHaveCSS("opacity", "1")

  // A click rotates: the comet laps the dimmed arc inside the ring, folded pill or not, and the
  // fresh /64 starts its own count from zero with a tic falling into the ring.
  await ring.click()
  await expect(ring).toHaveAttribute("aria-busy", "true")
  await expect(details).toContainText("Rotating IPv6…")
  await page.mouse.move(0, 0)
  await expect(details).toHaveCSS("opacity", "0")
  await expect(hueco.locator("svg:has(ellipse)")).toHaveCount(0)
  await expect(loader).toHaveCount(1)
  engine.release?.()
  await expect(loader).toHaveCount(0)
  await expect(hueco.locator("svg:not([data-component])")).toHaveCSS("opacity", "1")
  await expect(ring).toHaveAttribute("aria-description", "New IPv6 2001:db8::42")
  await expect(ring).toHaveAccessibleName("Free daily usage: 0%")

  // Past the cap the ring only reads full: nothing rotates without the gateway's own word. The
  // manual landing above anchored the fresh /64 at the day's count then (182), so the day's
  // count here climbs 250 past it — beyond the 243 cap — and the share caps at the full 100%.
  models = [free(182 + 250)]
  await stored(3)
  await expect(ring).toHaveAccessibleName("Free daily usage: 100%")
  await expect(loader).toHaveCount(0)
  expect(engine.calls).toBe(1)

  // The gateway's own refusal reads as full and red, and rotates, which lifts the block.
  await refused(4)
  await expect(ring).toHaveAccessibleName("Free daily usage: limit reached")
  await expect(arc).toHaveAttribute("style", /--v2-state-fg-danger/)
  await expect(loader).toHaveCount(1)
  expect(engine.calls).toBe(2)
  engine.release?.()
  await expect(ring).toHaveAccessibleName("Free daily usage: 0%")

  // An untyped 429 — the edge in front of the gateway refusing for the whole /64 — is the block
  // too: full, red, rotating, with the Retry-After it refused with.
  await view.push([
    {
      id: "evt_free_usage_untyped",
      created: T0 + 6,
      type: "session.step.failed",
      durable: durable(5),
      data: {
        sessionID,
        assistantMessageID: "msg_free_usage_untyped",
        error: {
          type: "provider.rate-limit",
          message: "Too many requests",
          status: 429,
          retryAfterMs: 1_800_000,
          response: { body: "edge HTML" },
        },
      },
    },
  ])
  await expect(ring).toHaveAccessibleName("Free daily usage: limit reached")
  await expect(loader).toHaveCount(1)
  expect(engine.calls).toBe(3)
  engine.release?.()
  await expect(ring).toHaveAccessibleName("Free daily usage: 0%")

  // And a landed rotation carries the cut turns on with nothing admitted: the ring calls its
  // server's resume endpoint once, on the server that reported the stop. Both lands did it — the
  // typed refusal's and this one's — and the chat never shows a row for the carry-on.
  await expect.poll(() => resumes.length).toBe(2)
  expect(resumes).toEqual([{ sessionID }, { sessionID }])

  // A run that lands no fresh exit says so, and the ring does not retry at once: a further refusal
  // stays a block until the retry wait passes.
  engine.body = { ok: false }
  await ring.hover()
  await ring.click()
  engine.release?.()
  await expect(details).toContainText("Couldn't rotate IPv6")
  await page.mouse.move(0, 0)
  await refused(5)
  await expect(ring).toHaveAccessibleName("Free daily usage: limit reached")
  // The block's retry wait holds the watch down: the refusal's own rerun stood it back up
  // with nothing in flight — no comet, no second call — until the wait itself passes.
  await expect(loader).toHaveCount(0)
  expect(engine.calls).toBe(4)

  // A step that goes through again lifts the block back to the current exit's own count.
  await view.push([
    {
      id: "evt_free_usage_through",
      created: T0 + 6,
      type: "session.step.ended",
      durable: durable(6),
      data: { sessionID, assistantMessageID: "msg_free_usage_through", finish: "stop", cost: 0, tokens: empty },
    },
  ])
  await expect(ring).toHaveAccessibleName("Free daily usage: 0%")

  // A rotation the ring did not ask for (the desktop bat, a script) moves the exit under it: the
  // next refresh reads the engine's /64, reconciles the record onto the day's count (the number it
  // stood at when the read answered) and adds the steps after that on top — none of it through the
  // engine. The read itself is awaited, so the pushes cannot silently collapse into one refresh.
  const exitMove = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/experimental/ghost/status")
  bucket = "2001:db8:0:1"
  models = [free(123)]
  await stored(7)
  await exitMove
  await expect(ring).toHaveAccessibleName("Free daily usage: 0%")
  // The move down the ring the ring didn't ask for rides one comet lap as its witness.
  await expect(arc).toHaveClass(/free-daily-avista/)
  models = [free(123 + 97)]
  await stored(8)
  await expect(ring).toHaveAccessibleName("Free daily usage: 40%")
  expect(engine.calls).toBe(4)

  // The rotation program's own fresh exit of a day the ring only just met: the engine read names
  // a /64 and the pin is on, but the record still names no /64 of today's — the ring adopts the
  // fresh exit (one comet lap, the count restarts there) and never hands the tunnel back.
  const retaken = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/experimental/ghost/status")
  bucket = "2001:db8:0:3"
  pin = true
  await seed(page, {
    storage: {
      "opencode.global.dat:usage.free-exit": { day: T0, requests: 50, bucket: "2001:db8:0:9" },
    },
  })
  await page.goto("/")
  // The mount's first read may race its record load; a pushed usage report guarantees at least one refresh.
  await stored(9)
  await retaken
  await expect(ring).toHaveAccessibleName("Free daily usage: 0%")
  await expect(arc).toHaveClass(/free-daily-avista/)
  expect(engine.calls).toBe(4)

  // A fresh open over an exit a past run left behind — the pin is on but the day moved on, and
  // the record names no /64 of the new one — hands the machine's own address back on the first
  // engine read: one release through the engine, never the rotate ladder, and the day's count
  // reads whole again.
  bucket = undefined
  models = [free(49)]
  await seed(page, {
    storage: {
      "opencode.global.dat:usage.free-exit": { day: T0, requests: 123, bucket: "2001:db8:0:2" },
    },
  })
  const handed = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/experimental/ghost/release")
  await page.goto("/")
  // The mount's first read may race its record load; a pushed usage report guarantees at least one refresh.
  await stored(10)
  await handed
  await expect(ring).toHaveAccessibleName("Free daily usage: 20%")
  expect(engine.calls).toBe(4)

  // The same exit carried across the free day's renewal: the engine still names the record's
  // own /64, so nothing moved it — the record re-dates to the new day at zero, the count reads
  // whole, and no lap or rotation marks a move that never happened.
  const carried = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/experimental/ghost/status")
  bucket = "2001:db8:0:6"
  models = [free(122)]
  await seed(page, {
    storage: {
      "opencode.global.dat:usage.free-exit": { day: T0 - 86_400_000, requests: 50, bucket: "2001:db8:0:6" },
    },
  })
  await page.goto("/")
  // The mount's first read may race its record load; a pushed usage report guarantees at least one refresh.
  await stored(11)
  await carried
  await expect(ring).toHaveAccessibleName("Free daily usage: 50%")
  await expect(arc).not.toHaveClass(/free-daily-avista/)
  expect(engine.calls).toBe(4)

  // And a day that starts with nothing of the rotation program's carrying the exit — the pin
  // off, the engine naming no /64 of today's — still reads whole: the record of yesterday seeds
  // to the day's own start on the first read, the standing exit takes the day's count from
  // zero, and no rotation happens without the gateway's own refusal.
  pin = false
  bucket = undefined
  models = [free(226)]
  await seed(page, {
    storage: {
      "opencode.global.dat:usage.free-exit": { day: T0 - 86_400_000, requests: 50, bucket: "2001:db8:0:5" },
    },
  })
  await page.goto("/")
  // The mount's first read may race its record load; a pushed usage report guarantees at least one refresh.
  await stored(12)
  await expect(ring).toHaveAccessibleName("Free daily usage: 93%")
  await expect(loader).toHaveCount(0)
  expect(engine.calls).toBe(4)

  // And the gateway's refusal rotates a day the desk never got a read for: with every visible
  // server failing the day's stats read, the ring holds no figure at all — the refusal is the
  // gateway's own word about this exit, not the desk's guess, so the record's absence holds
  // nothing back. Only the day's figure waits for a read; the refusal needs none. The ring
  // itself stays hidden while the read is down; the rotation and the stopped session's resume
  // are the observable work.
  engine.body = { ok: true, address: "2001:db8::42" }
  await seed(page, {
    storage: {
      "opencode.global.dat:usage.free-exit": { day: T0 - 86_400_000, requests: 50, bucket: "2001:db8:0:5" },
    },
  })
  await page.route(/\/api\/experimental\/session\/stats/, (route) => route.abort())
  await page.goto("/")
  await refused(13)
  await expect.poll(() => engine.calls).toBe(5)
  engine.release?.()
  await expect.poll(() => resumes.length).toBe(3)
  expect(resumes[2]).toEqual({ sessionID })
})
