import type { MonitoredSite, SiteCheck, SiteStatus, DashboardStats } from "./types"
import { buildStableSiteExternalId } from "./site-identity"

const STORAGE_KEY = "aiko-monitor-sites"

function categorize(name: string): "Operacional" | "Cliente" | "Interno" {
  // Heuristic categorization based on the system "sigla"/name.
  // This is domain-specific and can be adjusted as business rules evolve.
  const n = name.toUpperCase()
  const clientKeywords = ["ABE", "CJR", "ABF", "CVF", "ABR", "BRF", "VAF", "MEN", "INP", "RCF", "SML", "RFT", "CNE", "GLM", "CST", "VAP", "VLI", "FTM", "AGP", "LDC", "CBM", "JFI", "KLB", "CNB", "ELD", "SYL", "ARC", "ANG", "VRC", "TNS", "VPC"]
  const internalKeywords = ["TMP", "DEX", "EDC", "WST", "MTM"]

  if (internalKeywords.some(k => n.includes(k))) return "Interno"
  if (clientKeywords.some(k => n.includes(k))) return "Cliente"
  return "Operacional"
}

export function loadSites(): MonitoredSite[] {
  if (typeof window === "undefined") return []
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (!stored) return []
    const parsed = JSON.parse(stored) as MonitoredSite[]
    if (!Array.isArray(parsed)) return []

    const { sites: migrated, changed } = migrateSitesToStableIds(parsed)
    if (changed) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated))
    }
    return migrated
  } catch {}
  return []
}

export function saveSites(sites: MonitoredSite[]): void {
  if (typeof window === "undefined") return
  try {
    // Persist the whole monitoring state so the dashboard restores after refresh.
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sites))
  } catch {}
}

export function parseSitesFromData(data: Array<{ name: string; url: string }>): MonitoredSite[] {
  // Normalizes imported rows (Excel/CSV) into the internal `MonitoredSite` shape.
  const byId = new Map<string, MonitoredSite>()
  for (const item of data) {
    const name = item.name.trim()
    const url = item.url.trim()
    if (!name || !url) continue

    const id = buildStableSiteExternalId({ name, url })
    if (byId.has(id)) continue

    byId.set(id, {
      id,
      name,
      url,
      category: categorize(name),
      currentStatus: "unknown" as SiteStatus,
      httpCode: null,
      responseTime: null,
      lastChecked: null,
      history: [],
    })
  }
  return [...byId.values()]
}

/** Compara só o que a tabela exibe (evita re-render / novo histórico quando nada mudou). */
export function isSameDisplaySnapshot(site: MonitoredSite, check: SiteCheck): boolean {
  return (
    site.currentStatus === check.status &&
    site.httpCode === check.httpCode &&
    site.responseTime === check.responseTime
  )
}

export function updateSiteCheck(site: MonitoredSite, check: SiteCheck): MonitoredSite {
  // Keep a short rolling history for charts/trends.
  const history = [check, ...site.history].slice(0, 10)
  return {
    ...site,
    currentStatus: check.status,
    httpCode: check.httpCode,
    responseTime: check.responseTime,
    lastChecked: check.timestamp,
    history,
  }
}

function migrateSitesToStableIds(sites: MonitoredSite[]): { sites: MonitoredSite[]; changed: boolean } {
  const byStableId = new Map<string, MonitoredSite>()
  let changed = false

  for (const site of sites) {
    const stableId = buildStableSiteExternalId({ name: site.name, url: site.url })
    const normalized = site.id === stableId ? site : { ...site, id: stableId }
    if (site.id !== stableId) changed = true

    const previous = byStableId.get(stableId)
    if (!previous) {
      byStableId.set(stableId, normalized)
      continue
    }

    changed = true
    byStableId.set(stableId, pickPreferredSite(previous, normalized))
  }

  const migrated = [...byStableId.values()]
  if (migrated.length !== sites.length) changed = true
  return { sites: migrated, changed }
}

function pickPreferredSite(a: MonitoredSite, b: MonitoredSite): MonitoredSite {
  const aTs = a.lastChecked ? new Date(a.lastChecked).getTime() : 0
  const bTs = b.lastChecked ? new Date(b.lastChecked).getTime() : 0
  if (aTs > bTs) return a
  if (bTs > aTs) return b
  if (a.history.length > b.history.length) return a
  if (b.history.length > a.history.length) return b
  return a
}

export function calculateStats(sites: MonitoredSite[]): DashboardStats {
  const online = sites.filter(s => s.currentStatus === "online").length
  const offline = sites.filter(s => s.currentStatus === "offline").length
  const unstable = sites.filter(s => s.currentStatus === "unstable").length
  const responseTimes = sites
    .map(s => s.responseTime)
    .filter((t): t is number => t !== null)
  const avgResponseTime = responseTimes.length
    ? Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length)
    : 0

  return {
    total: sites.length,
    online,
    offline,
    unstable,
    avgResponseTime,
    activeAlerts: offline + unstable,
  }
}

export function exportToCSV(sites: MonitoredSite[]): void {
  const headers = ["Sistema", "URL", "Status", "Codigo HTTP", "Tempo de Resposta (ms)", "Ultima Verificacao", "Categoria"]
  const rows = sites.map(s => [
    s.name,
    s.url,
    s.currentStatus,
    s.httpCode ?? "-",
    s.responseTime ?? "-",
    s.lastChecked ?? "-",
    s.category,
  ])

  const csv = [headers.join(","), ...rows.map(r => r.join(","))].join("\n")
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" })
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = `aiko-monitor-${new Date().toISOString().slice(0, 10)}.csv`
  link.click()
  URL.revokeObjectURL(url)
}
