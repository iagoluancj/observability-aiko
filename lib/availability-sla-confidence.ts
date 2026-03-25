export interface ObservationCoverageResult {
  /** 0..100 (1 casa decimal) */
  confidencePct: number
  /** tempo dentro da janela que foi “observável/conhecido” para inferência */
  knownMs: number
  /** tempo dentro da janela que ficou parcialmente ou totalmente sem cobertura */
  unknownMs: number
  /** minutes */
  unknownMinutesApprox: number
}

export interface ObservationCoverageConfig {
  /**
   * Convenção de mercado (Prometheus/Grafana):
   * depois de um período sem coleta (“stale”), a confiança deve cair.
   * Default: 5min.
   */
  graceMs: number
  /**
   * Além do grace, a confiança degrada até zero (linear).
   * Default: 15min.
   */
  decayToZeroMs: number
}

const DEFAULTS: ObservationCoverageConfig = {
  graceMs: 5 * 60 * 1000,
  decayToZeroMs: 15 * 60 * 1000,
}

function parseMsEnv(key: string): number | null {
  const raw = process.env[key]
  if (raw == null || raw === "") return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.floor(n)
}

export function loadObservationCoverageConfigFromEnv(): ObservationCoverageConfig {
  const graceMs = parseMsEnv("AVAILABILITY_OBSERVATION_GRACE_MS") ?? DEFAULTS.graceMs
  const decayToZeroMs =
    parseMsEnv("AVAILABILITY_OBSERVATION_DECAY_TO_ZERO_MS") ?? DEFAULTS.decayToZeroMs

  // Segurança: garante ordem.
  return decayToZeroMs > graceMs ? { graceMs, decayToZeroMs } : { ...DEFAULTS }
}

function knownMsFromAgeRange(a0: number, a1: number, cfg: ObservationCoverageConfig): number {
  const start = Math.max(0, a0)
  const end = Math.max(start, a1)
  if (end <= cfg.graceMs) return end - start
  if (start >= cfg.decayToZeroMs) return 0

  const delta = cfg.decayToZeroMs - cfg.graceMs
  const cutEnd = Math.min(end, cfg.decayToZeroMs)

  let known = 0

  const grace = cfg.graceMs
  const linearStart = Math.max(start, grace)

  if (start < grace) {
    known += grace - start
  }

  // Integral do trecho linear: weight(age) = 1 - (age - grace)/delta
  // ∫(1) da = (cutEnd - linearStart)
  // ∫(age - grace) da = ((cutEnd-grace)^2 - (linearStart-grace)^2)/2
  const term = (Math.pow(cutEnd - grace, 2) - Math.pow(linearStart - grace, 2)) / (2 * delta)
  known += (cutEnd - linearStart) - term

  return Math.max(0, known)
}

/**
 * Calcula confiança do SLA baseada em “cobertura” da observação do job.
 * Cada run “ok” reseta a idade (age=0 no run_at) e a confiança degrada linearmente conforme a idade.
 */
export function computeObservationCoverageConfidence(params: {
  windowStartMs: number
  windowEndMs: number
  /**
   * Timestamps (ms) dos runs “ok”.
   * Se vazio, confiança será 0.
   */
  okRunAtMs: number[]
  cfg: ObservationCoverageConfig
}): ObservationCoverageResult {
  const { windowStartMs, windowEndMs, okRunAtMs, cfg } = params
  const windowMs = Math.max(0, windowEndMs - windowStartMs)
  if (windowMs <= 0) {
    return { confidencePct: 0, knownMs: 0, unknownMs: 0, unknownMinutesApprox: 0 }
  }

  const sorted = [...okRunAtMs].filter(t => Number.isFinite(t)).sort((a, b) => a - b)
  if (sorted.length === 0) {
    return {
      confidencePct: 0,
      knownMs: 0,
      unknownMs: windowMs,
      unknownMinutesApprox: Math.round(windowMs / 60000),
    }
  }

  // Último run <= windowStartMs para ancorar o segmento inicial.
  let lastBeforeIdx = -1
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i] <= windowStartMs) lastBeforeIdx = i
  }

  const withAnchor = lastBeforeIdx >= 0 ? sorted.slice(lastBeforeIdx) : sorted

  let knownMs = 0
  let prevRunAt = withAnchor[0]

  for (let i = 1; i <= withAnchor.length; i++) {
    const nextRunAt = i < withAnchor.length ? withAnchor[i] : windowEndMs
    const segStart = Math.max(windowStartMs, prevRunAt)
    const segEnd = Math.min(windowEndMs, nextRunAt)

    if (segEnd <= segStart) {
      if (i < withAnchor.length) prevRunAt = withAnchor[i]
      continue
    }

    const ageAtSegStart = segStart - prevRunAt
    const ageAtSegEnd = segEnd - prevRunAt
    knownMs += knownMsFromAgeRange(ageAtSegStart, ageAtSegEnd, cfg)

    if (i < withAnchor.length) prevRunAt = withAnchor[i]
  }

  const unknownMs = Math.max(0, windowMs - knownMs)
  const confidencePct = Math.round((knownMs / windowMs) * 1000) / 10
  const unknownMinutesApprox = Math.round(unknownMs / 60000)

  return { confidencePct, knownMs, unknownMs, unknownMinutesApprox }
}

