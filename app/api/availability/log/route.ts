import { NextRequest, NextResponse } from "next/server"
import { createLogger } from "@/lib/logger"
import { isMonitorSyncAuthorized } from "@/lib/monitor-api-auth"
import { getSupabaseAdmin } from "@/lib/supabase/admin"
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
    return NextResponse.json({ error: upsertError.message }, { status: 500 })
  }

  const externalIds = entries.map((e) => e.externalId)
  const { data: idRows, error: selectError } = await supabase
    .from("monitored_sites")
    .select("id, external_id")
    .in("external_id", externalIds)

  if (selectError || !idRows?.length) {
    log.error("Erro ao resolver site_id", { message: selectError?.message })
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
    return NextResponse.json({ ok: true, logged: 0, skipped })
  }

  const { error: insertError } = await supabase.from("availability_checks").insert(inserts)

  if (insertError) {
    log.error("Erro ao inserir availability_checks", { message: insertError.message })
    return NextResponse.json({ error: insertError.message }, { status: 500 })
  }

  log.debug("Disponibilidade (esparsa)", { logged: inserts.length, skipped })
  return NextResponse.json({ ok: true, logged: inserts.length, skipped })
}
