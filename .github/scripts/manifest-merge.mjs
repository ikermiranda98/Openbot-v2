/* Reconcile the fork's package.json manifests against upstream's in the weekly sync.
 *
 * The fork declares manifest entries upstream has never seen (the ibkr wire and its
 * patch registration among them). A weekly merge can lose exactly those lines when
 * upstream - which edits the same sections - reshapes them: the merge conflicts on
 * the block's tail, or a clean merge drops one side's addition. Local trees keep
 * resolving through node_modules leftovers either way; a fresh CI install does not.
 * Two modes, driven by the sync workflow:
 *
 *   resolve  For a conflicted package.json, rebuild the file from both sides:
 *            upstream's shape and versions win wherever upstream writes, the
 *            fork keeps the entries upstream does not have, arrays union with
 *            upstream's members first.
 *   assert   After the merge (clean or resolved), re-insert fork-only entries
 *            the merge dropped from the maps both sides shape the same way.
 *
 * Env: resolve reads OURS_SHA (the branch tip) and THEIRS_SHA (the upstream head);
 * assert reads BASE_SHA (the branch tip) and THEIRS_SHA. Both stages git-add the
 * files they touch.
 *
 * Usage: node manifest-merge.mjs resolve <file>...
 *        node manifest-merge.mjs assert <file>...
 */

import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"

const [mode, ...files] = process.argv.slice(2)

const gitShow = (spec) => {
  const out = spawnSync("git", ["show", spec], { encoding: "utf8", maxBuffer: 1 << 24 })
  if (out.status !== 0) throw new Error(`git show ${spec} failed: ${out.stderr}`)
  return out.stdout
}

const gitAdd = (file) => {
  const out = spawnSync("git", ["add", "--", file], { encoding: "utf8" })
  if (out.status !== 0) throw new Error(`git add ${file} failed: ${out.stderr}`)
}

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value)

// Upstream wins on every shared key; fork-only keys ride along unchanged.
// Versioned maps ("name@version") are the exception: when upstream carries the
// same package under a different version key, the fork's old-version entry is
// superseded - its patch file died upstream, so keeping it would break installs.
const packageOf = (key) => {
  const at = key.lastIndexOf("@")
  return at > 0 ? key.slice(0, at) : key
}

const union = (ours, theirs, path = "") => {
  if (Array.isArray(theirs)) {
    const seen = new Set(theirs.map((item) => JSON.stringify(item)))
    const extras = (Array.isArray(ours) ? ours : []).filter(
      (item) => !seen.has(JSON.stringify(item)),
    )
    return [...theirs, ...extras]
  }
  if (isPlainObject(theirs)) {
    const versioned = path.endsWith("patchedDependencies")
    const theirPackages = versioned
      ? new Set(Object.keys(theirs).map((key) => packageOf(key)))
      : null
    const merged = {}
    for (const [key, value] of Object.entries(theirs)) {
      merged[key] = isPlainObject(ours?.[key])
        ? union(ours[key], value, path ? `${path}.${key}` : key)
        : value
    }
    for (const [key, value] of Object.entries(ours ?? {})) {
      if (key in merged) continue
      if (theirPackages?.has(packageOf(key))) continue
      merged[key] = value
    }
    return merged
  }
  return theirs
}

// Maps whose keys the fork extends but upstream also writes; assert only
// re-inserts into these shared shapes, so nothing outside them ever resurrects.
const sharedMaps = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
  "patchedDependencies",
  "overrides",
  "resolutions",
]

const resolve = (file) => {
  const oursSha = process.env.OURS_SHA
  const theirsSha = process.env.THEIRS_SHA
  if (!oursSha || !theirsSha) throw new Error("resolve needs OURS_SHA and THEIRS_SHA")
  const ours = JSON.parse(gitShow(`${oursSha}:${file}`))
  const theirs = JSON.parse(gitShow(`${theirsSha}:${file}`))
  writeFileSync(file, `${JSON.stringify(union(ours, theirs), null, 2)}\n`)
  gitAdd(file)
  process.stdout.write(`manifest-merge: resolved ${file}\n`)
}

const assert = (file) => {
  const baseSha = process.env.BASE_SHA
  const theirsSha = process.env.THEIRS_SHA
  if (!baseSha || !theirsSha) throw new Error("assert needs BASE_SHA and THEIRS_SHA")
  const base = JSON.parse(gitShow(`${baseSha}:${file}`))
  const theirs = JSON.parse(gitShow(`${theirsSha}:${file}`))
  const current = JSON.parse(readFileSync(file, "utf8"))
  let changed = false
  for (const map of sharedMaps) {
    // Same supersede rule resolve applies: a versioned patch entry upstream
    // replaced with a newer version keys for the same package is dead upstream.
    const versioned = map === "patchedDependencies"
    const theirPackages = versioned
      ? new Set(Object.keys(theirs[map] ?? {}).map((key) => packageOf(key)))
      : null
    for (const [key, value] of Object.entries(base[map] ?? {})) {
      // Upstream knowing the key means the merged tree already carries their
      // version; only entries upstream has never heard of are fork-owned.
      if (theirs[map]?.[key] !== undefined) continue
      if (theirPackages?.has(packageOf(key))) continue
      if (current[map]?.[key] !== undefined) continue
      current[map] = current[map] ?? {}
      current[map][key] = value
      changed = true
    }
  }
  if (changed) {
    writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`)
    gitAdd(file)
    process.stdout.write(`manifest-merge: reasserted fork-only entries of ${file}\n`)
  }
}

for (const file of files) {
  if (mode === "resolve") resolve(file)
  else if (mode === "assert") assert(file)
  else throw new Error(`unknown mode ${mode} (expected resolve or assert)`)
}
