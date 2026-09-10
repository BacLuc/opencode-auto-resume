export function isNonRetryableError(errorObj: Record<string, unknown> | undefined): boolean {
    if (!errorObj || typeof errorObj !== "object") return false

    const name = errorObj.name as string | undefined
    const data = errorObj.data as Record<string, unknown> | undefined

    // Structured signals — checked first (fast, deterministic)
    if (name === "ProviderAuthError") return true

    if (name === "APIError" && data && typeof data === "object") {
        if (data.isRetryable === false) return true
        const sc = data.statusCode as number | undefined
        if (typeof sc === "number" && (sc === 401 || sc === 402 || sc === 403)) return true
    }

    // Narrow message-regex fallback — only covers auth/billing, NOT rate-limit/timeout.
    // Deliberately does NOT match: "rate limit", "timeout", 429 with isRetryable:true.
    // Those stay on the normal backoff path.
    const msg = data?.message as string | undefined
    if (typeof msg === "string") {
        const lower = msg.toLowerCase()
        if (/insufficient.{0,15}(balance|budget|quota|credit)/i.test(lower)) return true
        if (/credit.{0,10}balance.{0,20}too low/i.test(lower)) return true
        if (/out of (credits?|quota)/i.test(lower)) return true
        if (/not enough (credits?|balance|funds)/i.test(lower)) return true
        if (/payment required/i.test(lower)) return true
        if (/(invalid|expired|revoked|not valid).{0,8}(api.?key|access.?token|token|credential)/i.test(lower)) return true
        if (/(api.?key|access.?token|token|credential).{0,8}(invalid|expired|revoked|not valid)/i.test(lower)) return true
        if (/authentication (failed|error)/i.test(lower)) return true
        if (/unauthorized/i.test(lower)) return true
        if (/personal access tokens? are not supported/i.test(lower)) return true
        if (/invalid authorization token/i.test(lower)) return true
    }

    return false
}
