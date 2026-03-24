import { NextResponse } from "next/server"
import { createLogger } from "@/lib/logger"
import { getSupabaseAdmin } from "@/lib/supabase/admin"
import {
  buildCoverageFromCollectionRuns,
  computeFreshness,
  readExpectedCollectionIntervalMsFromEnv,
  readMaxCarryForwardMsFromEnv,
  readStaleAfterMsFromEnv,
} from "@/lib/availability-data-quality"

const log = createLogger("api:availability-health")
const MAX_ROWS = 20000

export const dynamic = "force-dynamic"

export async function GET() {
  const supabase = getSupabaseAdmin()
  if (!supabase) {
    return NextResponse.json(
      { configured: false, error: "Supabase não configurado" },
      { status: 503 },
    )
  }

  const nowMs = Date.now()
  const expectedIntervalMs = readExpectedCollectionIntervalMsFromEnv()
  const maxCarryForwardMs = readMaxCarryForwardMsFromEnv()
  const staleAfterMs = readStaleAfterMsFromEnv()
  const windowHours = 24
  const windowStartMs = nowMs - windowHours * 3600 * 1000
  const sinceIso = new Date(windowStartMs).toISOString()

  const [runsRes, lastRes] = await Promise.all([
    supabase
      .from("availability_collection_runs")
      .select("run_at")
      .eq("status", "ok")
      .gte("run_at", sinceIso)
      .order("run_at", { ascending: true })
      .limit(MAX_ROWS),
    supabase
      .from("availability_collection_runs")
      .select("run_at")
      .eq("status", "ok")
      .order("run_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])

  if (runsRes.error) {
    log.error("Erro ao listar runs de coleta", { message: runsRes.error.message })
    return NextResponse.json({ error: runsRes.error.message }, { status: 500 })
  }
  if (lastRes.error) {
    log.error("Erro ao buscar último run de coleta", { message: lastRes.error.message })
    return NextResponse.json({ error: lastRes.error.message }, { status: 500 })
  }

  const runAts = (runsRes.data ?? [])
    .map((r) => (typeof r.run_at === "string" ? r.run_at : null))
    .filter((v): v is string => v != null)
  const coverage = buildCoverageFromCollectionRuns(windowStartMs, nowMs, runAts, maxCarryForwardMs)
  const windowMs = Math.max(0, nowMs - windowStartMs)
  const coveragePct =
    windowMs > 0
      ? Math.max(0, Math.min(100, Math.round(((windowMs - coverage.uncoveredMs) / windowMs) * 1000) / 10))
      : 0

  const lastRunAt = lastRes.data?.run_at ?? null
  const freshness = computeFreshness(nowMs, lastRunAt, staleAfterMs)

  const healthy = !freshness.staleNow && coveragePct >= 95
  const status = healthy ? 200 : 503

  return NextResponse.json(
    {
      configured: true,
      healthy,
      expectedIntervalMs,
      maxCarryForwardMs,
      staleAfterMs,
      coverageWindowHours: windowHours,
      coveragePct,
      gapCount: coverage.gapCount,
      largestGapMs: coverage.largestGapMs,
      lastRunAt,
      staleNow: freshness.staleNow,
      staleForMs: freshness.staleForMs,
      runsInWindow: runAts.length,
    },
    { status },
  )
}
