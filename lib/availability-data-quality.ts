import type { PersistedStatus } from "@/lib/availability-log-policy"

export interface AvailabilityEventInput {
  checked_at: string
  status: PersistedStatus
}

export interface IntegrateWithQualityParams {
  windowStartMs: number
  windowEndMs: number
  seed: PersistedStatus | null
  eventsInWindow: AvailabilityEventInput[]
  maxCarryForwardMs: number
}

export interface IntegratedAvailabilityWithQuality {
  onlineMs: number
  unstableMs: number
  offlineMs: number
  unknownMs: number
  knownMs: number
  confidencePct: number
  largestGapMs: number
  maxCarryForwardMs: number
}

export interface AvailabilityCoverageRange {
  startMs: number
  endMs: number
}

export interface AvailabilityCoverageResult {
  ranges: AvailabilityCoverageRange[]
  gapCount: number
  uncoveredMs: number
  largestGapMs: number
}

interface ParseIntOpts {
  min: number
  fallback: number
}

function parsePositiveInt(raw: string | undefined, opts: ParseIntOpts): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n < opts.min) return opts.fallback
  return Math.round(n)
}

export function readExpectedCollectionIntervalMsFromEnv(): number {
  return parsePositiveInt(process.env.AVAILABILITY_EXPECTED_INTERVAL_MS, {
    min: 5_000,
    fallback: parsePositiveInt(process.env.AVAILABILITY_CRON_INTERVAL_MS, {
      min: 5_000,
      fallback: parsePositiveInt(process.env.NEXT_PUBLIC_MONITOR_POLL_INTERVAL_MS, {
        min: 5_000,
        fallback: 120_000,
      }),
    }),
  })
}

export function readMaxCarryForwardMsFromEnv(): number {
  const expected = readExpectedCollectionIntervalMsFromEnv()
  return parsePositiveInt(process.env.AVAILABILITY_MAX_CARRY_FORWARD_MS, {
    min: expected,
    fallback: Math.max(60_000, expected * 3),
  })
}

export function readStaleAfterMsFromEnv(): number {
  const maxCarry = readMaxCarryForwardMsFromEnv()
  return parsePositiveInt(process.env.AVAILABILITY_STALE_AFTER_MS, {
    min: maxCarry,
    fallback: maxCarry,
  })
}

function toMs(iso: string): number {
  const t = new Date(iso).getTime()
  return Number.isFinite(t) ? t : NaN
}

function safePct(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((numerator / denominator) * 1000) / 10))
}

/**
 * Constrói intervalos de cobertura com base no heartbeat de execução da coleta.
 * Cada run cobre [run_at, run_at + maxCarryForwardMs]. Fora disso, o período é "desconhecido".
 */
export function buildCoverageFromCollectionRuns(
  windowStartMs: number,
  windowEndMs: number,
  runAts: string[],
  maxCarryForwardMs: number,
): AvailabilityCoverageResult {
  if (windowEndMs <= windowStartMs) {
    return { ranges: [], gapCount: 0, uncoveredMs: 0, largestGapMs: 0 }
  }

  const sorted = runAts
    .map(toMs)
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b)

  if (sorted.length === 0) {
    const whole = windowEndMs - windowStartMs
    return { ranges: [], gapCount: whole > 0 ? 1 : 0, uncoveredMs: whole, largestGapMs: whole }
  }

  const ranges: AvailabilityCoverageRange[] = []
  for (const t of sorted) {
    const startMs = Math.max(windowStartMs, t)
    const endMs = Math.min(windowEndMs, t + maxCarryForwardMs)
    if (endMs <= startMs) continue

    const prev = ranges[ranges.length - 1]
    if (!prev || startMs > prev.endMs) {
      ranges.push({ startMs, endMs })
      continue
    }
    if (endMs > prev.endMs) prev.endMs = endMs
  }

  let uncoveredMs = 0
  let gapCount = 0
  let largestGapMs = 0
  let cursor = windowStartMs
  for (const r of ranges) {
    if (r.startMs > cursor) {
      const gap = r.startMs - cursor
      uncoveredMs += gap
      if (gap > largestGapMs) largestGapMs = gap
      gapCount += 1
    }
    cursor = Math.max(cursor, r.endMs)
  }
  if (cursor < windowEndMs) {
    const gap = windowEndMs - cursor
    uncoveredMs += gap
    if (gap > largestGapMs) largestGapMs = gap
    gapCount += 1
  }

  return { ranges, gapCount, uncoveredMs, largestGapMs }
}

export function computeFreshness(
  nowMs: number,
  lastRunAtIso: string | null,
  staleAfterMs: number,
): { staleNow: boolean; staleForMs: number | null } {
  if (!lastRunAtIso) return { staleNow: true, staleForMs: null }
  const lastMs = toMs(lastRunAtIso)
  if (!Number.isFinite(lastMs)) return { staleNow: true, staleForMs: null }
  const delta = Math.max(0, nowMs - lastMs)
  return {
    staleNow: delta > staleAfterMs,
    staleForMs: delta,
  }
}

/**
 * Integra disponibilidade na janela com "trava" de lacunas:
 * o último estado só é carregado adiante por até `maxCarryForwardMs`.
 * O tempo além disso é tratado como `unknown` (fora do denominador de uptime).
 */
export function integrateAvailabilityWithGapGuard(
  params: IntegrateWithQualityParams,
): IntegratedAvailabilityWithQuality {
  const { windowStartMs, windowEndMs, seed, eventsInWindow, maxCarryForwardMs } = params
  const windowMs = Math.max(0, windowEndMs - windowStartMs)
  if (windowMs <= 0) {
    return {
      onlineMs: 0,
      unstableMs: 0,
      offlineMs: 0,
      unknownMs: 0,
      knownMs: 0,
      confidencePct: 0,
      largestGapMs: 0,
      maxCarryForwardMs,
    }
  }

  const sorted = [...eventsInWindow]
    .map((e) => ({ t: toMs(e.checked_at), status: e.status }))
    .filter((e) => Number.isFinite(e.t) && e.t < windowEndMs)
    .sort((a, b) => a.t - b.t)

  let state: PersistedStatus = seed ?? "online"
  let hasKnownState = seed != null
  // Sem timestamp do seed anterior, assumimos no máximo até o início da janela.
  let lastSignalMs = hasKnownState ? windowStartMs : Number.NaN
  let cursor = windowStartMs

  let onlineMs = 0
  let unstableMs = 0
  let offlineMs = 0
  let unknownMs = 0
  let largestGapMs = 0

  const addKnown = (from: number, to: number) => {
    const dt = Math.max(0, to - from)
    if (dt <= 0) return
    if (state === "online") onlineMs += dt
    else if (state === "unstable") unstableMs += dt
    else offlineMs += dt
  }

  const addUnknown = (from: number, to: number) => {
    const dt = Math.max(0, to - from)
    if (dt <= 0) return
    unknownMs += dt
  }

  const processSegment = (segmentEnd: number) => {
    const end = Math.max(cursor, segmentEnd)
    largestGapMs = Math.max(largestGapMs, end - cursor)
    if (!hasKnownState) {
      addUnknown(cursor, end)
      cursor = end
      return
    }
    const knownUntil = Math.min(end, lastSignalMs + maxCarryForwardMs)
    addKnown(cursor, knownUntil)
    addUnknown(knownUntil, end)
    cursor = end
  }

  for (const e of sorted) {
    if (e.t < windowStartMs) {
      state = e.status
      hasKnownState = true
      lastSignalMs = e.t
      continue
    }
    processSegment(e.t)
    state = e.status
    hasKnownState = true
    lastSignalMs = e.t
  }

  processSegment(windowEndMs)

  const knownMs = Math.max(0, windowMs - unknownMs)
  return {
    onlineMs,
    unstableMs,
    offlineMs,
    unknownMs,
    knownMs,
    confidencePct: safePct(knownMs, windowMs),
    largestGapMs,
    maxCarryForwardMs,
  }
}

export function computeDataQuality(
  params: IntegrateWithQualityParams,
): {
  maxCarryForwardMs: number
  unknownMs: number
  confidencePct: number
  largestGapMs: number
} {
  const integrated = integrateAvailabilityWithGapGuard(params)
  return {
    maxCarryForwardMs: integrated.maxCarryForwardMs,
    unknownMs: integrated.unknownMs,
    confidencePct: integrated.confidencePct,
    largestGapMs: integrated.largestGapMs,
  }
}
