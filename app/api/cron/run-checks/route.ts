import { NextRequest, NextResponse } from "next/server"
import { checkUrl } from "@/lib/check-url"
import { deriveSiteCheckFromUrlResult } from "@/lib/derive-site-check"
import { createLogger } from "@/lib/logger"
import { getSupabaseAdmin } from "@/lib/supabase/admin"
import {
  parseAvailabilityLogPolicyFromEnv,
  shouldPersistAvailabilityRow,
  type IncomingAvailabilityCheck,
  type PersistedStatus,
  type PreviousAvailabilityRow,
} from "@/lib/availability-log-policy"

const log = createLogger("api:cron-run-checks")

/**
 * Opcional: agendador externo (Vercel Cron, etc.) com `Authorization: Bearer ${CRON_SECRET}`.
 * O fluxo principal hoje grava via `POST /api/availability/log` quando o dashboard está aberto.
 */
export const dynamic = "force-dynamic"
export const maxDuration = 300

const BATCH = 8

async function fetchLatestAvailabilityBySite(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  siteIds: string[],
): Promise<Map<string, PreviousAvailabilityRow>> {
  const map = new Map<string, PreviousAvailabilityRow>()
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

  log.warn("RPC latest_availability_per_site indisponível; fallback por site", {
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

      if (!one) return

      map.set(id, {
        status: one.status as PersistedStatus,
        checkedAt: one.checked_at,
        responseTimeMs: one.response_time_ms,
      })
    }),
  )

  return map
}

function isCronAuthorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    log.warn("CRON_SECRET não definido; recusando execução")
    return false
  }
  const auth = request.headers.get("authorization")
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null
  return token === secret
}

async function runInBatches<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += size) {
    const slice = items.slice(i, i + size)
    await Promise.all(slice.map(fn))
  }
}

export async function GET(request: NextRequest) {
  if (!isCronAuthorized(request)) {
    return NextResponse.json({ error: "Não autorizado" }, { status: 401 })
  }

  const supabase = getSupabaseAdmin()
  if (!supabase) {
    return NextResponse.json(
      { error: "Supabase não configurado" },
      { status: 503 },
    )
  }

  const { data: sites, error: listError } = await supabase
    .from("monitored_sites")
    .select("id, url")

  if (listError) {
    log.error("Erro ao listar sites", { message: listError.message })
    return NextResponse.json({ error: listError.message }, { status: 500 })
  }

  if (!sites?.length) {
    return NextResponse.json({ ok: true, checked: 0, message: "Nenhum site cadastrado" })
  }

  const runAt = new Date().toISOString()

  const computedChecks: Array<{
    site_id: string
    checked_at: string
    status: string
    http_code: number | null
    response_time_ms: number | null
  }> = []

  await runInBatches(sites, BATCH, async (row) => {
    const t0 = Date.now()
    const result = await checkUrl(row.url)
    const check = deriveSiteCheckFromUrlResult(result, Date.now() - t0)
    computedChecks.push({
      site_id: row.id,
      checked_at: check.timestamp,
      status: check.status,
      http_code: check.httpCode,
      response_time_ms: check.responseTime,
    })
  })

  const policy = parseAvailabilityLogPolicyFromEnv()
  const siteIds = sites.map(s => s.id)
  const latestBySite = await fetchLatestAvailabilityBySite(supabase, siteIds)

  const persisted: Array<{
    site_id: string
    checked_at: string
    status: PersistedStatus
    http_code: number | null
    response_time_ms: number | null
  }> = []

  let checked_count = 0
  let skipped = 0

  for (const c of computedChecks) {
    const st = c.status as PersistedStatus
    const next: IncomingAvailabilityCheck = {
      status: st,
      responseTimeMs: c.response_time_ms,
      checkedAt: c.checked_at,
    }

    const prev = latestBySite.get(c.site_id) ?? null
    if (!shouldPersistAvailabilityRow(prev, next, policy)) {
      skipped += 1
      continue
    }

    persisted.push({
      site_id: c.site_id,
      checked_at: c.checked_at,
      status: st,
      http_code: c.http_code,
      response_time_ms: c.response_time_ms,
    })

    checked_count += 1
    latestBySite.set(c.site_id, {
      status: st,
      checkedAt: c.checked_at,
      responseTimeMs: c.response_time_ms,
    })
  }

  let insertError: { message: string } | null = null
  if (persisted.length > 0) {
    const r = await supabase.from("availability_checks").insert(persisted)
    insertError = r.error
  }

  if (insertError) {
    log.error("Erro ao inserir availability_checks", { message: insertError.message })
    // Registra o run como erro para o cálculo de confiança.
    try {
      await supabase.from("availability_collection_runs").insert({
        run_at: runAt,
        source: "cron",
        status: "error",
        checked_count,
        error_message: insertError.message,
      })
    } catch {
      // ignore
    }
    return NextResponse.json({ error: insertError.message }, { status: 500 })
  }

  // Registra a execução do job para cálculo de cobertura/confiança do SLA.
  try {
    await supabase.from("availability_collection_runs").insert({
      run_at: runAt,
      source: "cron",
      status: "ok",
      checked_count,
      error_message: null,
    })
  } catch (e) {
    log.warn("Falha ao registrar availability_collection_runs", {
      message: e instanceof Error ? e.message : String(e),
    })
  }

  log.info("Cron concluído", { checked: checked_count, skipped })
  return NextResponse.json({ ok: true, checked: checked_count, skipped })
}
