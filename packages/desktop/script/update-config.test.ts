import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { writeUpdateConfig } from "./update-config"

// One table across channels: a GitHub-releasing fork's feed must name owner and repo, the opencode.ai
// channels feed must name url and channel; the wrong schema leaves the packaged app unable to update.
const cases = [
  {
    channel: "dev",
    releases: "ikermiranda98/Openbot-v2",
    lines: [
      "provider: github",
      "owner: ikermiranda98",
      "repo: Openbot-v2",
      "updaterCacheDirName: '@opencodedesktop-updater'",
    ],
  },
  {
    channel: "dev",
    releases: undefined,
    lines: [
      "provider: generic",
      "url: https://opencode.ai/update/api/dev/desktop/opencode/",
      "channel: latest",
      "updaterCacheDirName: '@opencodedesktop-updater'",
    ],
  },
  {
    channel: "beta",
    releases: undefined,
    lines: [
      "provider: generic",
      "url: https://opencode.ai/update/api/beta/desktop/opencode/",
      "channel: latest",
      "updaterCacheDirName: '@opencodedesktop-updater'",
    ],
  },
  {
    channel: "prod",
    releases: undefined,
    lines: [
      "provider: github",
      "owner: ikermiranda98",
      "repo: Openbot-v2",
      "updaterCacheDirName: '@opencodedesktop-updater'",
    ],
  },
]

test("app-update.yml matches the feed it updates from", async () => {
  const saved = { channel: process.env.OPENCODE_CHANNEL, releases: process.env.OPENBOT_RELEASES_REPO }
  const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-update-config-"))

  try {
    for (const [index, item] of cases.entries()) {
      if (item.channel === undefined) delete process.env.OPENCODE_CHANNEL
      else process.env.OPENCODE_CHANNEL = item.channel
      if (item.releases === undefined) delete process.env.OPENBOT_RELEASES_REPO
      else process.env.OPENBOT_RELEASES_REPO = item.releases

      const resources = path.join(dir, String(index))
      await mkdir(resources, { recursive: true })
      await writeUpdateConfig(resources)
      expect(await readFile(path.join(resources, "app-update.yml"), "utf8")).toBe([...item.lines, ""].join("\n"))
    }
  } finally {
    if (saved.channel === undefined) delete process.env.OPENCODE_CHANNEL
    else process.env.OPENCODE_CHANNEL = saved.channel
    if (saved.releases === undefined) delete process.env.OPENBOT_RELEASES_REPO
    else process.env.OPENBOT_RELEASES_REPO = saved.releases
    await rm(dir, { recursive: true, force: true })
  }
})
