import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..", "..")
const version = readFileSync(path.join(root, "process-daemon", "PROTOCOL_VERSION"), "utf8").trim()
const target = path.join(root, "core", "src", "persistent-pty", "protocol-version.ts")
writeFileSync(target, `export const ProtocolVersion = ${version}\n`)
console.log("wrote", target, version)
