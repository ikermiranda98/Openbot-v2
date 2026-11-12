import type { SessionStatsInfo, SessionStatsModelUsage } from "@opencode/client/promise"

// OpenCode's free tier, per the gateway's last public limiter (zen/util/ipRateLimiter.ts): one
// counter of model requests per client IP (an IPv6 address cut to its /64) and UTC day, raised
// once per finished response; there is no token cap. The limit itself lives in private config.
// 268 is the seed measured on 12 Nov 2026: two fresh WARP /64s held 251 and 285 of this desk's
// whole traffic before the gateway refused, so the midpoint is the best fixed guess. The real
// figure moves with the /64 WARP lands — it is shared with whoever else uses it — so each
// refusal records the count that fit and the ring follows the median of the latest samples.
// A refusal is still the only exact read of the limit, and the only trigger of a rotation.
export const FREE_DAILY_REQUESTS = 268

// A refusal after a handful of requests is a dead or already-spent exit, not that exit's
// capacity; one such sample would drag the ring down for good. Keep the latest few real ones.
const SAMPLE_COUNT = 5
const SAMPLE_FLOOR = FREE_DAILY_REQUESTS / 4

/** Midnight UTC of the day `now` falls in, as epoch ms: the start of today's allowance. */
export function startOfFreeDay(now: number) {
  const day = new Date(now)

  day.setUTCHours(0, 0, 0, 0)

  return day.getTime()
}

/** The denominator the ring divides by: the seed until a refusal has measured this exit, then
 * the median of the latest samples. Each sample is how many of this desk's requests the gateway
 * accepted on an exit before refusing it, so the ring reaches 100% at the same point the
 * gateway does on that kind of /64. */
export function freeDailyLimit(samples: readonly number[]) {
  const usable = samples.filter((sample) => sample >= SAMPLE_FLOOR)

  if (usable.length === 0) return FREE_DAILY_REQUESTS

  return median(usable.slice(-SAMPLE_COUNT))
}

/** Today's use of the free allowance, from the local session stats since midnight UTC. The
 * gateway counts every finished free request of this machine, so `gatewayRequests` — the local
 * log of exactly those requests — is the count when the server reports it. An older server
 * only has `models` steps, which leaves titles, compactions and generate out; the ring falls
 * back to them so it keeps working, one update behind. Tokens are reported for reference. */
export function freeDailyUsage(
  stats: Pick<SessionStatsInfo, "models" | "gatewayRequests">,
  limit = FREE_DAILY_REQUESTS,
) {
  const free = stats.models.filter(isFree)
  const requests = requestsOf(stats)

  return {
    tokens: free.reduce((sum, usage) => sum + usage.tokens.input + usage.tokens.output + usage.tokens.reasoning, 0),
    requests,
    percent: Math.min(100, (requests / limit) * 100),
  }
}

/** The whole desk's use: every visible server's count, each from its gateway log when it has one
 * and from its free models' steps when it does not. One old server must not hide a new server's
 * titles and compactions, so the fallback is per server. */
export function freeDailyUsageOf(
  servers: ReadonlyArray<Pick<SessionStatsInfo, "models" | "gatewayRequests">>,
  limit = FREE_DAILY_REQUESTS,
) {
  return freeDailyUsage(
    {
      models: servers.flatMap((stats) => stats.models),
      gatewayRequests: servers.reduce((sum, stats) => sum + requestsOf(stats), 0),
    },
    limit,
  )
}

/** The current exit's share of the allowance. The gateway counts per /64, so a rotation onto a fresh
 * /64 starts the count over: `since` is the day's request count when the current /64 landed (zero
 * before the day's first rotation). */
export function freeExitUsage(day: { requests: number }, since: number, limit = FREE_DAILY_REQUESTS) {
  const requests = Math.max(0, day.requests - since)

  return { requests, percent: Math.min(100, (requests / limit) * 100) }
}

/** The /64 bucket of an IPv6 address: the first four hextets of its expanded form — the same cut the
 * gateway limits by and the engine's memory dedupes against. The ring records it with the exit so a
 * rotation it did not ask for (the desktop bat, a script) is recognized by the engine's current bucket. */
export function ipv6BucketOf(address: string) {
  const half = address.indexOf("::")
  const left = half >= 0 ? (address.slice(0, half) === "" ? [] : address.slice(0, half).split(":")) : address.split(":")
  const right = half >= 0 ? (address.slice(half + 2) === "" ? [] : address.slice(half + 2).split(":")) : []
  if (left.length + right.length > 8) return undefined
  const gaps = Math.max(8 - left.length - right.length, 0)
  const segs = [...left, ...Array.from({ length: gaps }, () => "0"), ...right]
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

function isFree(usage: SessionStatsModelUsage) {
  return usage.model.providerID === "opencode" && usage.cost === 0
}

function requestsOf(stats: Pick<SessionStatsInfo, "models" | "gatewayRequests">) {
  return stats.gatewayRequests ?? stats.models.filter(isFree).reduce((sum, usage) => sum + usage.steps, 0)
}

function median(values: number[]) {
  const sorted = values.toSorted((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

/** The ring's band for a day's use, read on the whole percent the tooltip shows: calm up to 60%,
 * a warning from 61% to 89%, danger from 90%. */
export type FreeDailyLevel = "normal" | "warning" | "danger"

export function freeDailyLevel(percent: number): FreeDailyLevel {
  const shown = Math.round(percent)

  if (shown >= 90) return "danger"

  if (shown > 60) return "warning"

  return "normal"
}
