import { describe, expect, test } from "bun:test"
import type { SessionStatsModelUsage } from "@opencode/client/promise"
import { FREE_DAILY_REQUESTS, freeDailyLevel, freeDailyUsage, freeExitUsage, ipv6BucketOf, startOfFreeDay } from "./free-daily"

const usage = (providerID: string, id: string, cost: number, steps: number, tokens: [number, number, number, number, number]): SessionStatsModelUsage => ({
  model: { providerID, id },
  steps,
  tokens: { input: tokens[0], output: tokens[1], reasoning: tokens[2], cache: { read: tokens[3], write: tokens[4] } },
  cost,
})

describe("freeDailyUsage", () => {
  test("counts OpenCode's no-cost models only, and reports tokens without cached reads", () => {
    const result = freeDailyUsage({
      models: [
        usage("opencode", "glm-5.3-flash-free", 0, 30, [300_000, 20_000, 80_000, 2_000_000, 50_000]),
        usage("opencode", "deepseek-v4.1-flash-free", 0, 11, [100_000, 0, 0, 0, 0]),
        // Paid OpenCode Zen and another provider's free-of-charge rows stay out.
        usage("opencode", "claude-opus-5-5", 1.25, 50, [400_000, 1_000, 0, 0, 0]),
        usage("anthropic", "claude-haiku-5-5", 0, 50, [900_000, 0, 0, 0, 0]),
      ],
    })

    expect(result.tokens).toBe(500_000)
    expect(result.requests).toBe(41)
    expect(result.percent).toBeCloseTo((41 / FREE_DAILY_REQUESTS) * 100, 10)
  })

  test("only requests fill the ring, which stops at 100%", () => {
    const tokens = freeDailyUsage({ models: [usage("opencode", "big-pickle", 0, 10, [9_000_000, 0, 0, 0, 0])] })
    expect(tokens.percent).toBeCloseTo((10 / FREE_DAILY_REQUESTS) * 100, 2)

    const requests = freeDailyUsage({ models: [usage("opencode", "big-pickle", 0, FREE_DAILY_REQUESTS * 2, [1_000, 0, 0, 0, 0])] })
    expect(requests.percent).toBe(100)

    expect(freeDailyUsage({ models: [] }).percent).toBe(0)
  })
})

describe("freeExitUsage", () => {
  test("counts only the requests since the current /64 landed", () => {
    expect(freeExitUsage({ requests: 41 }, 0)).toEqual({ requests: 41, percent: (41 / FREE_DAILY_REQUESTS) * 100 })
    expect(freeExitUsage({ requests: 190 }, 185).requests).toBe(5)
    expect(freeExitUsage({ requests: 400 }, 0).percent).toBe(100)
  })

  test("never reads below zero when the day's count lags the rotation's", () => {
    expect(freeExitUsage({ requests: 10 }, 12)).toEqual({ requests: 0, percent: 0 })
  })
})

describe("startOfFreeDay", () => {
  test("is midnight UTC of the given moment, whatever the local zone", () => {
    expect(startOfFreeDay(Date.UTC(2026, 10, 2, 23, 59, 59))).toBe(Date.UTC(2026, 10, 2))
    expect(startOfFreeDay(Date.UTC(2026, 10, 3, 0, 0, 1))).toBe(Date.UTC(2026, 10, 3))
  })
})

describe("freeDailyLevel", () => {
  test("reads blue up to 60%, yellow from 61% to 89% and red from 90%, on the shown whole percent", () => {
    expect(freeDailyLevel(0)).toBe("normal")
    expect(freeDailyLevel(60)).toBe("normal")
    expect(freeDailyLevel(60.4)).toBe("normal")
    expect(freeDailyLevel(60.5)).toBe("warning")
    expect(freeDailyLevel(89.4)).toBe("warning")
    expect(freeDailyLevel(89.5)).toBe("danger")
    expect(freeDailyLevel(90)).toBe("danger")
    expect(freeDailyLevel(100)).toBe("danger")
  })
})

describe("ipv6BucketOf", () => {
  test("cuts an expanded address to the gateway's own /64, whatever notation it arrived in", () => {
    expect(ipv6BucketOf("2a09:bac1:7680:728::1fb:116")).toBe("2a09:bac1:7680:728")
    expect(ipv6BucketOf("2606:4700:0078:0090:0000:0000:0000:0141")).toBe("2606:4700:78:90")
    expect(ipv6BucketOf("2001:db8::42")).toBe("2001:db8:0:0")
    expect(ipv6BucketOf("::1")).toBe("0:0:0:0")
  })

  test("rejects text that cannot be an IPv6 address", () => {
    expect(ipv6BucketOf("2606:4700:0078:0090:0000:0000:0000:0141:ff")).toBeUndefined()
    expect(ipv6BucketOf("no-an-ipv6")).toBeUndefined()
    expect(ipv6BucketOf("::")).toBe("0:0:0:0")
  })
})
