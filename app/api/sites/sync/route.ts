import { NextRequest, NextResponse } from "next/server"
import { createLogger } from "@/lib/logger"
import { isMonitorSyncAuthorized } from "@/lib/monitor-api-auth"
import { getSupabaseAdmin } from "@/lib/supabase/admin"
import { z } from "zod"

const log = createLogger("api:sites-sync")

const bodySchema = z.object({
  sites: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      url: z.string().min(1),
      category: z.enum(["Operacional", "Cliente", "Interno"]),
    }),
  ),
})

export async function POST(request: NextRequest) {
  if (!isMonitorSyncAuthorized(request)) {
    return NextResponse.json({ error: "Não autorizado" }, { status: 401 })
  }

  const supabase = getSupabaseAdmin()
  if (!supabase) {
    log.warn("Supabase não configurado; sync ignorado")
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

  const rows = parsed.data.sites.map((s) => ({
    external_id: s.id,
    name: s.name,
    url: s.url,
    category: s.category,
    updated_at: new Date().toISOString(),
  }))

  const { error } = await supabase.from("monitored_sites").upsert(rows, {
    onConflict: "external_id",
  })

  if (error) {
    log.error("Erro ao upsert monitored_sites", { message: error.message })
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  log.info("Sites sincronizados", { count: rows.length })
  return NextResponse.json({ ok: true, synced: rows.length })
}
