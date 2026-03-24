import { createLogger } from "@/lib/logger"
import { getSupabaseAdmin } from "@/lib/supabase/admin"

const log = createLogger("availability-collection-run")

export type AvailabilityRunSource = "dashboard" | "cron" | "manual" | "unknown"

export async function recordAvailabilityCollectionRun(args: {
  source: AvailabilityRunSource
  status: "ok" | "error"
  checkedCount: number
  errorMessage?: string
}): Promise<void> {
  const supabase = getSupabaseAdmin()
  if (!supabase) return

  const { source, status, checkedCount, errorMessage } = args
  const { error } = await supabase
    .from("availability_collection_runs")
    .insert({
      source,
      status,
      checked_count: checkedCount,
      error_message: errorMessage ?? null,
    })

  if (error) {
    log.warn("Falha ao registrar run de coleta", {
      source,
      status,
      message: error.message,
    })
  }
}
