import { describe, expect, test } from "bun:test"
import { redactSecrets } from "./redact"

describe("redactSecrets", () => {
  test("redacts bearer tokens", () => {
    expect(redactSecrets("Authorization: Bearer abc.def-ghi")).toBe("Authorization: Bearer [REDACTED]")
  })

  test("redacts JWTs", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"
    expect(redactSecrets(`token=${jwt}`)).toBe("token=[REDACTED]")
  })

  test("redacts api keys and passwords", () => {
    expect(redactSecrets('api_key="secret123"')).toBe('api_key="[REDACTED]"')
    expect(redactSecrets("password: hunter2")).toBe("password: [REDACTED]")
  })

  test("redacts userinfo in URLs", () => {
    expect(redactSecrets("https://user:pass@example.com/path")).toBe("https://[REDACTED]@example.com/path")
  })

  test("redacts absolute paths", () => {
    expect(redactSecrets("C:\\Users\\iker\\secret.txt")).toBe("[REDACTED]")
    expect(redactSecrets("see /home/iker/secret.txt")).toBe("see [REDACTED]")
  })

  test("leaves clean text unchanged", () => {
    const clean = "no secrets here, just a normal log line"
    expect(redactSecrets(clean)).toBe(clean)
  })
})