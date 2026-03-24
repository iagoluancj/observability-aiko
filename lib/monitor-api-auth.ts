import type { NextRequest } from "next/server"

/** Se `MONITOR_SYNC_SECRET` estiver definido, rotas chamadas pelo browser precisam do header (não recomendado para SPA). */
export function isMonitorSyncAuthorized(request: NextRequest): boolean {
  const secret = process.env.MONITOR_SYNC_SECRET
  if (!secret) return true
  return request.headers.get("x-monitor-sync-secret") === secret
}
