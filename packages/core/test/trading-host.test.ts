import { describe, expect, test } from "bun:test"
import { TradingEngine } from "@opencode/core/trading"

const valido = (host: string) => expect(TradingEngine.hostTwsPermitido(host)).toBe(true)
const invalido = (host: string) => expect(TradingEngine.hostTwsPermitido(host)).toBe(false)

describe("hostTwsPermitido", () => {
  test("acepta loopback y redes privadas", () => {
    for (const host of [
      "127.0.0.1",
      "127.255.255.255",
      "10.0.0.1",
      "10.255.255.255",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.0.1",
      "192.168.255.255",
      "::1",
      "0:0:0:0:0:0:0:1",
      "fc00::1",
      "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
      "::ffff:127.0.0.1",
      "::ffff:10.0.0.1",
    ]) valido(host)
  })

  test("rechaza IPs públicas y fuera de rango", () => {
    for (const host of [
      "8.8.8.8",
      "172.15.0.1",
      "172.32.0.1",
      "192.167.1.1",
      "11.0.0.1",
      "fe80::1",
      "2001:db8::1",
      "::",
      "0.0.0.0",
    ]) invalido(host)
  })

  test("rechaza hostnames y entradas malformadas", () => {
    for (const host of [
      "localhost",
      "example.com",
      "::1%eth0",
      "010.0.0.1",
      "",
      "a".repeat(81),
    ]) invalido(host)
  })
})