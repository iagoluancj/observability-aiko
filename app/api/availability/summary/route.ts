import { NextRequest, NextResponse } from "next/server"
import { createLogger } from "@/lib/logger"
import type {
  AvailabilityRecentSample,
  AvailabilitySummaryPerSite,
  AvailabilitySummaryResponse,
  AvailabilitySummaryTimelinePoint,
  AvailabilitySummaryTotals,
} from "@/lib/availability-summary-types"
import { getSupabaseAdmin } from "@/lib/supabase/admin"
import { clampAvailabilityHours } from "@/lib/availability-window-presets"
import type { PersistedStatus } from "@/lib/availability-log-policy"
import {
  uptimePctFromMs,
} from "@/lib/availability-time-weighted"
import {
  buildCoverageFromCollectionRuns,
  computeFreshness,
  integrateAvailabilityWithGapGuard,
  readExpectedCollectionIntervalMsFromEnv,
  readMaxCarryForwardMsFromEnv,
  readStaleAfterMsFromEnv,
} from "@/lib/availability-data-quality"

const RECENT_SAMPLES_PER_SITE = 12
const MAX_CHECKS_FETCH = 80000
const log = createLogger("api:availability-summary")

export const dynamic = "force-dynamic"

async function fetchCollectionRunsInWindow(
  sinceIso: string,
): Promise<string[]> {
  const supabase = getSupabaseAdmin()
  if (!supabase) return []

  const { data, error } = await supabase
    .from("availability_collection_runs")
    .select("run_at")
    .eq("status", "ok")
    .gte("run_at", sinceIso)
    .order("run_at", { ascending: true })
    .limit(MAX_CHECKS_FETCH)

  if (error) {
    log.warn("Erro ao listar availability_collection_runs na janela", { message: error.message })
    return []
  }

  return (data ?? [])
    .map((r) => (typeof r.run_at === "string" ? r.run_at : null))
    .filter((v): v is string => v != null)
}

async function fetchLastCollectionRunAt(): Promise<string | null> {
  const supabase = getSupabaseAdmin()
  if (!supabase) return null

  const { data, error } = await supabase
    .from("availability_collection_runs")
    .select("run_at")
    .eq("status", "ok")
    .order("run_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    log.warn("Erro ao buscar último run de coleta", { message: error.message })
    return null
  }

  return data?.run_at ?? null
}

async function fetchSeedStatusBefore(
  siteIds: string[],
  beforeIso: string,
): Promise<Map<string, PersistedStatus | null>> {
  const map = new Map<string, PersistedStatus | null>()
  const supabase = getSupabaseAdmin()
  if (!supabase || siteIds.length === 0) return map

  const { data, error } = await supabase.rpc("latest_availability_before", {
    p_site_ids: siteIds,
    p_before: beforeIso,
  })

  if (!error && data && Array.isArray(data)) {
    for (const row of data as Array<{ site_id: string; status: string }>) {
      map.set(row.site_id, row.status as PersistedStatus)
    }
    return map
  }

  log.warn("RPC latest_availability_before falhou; fallback por site", { message: error?.message })

  await Promise.all(
    siteIds.map(async (id) => {
      const { data: one } = await supabase
        .from("availability_checks")
        .select("status")
        .eq("site_id", id)
        .lt("checked_at", beforeIso)
        .order("checked_at", { ascending: false })
        .limit(1)
        .maybeSingle()

      map.set(id, one ? (one.status as PersistedStatus) : null)
    }),
  )

  return map
}

function formatBucketLabel(isoHourPrefix: string): string {
  // isoHourPrefix: "2025-03-23T14"
  try {
    const d = new Date(`${isoHourPrefix}:00:00.000Z`)
    return d.toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "America/Sao_Paulo",
    })
  } catch {
    return isoHourPrefix
  }
}

function buildSummary(
  hours: number,
  siteRows: Array<{ id: string; external_id: string; name: string }>,
  checks: Array<{
    checked_at: string
    status: string
    response_time_ms: number | null
    site_id: string
  }>,
  externalIdOrder: string[],
  seedBySiteId: Map<string, PersistedStatus | null>,
  windowStartMs: number,
  windowEndMs: number,
): Extract<AvailabilitySummaryResponse, { configured: true }> {
  const metaBySiteId = new Map(siteRows.map(s => [s.id, s]))
  const windowMs = windowEndMs - windowStartMs
  const maxCarryForwardMs = readMaxCarryForwardMsFromEnv()

  const checksBySiteId = new Map<string, typeof checks>()
  for (const r of checks) {
    if (!metaBySiteId.has(r.site_id)) continue
    const list = checksBySiteId.get(r.site_id) ?? []
    list.push(r)
    checksBySiteId.set(r.site_id, list)
  }

  const recentBySiteId = new Map<string, AvailabilityRecentSample[]>()
  for (const [siteId, arr] of checksBySiteId) {
    const sorted = [...arr].sort(
      (x, y) => new Date(y.checked_at).getTime() - new Date(x.checked_at).getTime(),
    )
    recentBySiteId.set(
      siteId,
      sorted.slice(0, RECENT_SAMPLES_PER_SITE).map((r) => ({
        checkedAt: r.checked_at,
        status: r.status as AvailabilityRecentSample["status"],
        responseTimeMs: r.response_time_ms,
      })),
    )
  }

  const bucketMap = new Map<string, { sumRt: number; rtCount: number; allCount: number }>()
  for (const r of checks) {
    if (!metaBySiteId.has(r.site_id)) continue
    const d = new Date(r.checked_at)
    const bucketKey = d.toISOString().slice(0, 13)
    const b = bucketMap.get(bucketKey) ?? { sumRt: 0, rtCount: 0, allCount: 0 }
    b.allCount += 1
    if (r.response_time_ms != null && Number.isFinite(r.response_time_ms)) {
      b.sumRt += r.response_time_ms
      b.rtCount += 1
    }
    bucketMap.set(bucketKey, b)
  }

  const sortedBuckets = [...bucketMap.entries()].sort(([a], [b]) => a.localeCompare(b))
  const timeline: AvailabilitySummaryTimelinePoint[] = sortedBuckets.map(([bucket, v]) => ({
    bucket: `${bucket}:00:00.000Z`,
    label: formatBucketLabel(bucket),
    avgMs: v.rtCount > 0 ? Math.round(v.sumRt / v.rtCount) : 0,
    checks: v.allCount,
  }))

  let sumRtAll = 0
  let rtNAll = 0
  let totalPersistRows = 0
  let sumUptimePct = 0
  let sitesWithUptime = 0
  let totOnlineRows = 0
  let totUnstableRows = 0
  let totOfflineRows = 0
  let sumConfidencePct = 0
  let sitesWithConfidence = 0
  let unknownMsTotal = 0

  const perSite: AvailabilitySummaryPerSite[] = externalIdOrder.map(ext => {
    const site = siteRows.find(s => s.external_id === ext)
    if (!site) {
      return {
        externalId: ext,
        name: ext,
        sampleCount: 0,
        onlineSamples: 0,
        unstableSamples: 0,
        offlineSamples: 0,
        uptimePct: null,
        availableMinutesApprox: null,
        avgResponseMs: null,
        recentSamples: [],
        quality: {
          maxCarryForwardMs,
          unknownMs: windowMs,
          confidencePct: 0,
          largestGapMs: windowMs,
        },
      }
    }

    const siteChecks = (checksBySiteId.get(site.id) ?? []).map((c) => ({
      checked_at: c.checked_at,
      status: c.status as PersistedStatus,
    }))

    const seed = seedBySiteId.get(site.id) ?? null
    const hasAnySignal = siteChecks.length > 0 || seed != null
    const integrated = integrateAvailabilityWithGapGuard({
      windowStartMs,
      windowEndMs,
      maxCarryForwardMs,
      seed,
      eventsInWindow: siteChecks,
    })
    const quality = {
      maxCarryForwardMs: integrated.maxCarryForwardMs,
      unknownMs: integrated.unknownMs,
      confidencePct: integrated.confidencePct,
      largestGapMs: integrated.largestGapMs,
    }

    if (!hasAnySignal) {
      return {
        externalId: ext,
        name: site.name,
        sampleCount: 0,
        onlineSamples: 0,
        unstableSamples: 0,
        offlineSamples: 0,
        uptimePct: null,
        availableMinutesApprox: null,
        avgResponseMs: null,
        recentSamples: [],
        quality,
      }
    }

    const { onlineMs, knownMs } = integrated

    const uptimePct = uptimePctFromMs(onlineMs, knownMs)
    const availableMinutesApprox =
      knownMs > 0 ? Math.round(onlineMs / 60000) : null

    let onC = 0
    let unC = 0
    let ofC = 0
    let sumRt = 0
    let rtN = 0
    for (const c of checksBySiteId.get(site.id) ?? []) {
      if (c.status === "online") onC++
      else if (c.status === "unstable") unC++
      else ofC++
      if (c.response_time_ms != null && Number.isFinite(c.response_time_ms)) {
        sumRt += c.response_time_ms
        rtN++
        sumRtAll += c.response_time_ms
        rtNAll++
      }
    }

    const sampleCount = onC + unC + ofC
    totalPersistRows += sampleCount
    totOnlineRows += onC
    totUnstableRows += unC
    totOfflineRows += ofC

    if (uptimePct != null) {
      sumUptimePct += uptimePct
      sitesWithUptime += 1
    }
    sumConfidencePct += quality.confidencePct
    sitesWithConfidence += 1
    unknownMsTotal += quality.unknownMs

    return {
      externalId: ext,
      name: site.name,
      sampleCount,
      onlineSamples: onC,
      unstableSamples: unC,
      offlineSamples: ofC,
      uptimePct,
      availableMinutesApprox,
      avgResponseMs: rtN > 0 ? Math.round(sumRt / rtN) : null,
      recentSamples: recentBySiteId.get(site.id) ?? [],
      quality,
    }
  })

  const totals: AvailabilitySummaryTotals = {
    sampleCount: totalPersistRows,
    onlineSamples: totOnlineRows,
    unstableSamples: totUnstableRows,
    offlineSamples: totOfflineRows,
    uptimePct:
      sitesWithUptime > 0 ? Math.round((sumUptimePct / sitesWithUptime) * 10) / 10 : null,
    availableMinutesApprox:
      sitesWithUptime > 0 && windowMs > 0
        ? Math.round(((sumUptimePct / sitesWithUptime) / 100) * (windowMs / 60000))
        : null,
    avgResponseMs: rtNAll > 0 ? Math.round(sumRtAll / rtNAll) : null,
    confidencePct:
      sitesWithConfidence > 0
        ? Math.round((sumConfidencePct / sitesWithConfidence) * 10) / 10
        : null,
    unknownMsTotal,
  }

  return { configured: true, hours, perSite, timeline, totals, collection: null }
}

export async function GET(request: NextRequest) {
  const supabase = getSupabaseAdmin()
  if (!supabase) {
    return NextResponse.json({ configured: false } satisfies AvailabilitySummaryResponse)
  }

  const { searchParams } = new URL(request.url)
  const hoursRaw = Number(searchParams.get("hours") ?? "24")
  const hours = clampAvailabilityHours(hoursRaw)
  const idsParam = searchParams.get("ids")
  const externalIds = idsParam
    ? idsParam.split(",").map(s => s.trim()).filter(Boolean)
    : []

  if (externalIds.length === 0) {
    const empty: Extract<AvailabilitySummaryResponse, { configured: true }> = {
      configured: true,
      hours,
      perSite: [],
      timeline: [],
      totals: {
        sampleCount: 0,
        onlineSamples: 0,
        unstableSamples: 0,
        offlineSamples: 0,
        uptimePct: null,
        availableMinutesApprox: null,
        avgResponseMs: null,
        confidencePct: null,
        unknownMsTotal: 0,
      },
      collection: null,
    }
    return NextResponse.json(empty)
  }

  const windowEndMs = Date.now()
  const windowStartMs = windowEndMs - hours * 3600 * 1000
  const since = new Date(windowStartMs).toISOString()

  const { data: siteRows, error: siteErr } = await supabase
    .from("monitored_sites")
    .select("id, external_id, name")
    .in("external_id", externalIds)

  if (siteErr) {
    log.error("Erro ao listar monitored_sites", { message: siteErr.message })
    return NextResponse.json({ error: siteErr.message }, { status: 500 })
  }

  const sites = siteRows ?? []
  const siteIds = sites.map(s => s.id)

  if (siteIds.length === 0) {
    const summary = buildSummary(
      hours,
      [],
      [],
      externalIds,
      new Map(),
      windowStartMs,
      windowEndMs,
    )
    return NextResponse.json(summary)
  }

  const seedBySiteId = await fetchSeedStatusBefore(siteIds, since)

  const { data: checkRows, error: checkErr } = await supabase
    .from("availability_checks")
    .select("checked_at, status, response_time_ms, site_id")
    .in("site_id", siteIds)
    .gte("checked_at", since)
    .order("checked_at", { ascending: true })
    .limit(MAX_CHECKS_FETCH)

  if (checkErr) {
    log.error("Erro ao listar availability_checks", { message: checkErr.message })
    return NextResponse.json({ error: checkErr.message }, { status: 500 })
  }

  const checks = (checkRows ?? []) as Array<{
    checked_at: string
    status: string
    response_time_ms: number | null
    site_id: string
  }>

  const summary = buildSummary(
    hours,
    sites,
    checks,
    externalIds,
    seedBySiteId,
    windowStartMs,
    windowEndMs,
  )
  const expectedIntervalMs = readExpectedCollectionIntervalMsFromEnv()
  const fallbackMaxCarryForwardMs = readMaxCarryForwardMsFromEnv()
  const staleAfterMs = readStaleAfterMsFromEnv()
  const runAts = await fetchCollectionRunsInWindow(since)
  const coverage = buildCoverageFromCollectionRuns(
    windowStartMs,
    windowEndMs,
    runAts,
    summary.perSite[0]?.quality.maxCarryForwardMs ?? fallbackMaxCarryForwardMs,
  )
  const windowMs = Math.max(0, windowEndMs - windowStartMs)
  const coveragePct =
    windowMs > 0 ? Math.max(0, Math.min(100, Math.round(((windowMs - coverage.uncoveredMs) / windowMs) * 1000) / 10)) : 0
  const lastRunAt = await fetchLastCollectionRunAt()
  const freshness = computeFreshness(windowEndMs, lastRunAt, staleAfterMs)
  const largestSiteGapMs = summary.perSite.reduce(
    (max, site) => Math.max(max, site.quality.largestGapMs),
    0,
  )
  summary.collection = {
    expectedIntervalMs,
    maxCarryForwardMs: summary.perSite[0]?.quality.maxCarryForwardMs ?? fallbackMaxCarryForwardMs,
    staleAfterMs,
    coverageWindowHours: hours,
    coveragePct,
    gapCount: coverage.gapCount,
    largestGapMs: Math.max(coverage.largestGapMs, largestSiteGapMs),
    lastRunAt,
    staleNow: freshness.staleNow,
    staleForMs: freshness.staleForMs,
  }
  return NextResponse.json(summary)
}
