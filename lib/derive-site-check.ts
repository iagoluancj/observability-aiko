import type { CheckUrlResult } from "@/lib/check-url"
import type { SiteCheck, SiteStatus } from "@/lib/types"

function parseHttpStatus(response: CheckUrlResult["response"]): number | null {
  if (!("httpStatus" in response)) return null
  const raw = response.httpStatus
  if (typeof raw === "number") return raw
  if (typeof raw === "string") {
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function parseResponseTimeMs(response: CheckUrlResult["response"]): number | null {
  if (!("responseTimeMs" in response)) return null
  const raw = response.responseTimeMs
  if (typeof raw === "number") return raw
  if (typeof raw === "string") {
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/**
 * Mesmas regras de `POST /api/check-site`: online/offline/unstable a partir do resultado de `checkUrl`.
 */
export function deriveSiteCheckFromUrlResult(
  result: CheckUrlResult,
  fallbackResponseTimeMs: number,
): SiteCheck {
  const response = result.response
  const online = Boolean(response && "online" in response && response.online)

  const httpStatus = parseHttpStatus(response)
  const responseTimeMs = parseResponseTimeMs(response)

  let status: SiteStatus = "online"
  if (!online) {
    status = "offline"
  } else if (httpStatus !== null && httpStatus >= 500) {
    status = "offline"
  } else if (httpStatus !== null && httpStatus >= 400) {
    status = "unstable"
  } else if (responseTimeMs !== null && responseTimeMs > 5000) {
    status = "unstable"
  }

  return {
    status,
    httpCode: httpStatus,
    responseTime: responseTimeMs ?? fallbackResponseTimeMs,
    timestamp: new Date().toISOString(),
  }
}
