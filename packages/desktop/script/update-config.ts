import { getConfig } from "../electron-builder.config"
import path from "node:path"

// electron-builder writes resources/app-update.yml only for dmg, zip and nsis targets, not for --dir builds.
// electron-updater reads its feed from that file, so write the one those targets would.
export async function writeUpdateConfig(resources: string) {
  const publish = getConfig().publish
  const name: string = (await Bun.file("package.json").json()).name
  const feed =
    publish.provider === "github"
      ? [`owner: ${publish.owner}`, `repo: ${publish.repo}`]
      : [`url: ${publish.url}`, `channel: ${publish.channel}`]
  await Bun.write(
    path.join(resources, "app-update.yml"),
    [
      `provider: ${publish.provider}`,
      ...feed,
      `updaterCacheDirName: '${name.replace(/[/\\:*?"<>|]/g, "").toLowerCase()}-updater'`,
    ].join("\n") + "\n",
  )
}
