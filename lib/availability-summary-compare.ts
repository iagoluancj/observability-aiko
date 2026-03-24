import type { AvailabilitySummaryResponse } from "@/lib/availability-summary-types"

function serializeConfigured(
  a: Extract<AvailabilitySummaryResponse, { configured: true }>,
): string {
  const per = [...a.perSite]
    .sort((x, y) => x.externalId.localeCompare(y.externalId))
    .map(p => ({
      externalId: p.externalId,
      sampleCount: p.sampleCount,
      onlineSamples: p.onlineSamples,
      unstableSamples: p.unstableSamples,
      offlineSamples: p.offlineSamples,
      uptimePct: p.uptimePct,
      availableMinutesApprox: p.availableMinutesApprox,
      avgResponseMs: p.avgResponseMs,
      recentSamples: p.recentSamples.map(s => [s.checkedAt, s.status, s.responseTimeMs]),
    }))
  const tl = a.timeline.map(t => [t.bucket, t.avgMs, t.checks])
  return JSON.stringify({
    h: a.hours,
    per,
    tl,
    totals: a.totals,
  })
}

/** Evita re-render quando o JSON do painel não mudou de fato. */
export function availabilitySummaryStableEqual(
  a: AvailabilitySummaryResponse | null,
  b: AvailabilitySummaryResponse | null,
): boolean {
  if (a === b) return true
  if (!a || !b) return false
  if (a.configured !== b.configured) return false
  if (!a.configured && !b.configured) return true
  if (!a.configured || !b.configured) return false
  return serializeConfigured(a) === serializeConfigured(b)
}
