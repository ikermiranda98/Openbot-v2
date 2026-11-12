export function redactSecrets(text: string): string {
  let result = text
  result = result.replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer [REDACTED]")
  result = result.replace(/\beyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\b/g, "[REDACTED]")
  result = result.replace(/(api[_-]?key\s*[:=]\s*["']?)[^"'\s]+/gi, "$1[REDACTED]")
  result = result.replace(/(password\s*[:=]\s*["']?)[^"'\s]+/gi, "$1[REDACTED]")
  result = result.replace(/(https?:\/\/)[^/\s:@]+:[^/\s:@]+@/gi, "$1[REDACTED]@")
  result = result.replace(/[A-Za-z]:\\[^\s"']*/g, "[REDACTED]")
  result = result.replace(/(^|[\s"'(])(\/[^\s"']+)/g, "$1[REDACTED]")
  return result
}