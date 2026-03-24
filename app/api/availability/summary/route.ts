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
  integrateAvailabilityWindow,
  uptimePctFromMs,
} from "@/lib/availability-time-weighted"

const RECENT_SAMPLES_PER_SITE = 12
const MAX_CHECKS_FETCH = 80000
const log = createLogger("api:availability-summary")

export const dynamic = "force-dynamic"

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
      }
    }

    const siteChecks = (checksBySiteId.get(site.id) ?? []).map((c) => ({
      checked_at: c.checked_at,
      status: c.status as PersistedStatus,
    }))

    const seed = seedBySiteId.get(site.id) ?? null
    const hasAnySignal = siteChecks.length > 0 || seed != null

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
      }
    }

    const { onlineMs } = integrateAvailabilityWindow(
      windowStartMs,
      windowEndMs,
      seed,
      siteChecks,
    )

    const uptimePct = uptimePctFromMs(onlineMs, windowMs)
    const availableMinutesApprox =
      uptimePct != null ? Math.round(onlineMs / 60000) : null

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
  }

  return { configured: true, hours, perSite, timeline, totals }
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
      },
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
  return NextResponse.json(summary)
}
