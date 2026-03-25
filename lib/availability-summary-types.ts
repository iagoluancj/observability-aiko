export interface AvailabilityRecentSample {
  checkedAt: string
  status: "online" | "offline" | "unstable"
  responseTimeMs: number | null
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
}

export type AvailabilitySummaryResponse =
  | { configured: false }
  | {
      configured: true
      hours: number
      perSite: AvailabilitySummaryPerSite[]
      timeline: AvailabilitySummaryTimelinePoint[]
      totals: AvailabilitySummaryTotals
    }
