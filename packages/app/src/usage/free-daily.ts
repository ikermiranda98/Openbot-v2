import type { SessionStatsInfo, SessionStatsModelUsage } from "@opencode/client/promise"

// OpenCode's free tier, per the gateway's last public limiter (zen/util/ipRateLimiter.ts): one
// counter of model requests per client IP (an IPv6 address cut to its /64) and UTC day, raised
// once per finished response; there is no token cap. The limit itself lives in private config:
// 243 is the figure measured on 12 Nov 2026 from the gateway's own automatic refusal on a fresh
// WARP /64 (243 finished requests). Behind a shared exit such as Cloudflare WARP the counter also
// holds other people's requests and moves with the exit address, so this desk's own count is an
// estimate; the ring states the gateway's own block (FreeUsageLimitError) the moment one arrives.
// Re-measure on a dedicated exit before trusting a new value.
export const FREE_DAILY_REQUESTS = 243

/** Midnight UTC of the day `now` falls in, as epoch ms: the start of today's allowance. */
export function startOfFreeDay(now: number) {
  const day = new Date(now)

  day.setUTCHours(0, 0, 0, 0)

  return day.getTime()
}

/** Today's use of the free allowance, from the local session stats since midnight UTC. A model
 * counts as free when OpenCode serves it at no cost — the same rule the model picker's "free"
 * badge reads. Each step is one finished model request, the only thing the gateway's counter
 * raises on; a refused attempt carries an error and the server never counts it here. Tokens
 * are reported for reference. */
export function freeDailyUsage(stats: Pick<SessionStatsInfo, "models">) {
  const free = stats.models.filter(isFree)
  const requests = free.reduce((sum, usage) => sum + usage.steps, 0)

  return {
    tokens: free.reduce((sum, usage) => sum + usage.tokens.input + usage.tokens.output + usage.tokens.reasoning, 0),
    requests,
    percent: Math.min(100, (requests / FREE_DAILY_REQUESTS) * 100),
  }
}

/** The current exit's share of the allowance. The gateway counts per /64, so a rotation onto a fresh
 * /64 starts the count over: `since` is the day's request count when the current /64 landed (zero
 * before the day's first rotation). */
export function freeExitUsage(day: { requests: number }, since: number) {
  const requests = Math.max(0, day.requests - since)

  return { requests, percent: Math.min(100, (requests / FREE_DAILY_REQUESTS) * 100) }
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

/** The ring's band for a day's use, read on the whole percent the tooltip shows: calm up to 60%,
 * a warning from 61% to 89%, danger from 90%. */
export type FreeDailyLevel = "normal" | "warning" | "danger"

export function freeDailyLevel(percent: number): FreeDailyLevel {
  const shown = Math.round(percent)

  if (shown >= 90) return "danger"

  if (shown > 60) return "warning"

  return "normal"
}
