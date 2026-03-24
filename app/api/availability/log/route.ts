import { NextRequest, NextResponse } from "next/server"
import { createLogger } from "@/lib/logger"
import { isMonitorSyncAuthorized } from "@/lib/monitor-api-auth"
import { recordAvailabilityCollectionRun } from "@/lib/availability-collection-run"
import { getSupabaseAdmin } from "@/lib/supabase/admin"
import { buildSiteIdentityKey } from "@/lib/site-identity"
import {
  parseAvailabilityLogPolicyFromEnv,
  shouldPersistAvailabilityRow,
  type IncomingAvailabilityCheck,
  type PersistedStatus,
  type PreviousAvailabilityRow,
} from "@/lib/availability-log-policy"
import { z } from "zod"

const log = createLogger("api:availability-log")

const bodySchema = z.object({
  entries: z.array(
    z.object({
      externalId: z.string().min(1),
      name: z.string().min(1),
      url: z.string().min(1),
      category: z.enum(["Operacional", "Cliente", "Interno"]),
      check: z.object({
        status: z.enum(["online", "offline", "unstable", "checking", "unknown"]),
        httpCode: z.number().nullable(),
        responseTime: z.number().nullable(),
        timestamp: z.string(),
      }),
    }),
  ),
})

type AvailabilityLogEntry = z.infer<typeof bodySchema>["entries"][number]

interface ExistingSiteRow {
  id: string
  external_id: string
  name: string
  url: string
  updated_at: string
}

interface ReconciledSitesResult {
  byExternalId: Map<string, ExistingSiteRow>
  byIdentity: Map<string, ExistingSiteRow>
}

function statusForRow(
  s: z.infer<typeof bodySchema>["entries"][number]["check"]["status"],
): PersistedStatus {
  if (s === "online" || s === "offline" || s === "unstable") return s
  if (s === "unknown") return "offline"
  return "unstable"
}

async function fetchLatestAvailabilityBySite(
  siteIds: string[],
): Promise<Map<string, PreviousAvailabilityRow>> {
  const map = new Map<string, PreviousAvailabilityRow>()
  const supabase = getSupabaseAdmin()
  if (!supabase || siteIds.length === 0) return map

  const { data, error } = await supabase.rpc("latest_availability_per_site", {
    p_site_ids: siteIds,
  })

  if (!error && data && Array.isArray(data)) {
    for (const row of data as Array<{
      site_id: string
      checked_at: string
      status: string
      response_time_ms: number | null
    }>) {
      map.set(row.site_id, {
        status: row.status as PersistedStatus,
        checkedAt: row.checked_at,
        responseTimeMs: row.response_time_ms,
      })
    }
    return map
  }

  log.warn("RPC latest_availability_per_site indisponível ou erro; fallback por site", {
    message: error?.message,
  })

  await Promise.all(
    siteIds.map(async (id) => {
      const { data: one } = await supabase
        .from("availability_checks")
        .select("checked_at, status, response_time_ms")
        .eq("site_id", id)
        .order("checked_at", { ascending: false })
        .limit(1)
        .maybeSingle()

      if (one) {
        map.set(id, {
          status: one.status as PersistedStatus,
          checkedAt: one.checked_at,
          responseTimeMs: one.response_time_ms,
        })
      }
    }),
  )

  return map
}

function isStableExternalId(externalId: string): boolean {
  return /^site-[a-z0-9-]+-[a-z0-9]+$/.test(externalId)
}

function parseUpdatedAtMs(iso: string): number {
  const t = new Date(iso).getTime()
  return Number.isFinite(t) ? t : 0
}

function pickPreferredExistingSite(a: ExistingSiteRow, b: ExistingSiteRow): ExistingSiteRow {
  const aStable = isStableExternalId(a.external_id)
  const bStable = isStableExternalId(b.external_id)
  if (aStable !== bStable) return aStable ? a : b
  return parseUpdatedAtMs(a.updated_at) >= parseUpdatedAtMs(b.updated_at) ? a : b
}

async function fetchExistingSitesForEntries(
  entries: AvailabilityLogEntry[],
): Promise<Map<string, ExistingSiteRow>> {
  const supabase = getSupabaseAdmin()
  const byId = new Map<string, ExistingSiteRow>()
  if (!supabase || entries.length === 0) return byId

  const externalIds = [...new Set(entries.map((e) => e.externalId))]
  const urls = [...new Set(entries.map((e) => e.url))]

  const [byExternalRes, byUrlRes] = await Promise.all([
    supabase
      .from("monitored_sites")
      .select("id, external_id, name, url, updated_at")
      .in("external_id", externalIds),
    supabase
      .from("monitored_sites")
      .select("id, external_id, name, url, updated_at")
      .in("url", urls),
  ])

  if (byExternalRes.error) {
    log.warn("Erro ao buscar monitored_sites por external_id", { message: byExternalRes.error.message })
  }
  if (byUrlRes.error) {
    log.warn("Erro ao buscar monitored_sites por url", { message: byUrlRes.error.message })
  }

  for (const row of [...(byExternalRes.data ?? []), ...(byUrlRes.data ?? [])] as ExistingSiteRow[]) {
    byId.set(row.id, row)
  }
  return byId
}

function buildSiteIndexes(rows: Iterable<ExistingSiteRow>): ReconciledSitesResult {
  const byExternalId = new Map<string, ExistingSiteRow>()
  const byIdentity = new Map<string, ExistingSiteRow>()

  for (const row of rows) {
    byExternalId.set(row.external_id, row)
    const key = buildSiteIdentityKey({ name: row.name, url: row.url })
    const prev = byIdentity.get(key)
    if (!prev) {
      byIdentity.set(key, row)
      continue
    }
    byIdentity.set(key, pickPreferredExistingSite(prev, row))
  }

  return { byExternalId, byIdentity }
}

function pickCanonicalSite(rows: ExistingSiteRow[]): ExistingSiteRow {
  return rows.reduce((best, row) => pickPreferredExistingSite(best, row))
}

async function mergeDuplicateSiteRowsByIdentity(
  rows: ExistingSiteRow[],
): Promise<Map<string, ExistingSiteRow>> {
  const supabase = getSupabaseAdmin()
  const byId = new Map<string, ExistingSiteRow>(rows.map((r) => [r.id, r]))
  if (!supabase || rows.length <= 1) return byId

  const groups = new Map<string, ExistingSiteRow[]>()
  for (const row of rows) {
    const key = buildSiteIdentityKey({ name: row.name, url: row.url })
    const arr = groups.get(key) ?? []
    arr.push(row)
    groups.set(key, arr)
  }

  for (const arr of groups.values()) {
    if (arr.length <= 1) continue
    const canonical = pickCanonicalSite(arr)

    for (const row of arr) {
      if (row.id === canonical.id) continue

      const { error: moveChecksError } = await supabase
        .from("availability_checks")
        .update({ site_id: canonical.id })
        .eq("site_id", row.id)

      if (moveChecksError) {
        log.warn("Falha ao mover checks para site canônico", {
          fromSiteId: row.id,
          toSiteId: canonical.id,
          message: moveChecksError.message,
        })
        continue
      }

      const { error: deleteError } = await supabase
        .from("monitored_sites")
        .delete()
        .eq("id", row.id)

      if (deleteError) {
        log.warn("Falha ao remover site duplicado", {
          siteId: row.id,
          message: deleteError.message,
        })
        continue
      }

      byId.delete(row.id)
    }
  }

  return byId
}

async function reconcileLegacyExternalIds(
  entries: AvailabilityLogEntry[],
  nowIso: string,
): Promise<ReconciledSitesResult> {
  const supabase = getSupabaseAdmin()
  if (!supabase || entries.length === 0) return { byExternalId: new Map(), byIdentity: new Map() }

  const existing = await fetchExistingSitesForEntries(entries)
  if (existing.size === 0) return { byExternalId: new Map(), byIdentity: new Map() }
  const mergedById = await mergeDuplicateSiteRowsByIdentity([...existing.values()])
  let { byExternalId, byIdentity } = buildSiteIndexes(mergedById.values())

  const updates: Array<{
    id: string
    external_id: string
    name: string
    url: string
    category: AvailabilityLogEntry["category"]
    updated_at: string
  }> = []

  for (const e of entries) {
    if (byExternalId.has(e.externalId)) continue
    const key = buildSiteIdentityKey({ name: e.name, url: e.url })
    const legacy = byIdentity.get(key)
    if (!legacy) continue
    updates.push({
      id: legacy.id,
      external_id: e.externalId,
      name: e.name,
      url: e.url,
      category: e.category,
      updated_at: nowIso,
    })
    byExternalId.set(e.externalId, {
      ...legacy,
      external_id: e.externalId,
      name: e.name,
      url: e.url,
      updated_at: nowIso,
    })
  }

  if (updates.length === 0) return { byExternalId, byIdentity }

  await Promise.all(
    updates.map(async (u) => {
      const { error } = await supabase
        .from("monitored_sites")
        .update({
          external_id: u.external_id,
          name: u.name,
          url: u.url,
          category: u.category,
          updated_at: u.updated_at,
        })
        .eq("id", u.id)

      if (error) {
        log.warn("Falha ao reconciliar external_id legado", {
          siteId: u.id,
          externalId: u.external_id,
          message: error.message,
        })
      }
    }),
  )

  ;({ byExternalId, byIdentity } = buildSiteIndexes([
    ...mergedById.values(),
    ...updates.map((u) => ({
      id: u.id,
      external_id: u.external_id,
      name: u.name,
      url: u.url,
      updated_at: u.updated_at,
    })),
  ]))

  return { byExternalId, byIdentity }
}

export async function POST(request: NextRequest) {
  if (!isMonitorSyncAuthorized(request)) {
    return NextResponse.json({ error: "Não autorizado" }, { status: 401 })
  }

  const supabase = getSupabaseAdmin()
  if (!supabase) {
    return NextResponse.json(
      { error: "Supabase não configurado (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)" },
      { status: 503 },
    )
  }

  let json: unknown
  try {
    json = await request.json()
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 })
  }

  const parsed = bodySchema.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json({ error: "Payload inválido", details: parsed.error.flatten() }, { status: 400 })
  }

  const entries = parsed.data.entries
  if (entries.length === 0) {
    return NextResponse.json({ ok: true, logged: 0, skipped: 0 })
  }

  const now = new Date().toISOString()
  await reconcileLegacyExternalIds(entries, now)

  const siteRows = entries.map((e) => ({
    external_id: e.externalId,
    name: e.name,
    url: e.url,
    category: e.category,
    updated_at: now,
  }))

  const { error: upsertError } = await supabase.from("monitored_sites").upsert(siteRows, {
    onConflict: "external_id",
  })

  if (upsertError) {
    log.error("Erro ao upsert monitored_sites", { message: upsertError.message })
    await recordAvailabilityCollectionRun({
      source: "dashboard",
      status: "error",
      checkedCount: 0,
      errorMessage: upsertError.message,
    })
    return NextResponse.json({ error: upsertError.message }, { status: 500 })
  }

  const externalIds = entries.map((e) => e.externalId)
  const { data: idRows, error: selectError } = await supabase
    .from("monitored_sites")
    .select("id, external_id")
    .in("external_id", externalIds)

  if (selectError || !idRows?.length) {
    log.error("Erro ao resolver site_id", { message: selectError?.message })
    await recordAvailabilityCollectionRun({
      source: "dashboard",
      status: "error",
      checkedCount: 0,
      errorMessage: selectError?.message ?? "Sites não encontrados após upsert",
    })
    return NextResponse.json({ error: selectError?.message ?? "Sites não encontrados após upsert" }, { status: 500 })
  }

  const idByExternal = new Map(idRows.map((r) => [r.external_id, r.id]))
  const siteIds = [...new Set([...idByExternal.values()])]

  const latestBySite = await fetchLatestAvailabilityBySite(siteIds)
  const policy = parseAvailabilityLogPolicyFromEnv()

  const inserts: Array<{
    site_id: string
    checked_at: string
    status: PersistedStatus
    http_code: number | null
    response_time_ms: number | null
  }> = []

  let skipped = 0

  for (const e of entries) {
    const siteId = idByExternal.get(e.externalId)
    if (!siteId) continue

    const st = statusForRow(e.check.status)
    const next: IncomingAvailabilityCheck = {
      status: st,
      responseTimeMs: e.check.responseTime,
      checkedAt: e.check.timestamp,
    }

    const prev = latestBySite.get(siteId) ?? null
    if (!shouldPersistAvailabilityRow(prev, next, policy)) {
      skipped += 1
      continue
    }

    inserts.push({
      site_id: siteId,
      checked_at: e.check.timestamp,
      status: st,
      http_code: e.check.httpCode,
      response_time_ms: e.check.responseTime,
    })

    latestBySite.set(siteId, {
      status: st,
      checkedAt: e.check.timestamp,
      responseTimeMs: e.check.responseTime,
    })
  }

  if (inserts.length === 0) {
    await recordAvailabilityCollectionRun({
      source: "dashboard",
      status: "ok",
      checkedCount: 0,
    })
    return NextResponse.json({ ok: true, logged: 0, skipped })
  }

  const { error: insertError } = await supabase.from("availability_checks").insert(inserts)

  if (insertError) {
    log.error("Erro ao inserir availability_checks", { message: insertError.message })
    await recordAvailabilityCollectionRun({
      source: "dashboard",
      status: "error",
      checkedCount: 0,
      errorMessage: insertError.message,
    })
    return NextResponse.json({ error: insertError.message }, { status: 500 })
  }

  await recordAvailabilityCollectionRun({
    source: "dashboard",
    status: "ok",
    checkedCount: inserts.length,
  })
  log.debug("Disponibilidade (esparsa)", { logged: inserts.length, skipped })
  return NextResponse.json({ ok: true, logged: inserts.length, skipped })
}
