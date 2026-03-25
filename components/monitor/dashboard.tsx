"use client"

import { useState, useEffect, useRef, useMemo } from "react"
import { useMonitor } from "@/hooks/use-monitor"
import { useAvailabilitySummary } from "@/hooks/use-availability-summary"
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
        }
      }
    }
    return r
  }, [dbSummary])

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
