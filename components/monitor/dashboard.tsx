"use client"

import { useState, useEffect, useRef, useMemo } from "react"
import { useMonitor } from "@/hooks/use-monitor"
import { useAvailabilitySummary } from "@/hooks/use-availability-summary"
import { useAvailabilityHealth } from "@/hooks/use-availability-health"
import { getAvailabilityWindowLabel } from "@/lib/availability-window-presets"
import { exportToCSV } from "@/lib/monitor-store"
import { DEFAULT_SITES } from "@/lib/default-sites"
import { Header } from "./header"
import { StatsCards } from "./stats-cards"
import { Charts } from "./charts"
import { SitesTable, type SiteAvailabilityRow } from "./sites-table"
import { UploadModal } from "./upload-modal"
import { OperationsPanel } from "./operations-panel"
import { EmptyState } from "./empty-state"
import { AlertTriangle } from "lucide-react"

function formatDurationShort(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60000))
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

function parsePositiveEnvMs(raw: string | undefined): number | null {
  if (!raw) return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.round(n)
}

function expectedIntervalMsFromEnv(): number {
  return (
    parsePositiveEnvMs(process.env.NEXT_PUBLIC_AVAILABILITY_EXPECTED_INTERVAL_MS) ??
    parsePositiveEnvMs(process.env.NEXT_PUBLIC_AVAILABILITY_CRON_INTERVAL_MS) ??
    parsePositiveEnvMs(process.env.NEXT_PUBLIC_MONITOR_POLL_INTERVAL_MS) ??
    120_000
  )
}

function staleAfterMsFromEnv(expectedIntervalMs: number): number {
  return parsePositiveEnvMs(process.env.NEXT_PUBLIC_AVAILABILITY_STALE_AFTER_MS)
    ?? Math.max(60_000, expectedIntervalMs * 3)
}

export function Dashboard() {
  /**
   * Top-level dashboard orchestrator.
   *
   * - Uses `useMonitor()` as the single source of truth for monitored sites + stats.
   * - Auto-seeds the app with `DEFAULT_SITES` on first visit (when localStorage is empty).
   * - Switches between normal mode and "Painel TV" mode for wallboard displays.
   */
  const {
    sites,
    stats,
    isChecking,
    lastFullCheck,
    summaryFetchNonce,
    isOperationsMode,
    setIsOperationsMode,
    importSites,
    checkAllSites,
  } = useMonitor()

  const [availabilityWindowHours, setAvailabilityWindowHours] = useState(24)
  const availabilityWindowLabel = useMemo(
    () => getAvailabilityWindowLabel(availabilityWindowHours),
    [availabilityWindowHours],
  )

  const externalIds = useMemo(() => sites.map(s => s.id), [sites])
  const { data: dbSummary, loading: dbSummaryLoading } = useAvailabilitySummary(
    externalIds,
    summaryFetchNonce,
    availabilityWindowHours,
  )
  const expectedIntervalMs = expectedIntervalMsFromEnv()
  const staleAfterMs = staleAfterMsFromEnv(expectedIntervalMs)
  const { data: healthData } = useAvailabilityHealth(sites.length > 0)

  const availabilityBySite = useMemo(() => {
    const r: Record<string, SiteAvailabilityRow> = {}
    if (dbSummary?.configured === true) {
      for (const p of dbSummary.perSite) {
        r[p.externalId] = {
          uptimePct: p.uptimePct,
          availableMinutesApprox: p.availableMinutesApprox,
          sampleCount: p.sampleCount,
          windowHours: dbSummary.hours,
          onlineSamples: p.onlineSamples,
          unstableSamples: p.unstableSamples,
          offlineSamples: p.offlineSamples,
          avgResponseMs: p.avgResponseMs,
          recentSamples: p.recentSamples,
          quality: p.quality,
        }
      }
    }
    return r
  }, [dbSummary])
  const qualityAlerts = useMemo(() => {
    if (!dbSummary || dbSummary.configured !== true) return []
    const collection = dbSummary.collection
    const alerts: string[] = []
    if (collection?.staleNow) {
      const staleFor = collection.staleForMs
      alerts.push(
        staleFor != null
          ? `Coleta desatualizada há ${formatDurationShort(staleFor)}`
          : "Coleta desatualizada",
      )
    }
    if (collection && collection.coveragePct < 95) {
      alerts.push(`Cobertura da coleta baixa (${collection.coveragePct.toFixed(1)}%)`)
    }
    if (dbSummary.totals.confidencePct != null && dbSummary.totals.confidencePct < 95) {
      alerts.push(`Confiança do cálculo reduzida (${dbSummary.totals.confidencePct.toFixed(1)}%)`)
    }
    if (!collection && healthData?.staleNow) {
      const staleFor = healthData.staleForMs
      alerts.push(
        staleFor != null
          ? `Sem heartbeat de coleta (fallback) há ${formatDurationShort(staleFor)}`
          : "Sem heartbeat de coleta (fallback)",
      )
    }
    if (!collection && lastFullCheck) {
      const lastLocalMs = new Date(lastFullCheck).getTime()
      if (Number.isFinite(lastLocalMs)) {
        const delta = Date.now() - lastLocalMs
        if (delta > staleAfterMs) {
          alerts.push(`Última checagem local há ${formatDurationShort(delta)}`)
        }
      }
    }
    return alerts
  }, [dbSummary, healthData, lastFullCheck, staleAfterMs])

  const [uploadOpen, setUploadOpen] = useState(false)
  const autoLoadedRef = useRef(false)

  // Auto-load default sites on first visit if no sites stored
  useEffect(() => {
    if (autoLoadedRef.current) return
    autoLoadedRef.current = true

    // Small delay to allow localStorage to load
    const timer = setTimeout(() => {
      if (sites.length === 0) {
        importSites(DEFAULT_SITES)
      }
    }, 300)
    return () => clearTimeout(timer)
  }, [sites.length, importSites])

  if (isOperationsMode) {
    return (
      <div
        className="cursor-pointer"
        onDoubleClick={() => setIsOperationsMode(false)}
        title="Duplo clique para sair do modo Painel TV"
      >
        <OperationsPanel
          sites={sites}
          stats={stats}
          lastFullCheck={lastFullCheck}
        />
      </div>
    )
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <Header
        onRefresh={() => checkAllSites()}
        onExport={() => exportToCSV(sites)}
        onToggleOpsMode={() => setIsOperationsMode(true)}
        isChecking={isChecking}
        isOperationsMode={isOperationsMode}
        lastFullCheck={lastFullCheck}
        sitesCount={sites.length}
        onUploadClick={() => setUploadOpen(true)}
      />

      {sites.length === 0 ? (
        <EmptyState onUploadClick={() => setUploadOpen(true)} />
      ) : (
        <main className="flex flex-col gap-4 p-4 lg:p-6">
          {qualityAlerts.length > 0 ? (
            <div className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
              <div className="mb-1 flex items-center gap-1.5 font-medium">
                <AlertTriangle className="h-3.5 w-3.5" />
                Qualidade de dados de disponibilidade
              </div>
              <ul className="list-inside list-disc space-y-0.5">
                {qualityAlerts.map((a, i) => (
                  <li key={`${a}-${i}`}>{a}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <StatsCards stats={stats} />
          <Charts
            sites={sites}
            stats={stats}
            dbSummary={dbSummary}
            dbLoading={dbSummaryLoading}
          />
          <SitesTable
            sites={sites}
            availabilityBySite={availabilityBySite}
            availabilityWindowHours={availabilityWindowHours}
            availabilityWindowLabel={availabilityWindowLabel}
            onAvailabilityWindowHoursChange={setAvailabilityWindowHours}
          />
        </main>
      )}

      <UploadModal
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        onImport={importSites}
      />
    </div>
  )
}
