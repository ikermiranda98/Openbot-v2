import { Show, createEffect, on, startTransition, Suspense, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { createMediaQuery } from "@solid-primitives/media"
import { makeEventListener } from "@solid-primitives/event-listener"
import { ResizeHandle } from "@opencode/ui/resize-handle"
import { useDialog } from "@opencode/ui/context/dialog"
import { prefersReducedMotion } from "@opencode/ui/motion"
import { Titlebar } from "@/shell/titlebar/titlebar"
import { usePlatform } from "@/runtime/platform/platform"
import { ToastRegion } from "@/shell/notifications/toast"
import { createTipToasts } from "@/tips/model"
import { UploadToastHost } from "@/composer/attachments/uploads"
import { useSettingsSurface } from "@/settings/surface"
import { useSettings } from "@/settings/model"
import { PluginServerCover } from "@/runtime/plugin/server-shell"
import { PluginSlot } from "@/runtime/plugin/render"
import { COMMAND_SEARCH_ID, useCommand } from "@/shell/commands/command"
import { useLanguage } from "@/runtime/i18n/language"
import { useGlobal } from "@/runtime/server/runtime"
import { useServers } from "@/runtime/server/registry"
import { useTabs } from "@/shell/tabs/tabs"
import {
  CollapsedSidebarToggle,
  collapsedSidebarToggleEnd,
  measureSidebarToggles,
  paintCollapsedSlots,
} from "@/shell/sidebar-toggle"
import { createPanelMotion, guardClosingFocus, panelOpacity, setPanelResizing } from "@/shell/panel-motion"
import { createSidebarPeek } from "@/shell/sidebar-peek"
import { rowReserve } from "@/shell/row-reserve"
import { useCurrentRoute } from "@/shell/state/layout"
import { windowDragEnabled } from "@/session/header/drag-area"

// The vertical tabs sidebar's width: a readable floor (the tree's group headings, link ids
// and day-P/L column all fit), and the hard cap the handle may reach. The live cap also
// leaves the content beside it the room it needs (the row's side insets counted): the
// dashboard's floor, and in the trading desk with its chat open, the chat's emergency floor
// too — so widening the sidebar can never crush the desk. The floor wins when the window is
// too narrow for both, so the range never collapses onto an unreadable width.
const SIDEBAR_WIDTH_MIN = 200
const SIDEBAR_WIDTH_MAX = 640

// The settings model's own fallback; a double-click on the handle returns to it.
const SIDEBAR_WIDTH_DEFAULT = 240

type SidebarPose = { closed: number; peek: number | undefined }

export const sidebarToggleCommand = { id: "sidebar.toggle", keybind: "mod+shift+b" }

export default function Layout(props: ParentProps) {
  const platform = usePlatform()
  const settings = useSettingsSurface()
  const preferences = useSettings()
  const command = useCommand()
  const language = useLanguage()
  const dialog = useDialog()
  const global = useGlobal()
  const servers = useServers()
  const tabs = useTabs()
  const mobile = createMediaQuery("(max-width: 767px)")

  createTipToasts()

  const [state, setState] = createStore<{
    tabsWidth: number
    windowWidth: number
    tabsMount: HTMLElement | undefined
    tabsAside: HTMLElement | undefined
    tabsPanel: HTMLElement | undefined
  }>({
    // Restored from the persisted width so a resize survives a restart; a stored value is
    // clamped back into the current bounds (older sessions may have written wilder ones).
    tabsWidth: Math.min(Math.max(SIDEBAR_WIDTH_MIN, preferences.appearance.sidebarWidth()), SIDEBAR_WIDTH_MAX),
    windowWidth: window.innerWidth,
    tabsMount: undefined,
    tabsAside: undefined,
    tabsPanel: undefined,
  })

  // The persisted width also re-applies once the settings storage answers: the store boots
  // on the default and the asynchronous desktop storage reconciles later, so the creation
  // read above saw only the default. The handle's own writes echo this effect with the
  // value it just set — no change lands then.
  createEffect(() => {
    setState("tabsWidth", Math.min(Math.max(SIDEBAR_WIDTH_MIN, preferences.appearance.sidebarWidth()), SIDEBAR_WIDTH_MAX))
  })

  makeEventListener(window, "resize", () => setState("windowWidth", window.innerWidth))

  // The handle's live cap against the window and what sits beside the sidebar, and the width
  // the sidebar paints: the stored preference held under that cap. The preference itself is
  // left alone, so a window that grows back returns the sidebar to the width the user chose.
  const sidebarMax = () => Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, state.windowWidth - rowReserve() - 16))
  const sidebarWidth = () => Math.min(state.tabsWidth, sidebarMax())

  const verticalTabs = () => preferences.appearance.tabLayout() !== "horizontal" && !mobile()

  // The sessions sidebar belongs to the session routes alone: the trading product carries its
  // nav in the desk's own header strip (the product's one page), so vertical tabs on trading
  // render the top titlebar row and no aside — the same chrome the horizontal layout already
  // gave the desk.
  const route = useCurrentRoute()
  const tradingRoute = () => route().type === "trading"
  const sessionsSidebar = () => verticalTabs() && !tradingRoute()

  const organizedSidebar = () =>
    preferences.appearance.tabLayout() === "vertical" && preferences.general.sidebarOrganize() !== "list"

  const toggleSidebar = () => preferences.appearance.setSidebarOpen(!preferences.appearance.sidebarOpen())

  // How far closed the docked sidebar is, and how far in its peek has it, undefined while it isn't peeking.
  const sidebar: SidebarPose = {
    closed: preferences.appearance.sidebarOpen() ? 0 : 1,
    peek: undefined,
  }

  let peekSurface: HTMLDivElement | undefined
  let peekHome: HTMLElement | null | undefined

  // The docked sidebar and its peek are one sidebar, shown as far in as whichever has it further.
  const sidebarHidden = () => (sidebar.peek === undefined ? sidebar.closed : Math.min(sidebar.closed, 1 - sidebar.peek))

  // A peek slides the contents in its own box, where docking slides them by sizing the aside. Reduced motion fades
  // them in place instead.
  const paintSidebarContents = () => {
    const mount = state.tabsMount

    if (!mount) return
    const peeking = sidebar.peek !== undefined
    const hidden = sidebarHidden()
    const fade = peeking && prefersReducedMotion()
    const rtl = document.documentElement.dir === "rtl"
    const shift = peeking && !fade && hidden > 0 ? `translateX(${(rtl ? 100 : -100) * hidden}%)` : ""
    const opacity = fade ? (hidden === 0 ? "" : `${1 - hidden}`) : panelOpacity(hidden)
    mount.style.opacity = opacity
    mount.style.transform = shift

    if (peekSurface) {
      // Lifted while it floats, and settling as a dock lands. It fades with the contents, so its hairline and shadow,
      // which reach past its end edge, leave with them rather than lingering at the window's edge.
      peekSurface.style.opacity = peeking ? `${sidebar.closed * Number(opacity || 1)}` : ""
      peekSurface.style.transform = shift
    }

    // Without traffic lights, Home starts the sidebar's header right where the collapsed toggle floats over a peek, so
    // it steps past the toggle until a dock carries the toggle to the header's end.
    if (peeking && peekHome === undefined)
      peekHome = mount.querySelector<HTMLElement>('[data-slot="sidebar-header"][data-home] > :first-child')

    if (peekHome)
      peekHome.style.transform = peeking
        ? `translateX(calc(${(rtl ? -1 : 1) * sidebar.closed} * (${collapsedSidebarToggleEnd}px - var(--sidebar-inset-start))))`
        : ""

    if (!peeking) peekHome = undefined
  }

  const sidebarMotion = createPanelMotion({
    open: preferences.appearance.sidebarOpen,
    // The aside's real width moves main's edge with the sidebar's; its contents keep their width, pinned to that edge.
    paint: (closed) => {
      sidebar.closed = closed
      const aside = state.tabsAside

      if (aside) aside.style.width = `${sidebarWidth() * (1 - closed)}px`

      // Dims the contents, background included, as they leave and brightens them as they arrive.
      paintSidebarContents()
      paintCollapsedSlots(closed)
    },
    measure: () => measureSidebarToggles(sidebarWidth() * sidebarHidden()),
    // A dock from a peek already shows the sidebar, so reduced motion has nothing to fade in.
    element: () => (peek.handedOff() ? undefined : state.tabsPanel),
    distance: () => sidebarWidth(),
  })

  // The panel motion paints the aside only while it opens or closes, so every other change to
  // the painted width — a drag, a double-click, the stored width arriving from storage, a
  // window resize moving the cap — repaints the docked box here. Without it the mount drew
  // at the new width inside the old box, which clipped the sidebar's contents.
  createEffect(
    on(sidebarWidth, (width) => {
      if (state.tabsAside && preferences.appearance.sidebarOpen() && sidebar.closed === 0) state.tabsAside.style.width = `${width}px`
    }),
  )

  const peek = createSidebarPeek({
    enabled: sessionsSidebar,
    available: () => sessionsSidebar() && !preferences.appearance.sidebarOpen() && !sidebarMotion.present(),
    open: preferences.appearance.sidebarOpen,
    aside: () => state.tabsAside,
    panel: () => state.tabsPanel,
    paint: (shown) => {
      sidebar.peek = shown
      paintSidebarContents()
    },
    whenDocked: sidebarMotion.whenSettled,
  })

  guardClosingFocus({
    root: () => state.tabsAside,
    closing: () => !preferences.appearance.sidebarOpen() && sidebarMotion.present(),
    // The toggle that reopens the sidebar, outside it.
    target: () =>
      [...document.querySelectorAll<HTMLElement>('button[aria-controls="vertical-tabs-sidebar"]')].find(
        (button) => !state.tabsAside?.contains(button),
      ),
  })

  command.register("sidebar", () =>
    sessionsSidebar()
      ? [
          {
            ...sidebarToggleCommand,
            title: language.t("command.sidebar.toggle"),
            category: language.t("command.category.view"),
            onSelect: toggleSidebar,
          },
        ]
      : [],
  )
  // Every surface has a palette: routes with their own register under the same key, and the newest wins.
  command.register("palette", () => [
    {
      id: "command.palette",
      title: language.t("command.palette"),
      hidden: true,
      onSelect: async () => {
        const conn = servers.visible.find((item) => servers.current(item)) ?? servers.visible[0]

        if (!conn) return
        const { HomeCommandPalette } = await import("@/home/start/command-palette")
        void dialog.show(() => (
          <HomeCommandPalette
            server={conn}
            onSelectSession={(entry) => {
              if (!entry.sessionID || !entry.directory || !entry.server) return
              const sessionID = entry.sessionID
              const server = entry.server
              global.serverCtx(server)?.projects.touch(entry.project?.worktree ?? entry.directory)
              void startTransition(() => {
                tabs.select(tabs.addSessionTab({ server, sessionId: sessionID }))
              })
            }}
          />
        ))
      },
    },
  ])
  command.register("commands", () => [
    {
      id: COMMAND_SEARCH_ID,
      title: language.t("command.commands.search"),
      category: language.t("command.category.view"),
      onSelect: async () => {
        const { DialogCommandSearch } = await import("@/shell/commands/command-search")
        void dialog.show(() => <DialogCommandSearch />)
      },
    },
  ])
  const bottomTitlebar = () => mobile() && preferences.general.mobileTitlebarPosition() === "bottom"
  const dragInset = () => windowDragEnabled(platform) && !mobile()

  return (
    <div
      class="relative bg-v2-background-bg-deep flex-1 min-h-0 min-w-0 flex flex-col select-none [&_input]:select-text [&_textarea]:select-text [&_[contenteditable]]:select-text"
      style={{
        // Mobile panels only need clearance for their outer border.
        "--shell-inline-inset": mobile() ? "1px" : "8px",
        "--session-header-inset-end": verticalTabs() ? "10px" : "12px",
        "--sidebar-inset-start": "11px",
        "--sidebar-inset-end": "3px",
        "--sidebar-divider-bleed":
          preferences.appearance.tabLayout() === "inbox" || organizedSidebar() ? "var(--shell-inline-inset)" : "0px",
        // A bottom mobile titlebar leaves main's top edge to the safe area. Native Windows chrome supplies the gap;
        // retain outer-outline clearance.
        "--shell-top-inset": bottomTitlebar()
          ? "0px"
          : platform.platform === "desktop" && platform.os === "windows"
            ? "1px"
            : "8px",
        "--shell-bottom-inset": bottomTitlebar()
          ? "8px"
          : "max(0px, calc(8px - var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))))",
      }}
    >
      <Titlebar
        verticalTabs={sessionsSidebar() ? { mount: state.tabsMount } : undefined}
        sidebarToggle={verticalTabs()}
      />
      <div class="relative flex flex-1 min-h-0 min-w-0 flex-row">
        {/* The empty inset above the panels moves the window, as the titlebar does. */}
        <Show when={dragInset()}>
          <div
            data-slot="shell-drag-inset"
            aria-hidden="true"
            class="absolute inset-x-0 top-0 h-[var(--shell-top-inset,8px)]"
            data-tauri-drag-region
          />
        </Show>
        <Show when={sessionsSidebar()}>
          <aside
            id="vertical-tabs-sidebar"
            data-slot="vertical-tabs-sidebar"
            data-state={preferences.appearance.sidebarOpen() ? "open" : "closed"}
            data-peek={peek.shown() ? "" : undefined}
            style={{ "--sidebar-peek-width": `${sidebarWidth()}px` }}
            ref={(element) => setState("tabsAside", element)}
            class="relative z-10 h-full min-h-0 shrink-0"
          >
            {/* Skipped rather than display: none or inert, so neither direction restyles the sidebar's contents and
                  a reopen reuses their layout. */}
            <div
              ref={(element) => setState("tabsPanel", element)}
              data-slot="vertical-tabs-panel"
              class="absolute inset-0 overflow-clip [contain:layout_style_paint] [overflow-clip-margin:var(--sidebar-divider-bleed,0px)]"
              classList={{
                "z-20": organizedSidebar(),
                "[content-visibility:hidden]": !sidebarMotion.present() && !peek.shown(),
              }}
            >
              {/* Under a peek's contents, so they dim over the sidebar's own background, as when docking, rather than
                  showing the content beneath through them. */}
              <div
                ref={peekSurface}
                data-slot="vertical-tabs-peek-surface"
                aria-hidden="true"
                class="pointer-events-none absolute inset-y-0 end-0 bg-v2-background-bg-deep shadow-[var(--v2-elevation-floating)]"
                style={{ width: `${sidebarWidth()}px` }}
              />
              <div
                ref={(element) => setState("tabsMount", element)}
                data-slot="vertical-tabs-mount"
                class="absolute inset-y-0 end-0 contain-strict [overflow-clip-margin:var(--sidebar-divider-bleed,0px)] will-change-[opacity] flex min-h-0 flex-col bg-v2-background-bg-deep ps-[var(--sidebar-inset-start)] pe-[var(--sidebar-inset-end)] pb-[var(--shell-bottom-inset,8px)] pt-[var(--shell-top-inset,8px)]"
                style={{
                  width: `${sidebarWidth()}px`,
                  "padding-bottom": "max(10px, var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)))",
                }}
              />
            </div>
            {/* Takes the pointer while the sidebar closes, without restyling its contents. */}
            <div
              class="absolute inset-0 z-20"
              classList={{ hidden: preferences.appearance.sidebarOpen() || !sidebarMotion.present() }}
            />
            <Show when={preferences.appearance.sidebarOpen()}>
              {/* The sidebar's floor stays readable; its cap leaves the content beside it
                  its own floor (see sidebarMax). A double-click returns to the default. */}
              <ResizeHandle
                direction="horizontal"
                size={sidebarWidth()}
                min={SIDEBAR_WIDTH_MIN}
                max={sidebarMax()}
                onResize={(width) => {
                  setState("tabsWidth", width)
                  preferences.appearance.setSidebarWidth(width)
                }}
                onReset={() => {
                  setState("tabsWidth", SIDEBAR_WIDTH_DEFAULT)
                  preferences.appearance.setSidebarWidth(SIDEBAR_WIDTH_DEFAULT)
                }}
                onDraggingChange={setPanelResizing}
              />
            </Show>
          </aside>
        </Show>
        {/* Size containment collapses percentage-height descendants in WebKit. */}
        <main
          class="flex-1 min-h-0 min-w-0 overflow-x-hidden flex flex-col items-start contain-content"
          style={{
            "padding-top": bottomTitlebar() ? "env(safe-area-inset-top, 0px)" : "0px",
            // A docked composer touch bar takes over the safe area.
            "padding-bottom":
              bottomTitlebar() || settings.active()
                ? "0px"
                : "var(--shell-safe-area-bottom, var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)))",
            "--settings-bottom-inset": bottomTitlebar()
              ? "40px"
              : "var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))",
          }}
        >
          <PluginServerCover>
            <Suspense>{props.children}</Suspense>
          </PluginServerCover>
        </main>
        <CollapsedSidebarToggle />
      </div>
      {/* On touch devices the active composer moves its actions here: the bottom edge, or the top of the keyboard.
          Last in order, so it stays below a bottom titlebar (also order-last, but earlier in the DOM). */}
      <div data-slot="composer-touch-bar-mount" class="order-last shrink-0" />
      <PluginSlot at="window.bottom" input={{}} />
      <ToastRegion />
      <UploadToastHost />
    </div>
  )
}
