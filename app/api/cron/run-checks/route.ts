import { NextRequest, NextResponse } from "next/server"
import { checkUrl } from "@/lib/check-url"
import { deriveSiteCheckFromUrlResult } from "@/lib/derive-site-check"
import { createLogger } from "@/lib/logger"
import { getSupabaseAdmin } from "@/lib/supabase/admin"

const log = createLogger("api:cron-run-checks")

/**
 * Opcional: agendador externo (Vercel Cron, etc.) com `Authorization: Bearer ${CRON_SECRET}`.
 * O fluxo principal hoje grava via `POST /api/availability/log` quando o dashboard está aberto.
 */
export const dynamic = "force-dynamic"
export const maxDuration = 300

const BATCH = 8

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

  const inserts: Array<{
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
    inserts.push({
      site_id: row.id,
      checked_at: check.timestamp,
      status: check.status,
      http_code: check.httpCode,
      response_time_ms: check.responseTime,
    })
  })

  const { error: insertError } = await supabase.from("availability_checks").insert(inserts)

  if (insertError) {
    log.error("Erro ao inserir availability_checks", { message: insertError.message })
    return NextResponse.json({ error: insertError.message }, { status: 500 })
  }

  log.info("Cron concluído", { checked: inserts.length })
  return NextResponse.json({ ok: true, checked: inserts.length })
}
