export type PersistedStatus = "online" | "offline" | "unstable"

export interface PreviousAvailabilityRow {
  status: PersistedStatus
  checkedAt: string
  responseTimeMs: number | null
}

export interface IncomingAvailabilityCheck {
  status: PersistedStatus
  responseTimeMs: number | null
  checkedAt: string
}

export interface AvailabilityLogPolicyEnv {
  /** Se definido, registra mesmo com status online quando RT &lt; este valor (ms). */
  minResponseMs: number | null
  /** Se definido, registra mesmo com status online quando RT &gt; este valor (ms). */
  maxResponseMs: number | null
}

export function parseAvailabilityLogPolicyFromEnv(): AvailabilityLogPolicyEnv {
  const minRaw = process.env.AVAILABILITY_LOG_MIN_RESPONSE_MS
  const maxRaw = process.env.AVAILABILITY_LOG_MAX_RESPONSE_MS
  const min = minRaw != null && minRaw !== "" ? Number(minRaw) : null
  const max = maxRaw != null && maxRaw !== "" ? Number(maxRaw) : null
  return {
    minResponseMs: min != null && Number.isFinite(min) ? min : null,
    maxResponseMs: max != null && Number.isFinite(max) ? max : null,
  }
}

/**
 * Política esparsa:
 * - Sem histórico: sempre persiste (estado inicial).
 * - Mudou status: persiste.
 * - Continua online: só persiste se RT violar min/max (degradação).
 * - Continua offline ou instável: não persiste (evita duplicatas).
 */
export function shouldPersistAvailabilityRow(
  prev: PreviousAvailabilityRow | null,
  next: IncomingAvailabilityCheck,
  policy: AvailabilityLogPolicyEnv,
): boolean {
  if (!prev) return true

  if (prev.status !== next.status) return true

  if (next.status === "online") {
    const rt = next.responseTimeMs
    if (rt == null || !Number.isFinite(rt)) return false
    if (policy.minResponseMs != null && rt < policy.minResponseMs) return true
    if (policy.maxResponseMs != null && rt > policy.maxResponseMs) return true
    return false
  }

  return false
}
