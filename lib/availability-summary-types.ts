export interface AvailabilityRecentSample {
  checkedAt: string
  status: "online" | "offline" | "unstable"
  responseTimeMs: number | null
}

export interface AvailabilityDataQuality {
  /**
   * Janela máxima (em ms) em que um estado pode ser carregado adiante sem nova checagem.
   * Após isso, o período entra como "unknown" (sem confiança).
   */
  maxCarryForwardMs: number
  /** Quantidade de milissegundos na janela coberta por estado unknown (sem confiança). */
  unknownMs: number
  /** Percentual da janela coberta por dados confiáveis (0..100). */
  confidencePct: number
  /**
   * Maior lacuna entre sinais (ms) no período integrado, considerando bordas da janela.
   * Útil para alerta operacional.
   */
  largestGapMs: number
}

export interface AvailabilityCollectionHealth {
  expectedIntervalMs: number
  maxCarryForwardMs: number
  staleAfterMs: number
  coverageWindowHours: number
  coveragePct: number
  gapCount: number
  largestGapMs: number
  lastRunAt: string | null
  staleNow: boolean
  staleForMs: number | null
}

export interface AvailabilitySummaryPerSite {
  externalId: string
  name: string
  sampleCount: number
  onlineSamples: number
  unstableSamples: number
  offlineSamples: number
  /** Proporção de amostras `online` no período; null se não houver amostras */
  uptimePct: number | null
  /**
   * Tempo estimado “como online” na janela: (amostras online / total amostras) × horas × 60.
   * Depende do intervalo entre checagens; não é medição contínua real.
   */
  availableMinutesApprox: number | null
  avgResponseMs: number | null
  /** Últimas checagens gravadas (mais recente primeiro), máx. 12 */
  recentSamples: AvailabilityRecentSample[]
  quality: AvailabilityDataQuality
}

export interface AvailabilitySummaryTimelinePoint {
  /** ISO start of hour UTC */
  bucket: string
  /** Rótulo curto para o eixo X */
  label: string
  avgMs: number
  checks: number
}

export interface AvailabilitySummaryTotals {
  sampleCount: number
  onlineSamples: number
  unstableSamples: number
  offlineSamples: number
  uptimePct: number | null
  /** Mesma lógica que por site, sobre todas as amostras da janela */
  availableMinutesApprox: number | null
  avgResponseMs: number | null
  /** Média simples da confiança por site (apenas sites com sinal na janela). */
  confidencePct: number | null
  /** Soma de `unknownMs` em todos os sites com sinal. */
  unknownMsTotal: number
}

export type AvailabilitySummaryResponse =
  | { configured: false }
  | {
      configured: true
      hours: number
      perSite: AvailabilitySummaryPerSite[]
      timeline: AvailabilitySummaryTimelinePoint[]
      totals: AvailabilitySummaryTotals
      collection: AvailabilityCollectionHealth | null
    }
