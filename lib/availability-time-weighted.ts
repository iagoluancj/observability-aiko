import type { PersistedStatus } from "@/lib/availability-log-policy"

export interface TimeWeightedSegmentInput {
  checked_at: string
  status: PersistedStatus
}

/**
 * Integra o tempo na janela [windowStartMs, windowEndMs] assumindo que,
 * após cada evento, o estado permanece até o próximo (função em degrau).
 * `seed` é o estado imediatamente antes do início da janela (último registro anterior).
 * Se `seed` for null, assume-se `online` no início (otimista).
 */
export function integrateAvailabilityWindow(
  windowStartMs: number,
  windowEndMs: number,
  seed: PersistedStatus | null,
  eventsInWindow: TimeWeightedSegmentInput[],
): { onlineMs: number; unstableMs: number; offlineMs: number } {
  const sorted = [...eventsInWindow]
    .map((e) => ({
      t: new Date(e.checked_at).getTime(),
      status: e.status,
    }))
    .filter((e) => Number.isFinite(e.t) && e.t < windowEndMs)
    .sort((a, b) => a.t - b.t)

  let state: PersistedStatus = seed ?? "online"
  let cursor = windowStartMs
  let onlineMs = 0
  let unstableMs = 0
  let offlineMs = 0

  const add = (from: number, to: number) => {
    const dt = Math.max(0, to - from)
    if (state === "online") onlineMs += dt
    else if (state === "unstable") unstableMs += dt
    else offlineMs += dt
  }

  for (const e of sorted) {
    if (e.t < windowStartMs) {
      state = e.status
      continue
    }
    add(cursor, e.t)
    cursor = e.t
    state = e.status
  }
  add(cursor, windowEndMs)

  return { onlineMs, unstableMs, offlineMs }
}

export function uptimePctFromMs(onlineMs: number, windowMs: number): number | null {
  if (windowMs <= 0) return null
  return Math.round((onlineMs / windowMs) * 1000) / 10
}
