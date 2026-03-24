"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import type { MonitoredSite, SiteCheck } from "@/lib/types"
import {
  loadSites,
  saveSites,
  updateSiteCheck,
  calculateStats,
  parseSitesFromData,
  isSameDisplaySnapshot,
} from "@/lib/monitor-store"
import { toast } from "sonner"
import { createLogger } from "@/lib/logger"

function readPollIntervalMs(): number {
  const raw = process.env.NEXT_PUBLIC_MONITOR_POLL_INTERVAL_MS
  if (raw == null || raw === "") return 10_000
  const n = Number(raw)
  return Number.isFinite(n) && n >= 3000 ? n : 10_000
}

const CHECK_INTERVAL = readPollIntervalMs()
const log = createLogger("useMonitor")

/** Envia ao Supabase cada rodada de checagem (app aberto); ignora 503 se env não estiver configurado. */
function logAvailabilityBatch(
  sites: MonitoredSite[],
  checks: Array<{ siteId: string; check: SiteCheck }>,
) {
  if (checks.length === 0) return

  const entries = checks
    .map(({ siteId, check }) => {
      const site = sites.find(s => s.id === siteId)
      if (!site) return null
      return {
        externalId: site.id,
        name: site.name,
        url: site.url,
        category: site.category,
        check,
      }
    })
    .filter((e): e is NonNullable<typeof e> => e !== null)

  if (entries.length === 0) return

  void fetch("/api/availability/log", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entries }),
  })
    .then(res => {
      if (!res.ok && res.status !== 503) {
        log.warn("Falha ao registrar disponibilidade no Supabase", { status: res.status })
      }
    })
    .catch(() => {
      log.warn("Erro de rede ao registrar disponibilidade no Supabase")
    })
}

export function useMonitor() {
  const [sites, setSites] = useState<MonitoredSite[]>([])
  const [isChecking, setIsChecking] = useState(false)
  const [lastFullCheck, setLastFullCheck] = useState<string | null>(null)
  /** Incrementa só quando status/http/tempo de algum site mudam (refetch resumo Supabase). */
  const [summaryFetchNonce, setSummaryFetchNonce] = useState(0)
  const [isOperationsMode, setIsOperationsMode] = useState(false)
  const intervalRef = useRef<NodeJS.Timeout | null>(null)
  const initializedRef = useRef(false)
  const sitesRef = useRef<MonitoredSite[]>([])

  // Load from localStorage on mount
  useEffect(() => {
    // Prevents running twice in React StrictMode (dev) and avoids double-import/double-check.
    if (initializedRef.current) return
    initializedRef.current = true
    const stored = loadSites()
    if (stored.length > 0) {
      log.info("Sites carregados do localStorage", { count: stored.length })
      setSites(stored)
    }
  }, [])

  // Save to localStorage whenever sites change
  useEffect(() => {
    if (sites.length > 0) {
      saveSites(sites)
    }
  }, [sites])

  useEffect(() => {
    sitesRef.current = sites
  }, [sites])

  const checkSite = useCallback(async (site: MonitoredSite): Promise<SiteCheck> => {
    log.info("Iniciando checagem de site", {
      id: site.id,
      name: site.name,
      url: site.url,
    })

    try {
      const res = await fetch("/api/check-site", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: site.url }),
      })

      log.debug("Resposta bruta de /api/check-site", {
        ok: res.ok,
        status: res.status,
        statusText: res.statusText,
      })

      const data = await res.json()

      log.debug("JSON recebido de /api/check-site", data)

      return data as SiteCheck
    } catch (error) {
      log.error("Erro ao checar site", {
        id: site.id,
        name: site.name,
        url: site.url,
        error,
      })

      toast.error(`Erro ao checar o sistema ${site.name}`, {
        description: "Veja o console do navegador para mais detalhes.",
      })

      return {
        status: "offline",
        httpCode: 0,
        responseTime: null,
        timestamp: new Date().toISOString(),
      }
    }
  }, [])

  const checkAllSites = useCallback(async (currentSites?: MonitoredSite[]) => {
    const sitesToCheck = currentSites ?? sitesRef.current
    if (sitesToCheck.length === 0) return

    log.info("Iniciando checagem em lote", { count: sitesToCheck.length })
    setIsChecking(true)

    const checks = await Promise.all(
      sitesToCheck.map(async (site) => {
        const check = await checkSite(site)
        return { siteId: site.id, check }
      }),
    )

    logAvailabilityBatch(sitesToCheck, checks)

    let anyDisplayChange = false
    setSites(prev => {
      const next = prev.map(site => {
        const result = checks.find(c => c.siteId === site.id)
        if (!result) return site
        if (isSameDisplaySnapshot(site, result.check)) return site
        anyDisplayChange = true
        if (
          result.check.status === "offline" &&
          site.currentStatus !== "offline" &&
          site.currentStatus !== "unknown"
        ) {
          toast.error(`Sistema ${site.name} ficou OFFLINE!`, {
            description: `URL: ${site.url}`,
            duration: 10000,
          })
        }
        return updateSiteCheck(site, result.check)
      })
      const unchanged = next.length === prev.length && next.every((s, i) => s === prev[i])
      return unchanged ? prev : next
    })

    if (anyDisplayChange) {
      setSummaryFetchNonce(n => n + 1)
    }

    setLastFullCheck(new Date().toISOString())
    setIsChecking(false)
  }, [checkSite])

  const importSites = useCallback((data: Array<{ name: string; url: string }>) => {
    const newSites = parseSitesFromData(data)
    setSites(newSites)
    saveSites(newSites)
    toast.success(`${newSites.length} sistemas importados com sucesso!`)
    // Run initial check after import
    setTimeout(() => {
      checkAllSites(newSites)
    }, 500)
  }, [checkAllSites])

  // Auto-refresh interval
  useEffect(() => {
    if (sites.length === 0) return

    if (intervalRef.current) {
      clearInterval(intervalRef.current)
    }

    intervalRef.current = setInterval(() => {
      checkAllSites()
    }, CHECK_INTERVAL)

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
      }
    }
  }, [sites.length, checkAllSites])

  const stats = calculateStats(sites)

  return {
    sites,
    stats,
    isChecking,
    lastFullCheck,
    summaryFetchNonce,
    isOperationsMode,
    setIsOperationsMode,
    importSites,
    checkAllSites,
  }
}
