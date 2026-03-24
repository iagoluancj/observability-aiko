"use client"

import { useState, useMemo, memo } from "react"
import {
  ArrowUpDown,
  Search,
  Loader2,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  ArrowLeftRight,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { MonitoredSite, SiteStatus } from "@/lib/types"
import type { AvailabilityRecentSample } from "@/lib/availability-summary-types"
import { formatAvailableMinutes } from "@/lib/format-available-time"
import { AVAILABILITY_WINDOW_PRESETS } from "@/lib/availability-window-presets"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"

export interface SiteAvailabilityRow {
  uptimePct: number | null
  availableMinutesApprox: number | null
  sampleCount: number
  windowHours: number
  onlineSamples: number
  unstableSamples: number
  offlineSamples: number
  avgResponseMs: number | null
  recentSamples: AvailabilityRecentSample[]
  quality: {
    maxCarryForwardMs: number
    unknownMs: number
    confidencePct: number
    largestGapMs: number
  }
}

interface SitesTableProps {
  sites: MonitoredSite[]
  /** Dados agregados do Supabase por `site.id` (external_id) */
  availabilityBySite?: Record<string, SiteAvailabilityRow>
  availabilityWindowHours: number
  availabilityWindowLabel: string
  onAvailabilityWindowHoursChange: (hours: number) => void
}

const PAGE_SIZE = 12

type SortKey = "name" | "statusSeverity" | "responseTime" | "httpCode" | "category" | "uptime24h"
type SortDir = "asc" | "desc"

/** Menor = mais crítico; offline primeiro no modo asc (padrão). */
function statusSeverityRank(s: SiteStatus): number {
  switch (s) {
    case "offline":
      return 0
    case "unstable":
      return 1
    case "checking":
      return 2
    case "unknown":
      return 3
    case "online":
      return 4
    default:
      return 5
  }
}

function StatusBadge({ status }: { status: SiteStatus }) {
  const config = {
    online: { label: "Online", dot: "bg-success", bg: "bg-success/10", text: "text-success" },
    offline: { label: "Offline", dot: "bg-destructive", bg: "bg-destructive/10", text: "text-destructive" },
    unstable: { label: "Instavel", dot: "bg-warning", bg: "bg-warning/10", text: "text-warning" },
    checking: { label: "Verificando", dot: "bg-muted-foreground animate-pulse", bg: "bg-muted", text: "text-muted-foreground" },
    unknown: { label: "Pendente", dot: "bg-muted-foreground", bg: "bg-muted", text: "text-muted-foreground" },
  }
  const c = config[status]
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium ${c.bg} ${c.text}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${c.dot}`} />
      {c.label}
    </span>
  )
}

function PerformanceBar({ time }: { time: number | null }) {
  if (time === null) return <span className="text-muted-foreground">-</span>
  const perc = Math.min((time / 5000) * 100, 100)
  const color = time < 1000 ? "bg-success" : time < 3000 ? "bg-warning" : "bg-destructive"
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
        <div className={`h-full rounded-full ${color} transition-all`} style={{ width: `${perc}%` }} />
      </div>
      <span className="font-mono text-xs tabular-nums">{time}ms</span>
    </div>
  )
}

function formatCheckedAtPt(iso: string): string {
  try {
    return new Date(iso).toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
  } catch {
    return iso
  }
}

function statusSampleLabel(s: AvailabilityRecentSample["status"]): string {
  switch (s) {
    case "online":
      return "Online"
    case "offline":
      return "Offline"
    case "unstable":
      return "Instável"
    default:
      return s
  }
}

function RecentChecksList({ samples }: { samples: AvailabilityRecentSample[] }) {
  if (samples.length === 0) {
    return (
      <p className="text-[11px] text-muted-foreground">
        Nenhuma checagem registrada na janela selecionada.
      </p>
    )
  }
  return (
    <ul className="max-h-48 space-y-1.5 overflow-y-auto border-t border-border pt-2 text-[11px]">
      {samples.map((s, i) => (
        <li
          key={`${s.checkedAt}-${i}`}
          className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b border-border/40 pb-1.5 font-mono text-card-foreground last:border-0 last:pb-0"
        >
          <span className="text-muted-foreground">{formatCheckedAtPt(s.checkedAt)}</span>
          <span className="font-sans text-xs font-medium">{statusSampleLabel(s.status)}</span>
          <span className="text-muted-foreground">
            {s.responseTimeMs != null ? `${Math.round(s.responseTimeMs)} ms` : "—"}
          </span>
        </li>
      ))}
    </ul>
  )
}

function AvailabilityDetailsBody({ row, windowLabel }: { row: SiteAvailabilityRow; windowLabel: string }) {
  const pct = row.uptimePct ?? 0
  const mins = row.availableMinutesApprox ?? 0
  const h = row.windowHours
  const windowMin = windowTotalMinutes(h)
  const unavailMin = Math.max(0, windowMin - mins)
  const unknownMin = Math.max(0, Math.round(row.quality.unknownMs / 60000))
  return (
    <div className="space-y-3 border-t border-border pt-3 text-xs leading-relaxed text-card-foreground">
      <div>
        <p className="mb-1 font-semibold text-card-foreground">O que a célula mostra</p>
        <ul className="list-inside list-disc space-y-1 text-muted-foreground">
          <li>
            <strong className="text-card-foreground">{formatAvailableMinutes(mins)}</strong> — tempo em que o sistema ficou como{" "}
            <strong className="text-card-foreground">online</strong> ao longo da janela.
          </li>
          <li>
            <strong className="text-card-foreground">{pct.toFixed(1)}%</strong> — percentual do tempo online na janela.
          </li>
          <li>
            <strong className="text-card-foreground">{formatAvailableMinutes(unavailMin)}</strong> — tempo na janela em que o sistema <strong className="text-card-foreground">não</strong> esteve online.
          </li>

        </ul>
      </div>
      <div>
        <p className="mb-1 font-semibold text-card-foreground">Como é calculado</p>
        <p className="text-muted-foreground">
          Usamos o último estado conhecido antes da janela e cada <strong className="text-card-foreground">registro</strong> gravado no DB como mudança de estado; entre registros o estado permanece até o próximo. Só há poucos registros quando nada muda (política esparsa) — o gráfico de tempo ainda reflete a duração real na janela.
        </p>
      </div>
      <div>
        <p className="mb-1 font-semibold text-card-foreground">Registros na janela (Supabase)</p>
        <p className="font-mono text-[11px] text-muted-foreground">
          Online: {row.onlineSamples} · Instável: {row.unstableSamples} · Offline: {row.offlineSamples} · Total: {row.sampleCount}
        </p>
        <p className="mt-1 text-muted-foreground">
          Tempo médio de resposta:{" "}
          <strong className="text-card-foreground">{row.avgResponseMs != null ? `${row.avgResponseMs} ms` : "—"}</strong>
        </p>
        <p className="mt-1 text-muted-foreground">
          Confiança dos dados:{" "}
          <strong className="text-card-foreground">{row.quality.confidencePct.toFixed(1)}%</strong>
          {" · "}
          Sem sinal:{" "}
          <strong className="text-card-foreground">{formatAvailableMinutes(unknownMin)}</strong>
        </p>
      </div>
    </div>
  )
}

function windowTotalMinutes(hours: number): number {
  return Math.max(0, Math.round(hours * 60))
}

function AvailabilityCell({
  row,
  windowLabel,
  systemLabel,
  hoverOpen,
  onHoverOpenChange,
  detailsOpen,
  onDetailsOpenChange,
  primaryUnavailable,
  onTogglePrimary,
}: {
  row: SiteAvailabilityRow | undefined
  windowLabel: string
  /** Sigla / nome curto do sistema (ex.: cliente) no título do painel */
  systemLabel: string
  hoverOpen: boolean
  onHoverOpenChange: (open: boolean) => void
  detailsOpen: boolean
  onDetailsOpenChange: (open: boolean) => void
  /** Destaque do tempo indisponível na linha (compartilhado com o botão “todas as linhas”) */
  primaryUnavailable: boolean
  onTogglePrimary: () => void
}) {
  if (!row || row.availableMinutesApprox == null || row.uptimePct == null) {
    return <span className="text-muted-foreground">—</span>
  }
  const pct = row.uptimePct
  const windowMin = windowTotalMinutes(row.windowHours)
  const availMin = row.availableMinutesApprox
  const unavailMin = Math.max(0, windowMin - availMin)

  const primaryColor = primaryUnavailable
    ? unavailMin > 0
      ? "text-destructive"
      : "text-muted-foreground"
    : pct >= 99
      ? "text-success"
      : pct >= 95
        ? "text-warning"
        : "text-destructive"

  const primaryText = primaryUnavailable
    ? `${formatAvailableMinutes(unavailMin)} indispon.`
    : formatAvailableMinutes(availMin)

  const secondaryText = primaryUnavailable
    ? `${formatAvailableMinutes(availMin)} dispon.`
    : `${formatAvailableMinutes(unavailMin)} indispon.`

  const regLabel =
    row.sampleCount === 0
      ? "0 registros na janela"
      : `${row.sampleCount} registro${row.sampleCount === 1 ? "" : "s"}`

  const titlePrefix = systemLabel.trim() || "Sistema"

  return (
    <div className="flex max-w-[168px] items-start gap-1">
      <HoverCard
        open={hoverOpen}
        onOpenChange={onHoverOpenChange}
        openDelay={180}
        closeDelay={450}
      >
        <HoverCardTrigger asChild>
          <button
            type="button"
            className={cn(
              "min-w-0 flex-1 cursor-default rounded-md border border-transparent text-left transition-colors",
              "hover:border-border hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            )}
          >
            <p className={`font-mono text-xs font-semibold tabular-nums ${primaryColor}`}>
              {primaryText}
            </p>
            <p className="text-[10px] leading-tight text-muted-foreground">
              <span className="tabular-nums">{secondaryText}</span>
              {" · "}
              {pct.toFixed(1)}%
            </p>
          </button>
        </HoverCardTrigger>
        <HoverCardContent
          side="left"
          align="start"
          sideOffset={10}
          className={cn(
            "w-[min(calc(100vw-1.5rem),22rem)] max-h-[min(72vh,36rem)] overflow-y-auto overflow-x-hidden",
            "border-border bg-card p-3 text-card-foreground shadow-md",
          )}
        >
          <div className="space-y-2">
            <div>
              <p className="text-xs font-semibold text-card-foreground">
                {titlePrefix} — Últimas checagens
              </p>
              <p className="text-[10px] text-muted-foreground">Mais recente primeiro · {windowLabel}</p>
            </div>
            <RecentChecksList samples={row.recentSamples} />
            <Collapsible open={detailsOpen} onOpenChange={onDetailsOpenChange}>
              <CollapsibleTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-1 h-8 w-full gap-1 border-border text-xs text-card-foreground"
                >
                  {detailsOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                  Detalhes e cálculo
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <AvailabilityDetailsBody row={row} windowLabel={windowLabel} />
              </CollapsibleContent>
            </Collapsible>
          </div>
        </HoverCardContent>
      </HoverCard>
      <button
        type="button"
        title={primaryUnavailable ? "Mostrar tempo disponível" : "Mostrar tempo indisponível"}
        aria-label={primaryUnavailable ? "Mostrar tempo disponível" : "Mostrar tempo indisponível"}
        onClick={e => {
          e.stopPropagation()
          e.preventDefault()
          onTogglePrimary()
        }}
        className="mt-0.5 shrink-0 rounded border border-transparent p-0.5 text-muted-foreground transition-colors hover:border-border hover:bg-muted/50 hover:text-foreground"
      >
        <ArrowLeftRight className="h-3 w-3" />
      </button>
    </div>
  )
}

type AvailabilityPrimaryPrefs = { global: boolean; rows: Record<string, boolean> }

export const SitesTable = memo(function SitesTable({
  sites,
  availabilityBySite,
  availabilityWindowHours,
  availabilityWindowLabel,
  onAvailabilityWindowHoursChange,
}: SitesTableProps) {
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<SiteStatus | "all">("all")
  const [categoryFilter, setCategoryFilter] = useState<string>("all")
  const [sortKey, setSortKey] = useState<SortKey>("statusSeverity")
  const [sortDir, setSortDir] = useState<SortDir>("asc")
  const [page, setPage] = useState(0)
  /** Mantém o HoverCard de disponibilidade aberto ao revalidar sites / polling */
  const [availabilityHoverSiteId, setAvailabilityHoverSiteId] = useState<string | null>(null)
  const [availabilityDetailsOpenBySite, setAvailabilityDetailsOpenBySite] = useState<Record<string, boolean>>({})
  /** `global`: botão “todas”; `rows[id]`: exceção só naquela linha */
  const [availabilityPrimary, setAvailabilityPrimary] = useState<AvailabilityPrimaryPrefs>({
    global: false,
    rows: {},
  })

  const effectivePrimaryUnavailable = (siteId: string) =>
    availabilityPrimary.rows[siteId] ?? availabilityPrimary.global

  const toggleToolbarPrimary = () =>
    setAvailabilityPrimary(p => ({ global: !p.global, rows: {} }))

  const toggleRowPrimary = (siteId: string) =>
    setAvailabilityPrimary(p => {
      const current = p.rows[siteId] ?? p.global
      const next = !current
      if (next === p.global) {
        const { [siteId]: _, ...rows } = p.rows
        return { ...p, rows }
      }
      return { ...p, rows: { ...p.rows, [siteId]: next } }
    })

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => (d === "asc" ? "desc" : "asc"))
    } else {
      setSortKey(key)
      setSortDir("asc")
    }
    setPage(0)
  }

  const filtered = useMemo(() => {
    let result = [...sites]

    if (search) {
      const q = search.toLowerCase()
      result = result.filter(
        s =>
          s.name.toLowerCase().includes(q) ||
          s.url.toLowerCase().includes(q)
      )
    }

    if (statusFilter !== "all") {
      result = result.filter(s => s.currentStatus === statusFilter)
    }

    if (categoryFilter !== "all") {
      result = result.filter(s => s.category === categoryFilter)
    }

    result.sort((a, b) => {
      const dir = sortDir === "asc" ? 1 : -1
      switch (sortKey) {
        case "name":
          return dir * a.name.localeCompare(b.name)
        case "statusSeverity": {
          const ra = statusSeverityRank(a.currentStatus)
          const rb = statusSeverityRank(b.currentStatus)
          if (ra !== rb) return dir * (ra - rb)
          return a.name.localeCompare(b.name)
        }
        case "responseTime":
          return dir * ((a.responseTime ?? 99999) - (b.responseTime ?? 99999))
        case "httpCode":
          return dir * ((a.httpCode ?? 0) - (b.httpCode ?? 0))
        case "category":
          return dir * a.category.localeCompare(b.category)
        case "uptime24h": {
          const ua = availabilityBySite?.[a.id]?.availableMinutesApprox
          const ub = availabilityBySite?.[b.id]?.availableMinutesApprox
          const na = ua == null ? -1 : ua
          const nb = ub == null ? -1 : ub
          return dir * (na - nb)
        }
        default:
          return 0
      }
    })

    return result
  }, [sites, search, statusFilter, categoryFilter, sortKey, sortDir, availabilityBySite])

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE)
  const paginated = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  return (
    <div className="rounded-lg border border-border bg-card">
      {/* Filters */}
      <div className="flex flex-col gap-3 border-b border-border p-4 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Buscar por nome ou URL..."
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(0) }}
            className="h-9 border-border bg-background pl-9 text-sm text-foreground placeholder:text-muted-foreground focus-visible:ring-primary"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            title={
              availabilityPrimary.global
                ? "Mostrar tempo disponível em destaque em todas as linhas"
                : "Mostrar tempo indisponível em destaque em todas as linhas"
            }
            onClick={toggleToolbarPrimary}
            className="h-9 shrink-0 gap-1.5 border-border px-2.5 text-xs text-card-foreground cursor-pointer hover:bg-muted/50 hover:text-foreground"
          >
            <ArrowLeftRight className="h-3.5 w-3.5" />
            {availabilityPrimary.global ? "Disponível (todas)" : "Indisponível (todas)"}
          </Button>
          <select
            value={statusFilter}
            onChange={e => { setStatusFilter(e.target.value as SiteStatus | "all"); setPage(0) }}
            className="h-9 rounded-md border border-border bg-background px-3 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          >
            <option value="all">Todos status</option>
            <option value="online">Online</option>
            <option value="offline">Offline</option>
            <option value="unstable">Instavel</option>
          </select>
          <select
            value={categoryFilter}
            onChange={e => { setCategoryFilter(e.target.value); setPage(0) }}
            className="h-9 rounded-md border border-border bg-background px-3 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          >
            <option value="all">Todas categorias</option>
            <option value="Operacional">Operacional</option>
            <option value="Cliente">Cliente</option>
            <option value="Interno">Interno</option>
          </select>
          <select
            value={availabilityWindowHours}
            title="Período do histórico Supabase (tempo disponível)"
            onChange={e => {
              onAvailabilityWindowHoursChange(Number(e.target.value))
              setPage(0)
            }}
            className="h-9 max-w-44 rounded-md border border-border bg-background px-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          >
            {AVAILABILITY_WINDOW_PRESETS.map(p => (
              <option key={p.hours} value={p.hours}>
                Histórico: {p.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/30">
              <SortHeader label="Sistema" sortKey="name" currentKey={sortKey} dir={sortDir} onSort={toggleSort} />
              <SortHeader label="Status" sortKey="statusSeverity" currentKey={sortKey} dir={sortDir} onSort={toggleSort} />
              <SortHeader label="HTTP" sortKey="httpCode" currentKey={sortKey} dir={sortDir} onSort={toggleSort} />
              <SortHeader label="Tempo" sortKey="responseTime" currentKey={sortKey} dir={sortDir} onSort={toggleSort} />
              <SortHeader
                label={`Disponibilidade`}
                sortKey="uptime24h"
                currentKey={sortKey}
                dir={sortDir}
                onSort={toggleSort}
              />
              <SortHeader label="Categoria" sortKey="category" currentKey={sortKey} dir={sortDir} onSort={toggleSort} />
              <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">Verificacao</th>
            </tr>
          </thead>
          <tbody>
            {paginated.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-sm text-muted-foreground">
                  {sites.length === 0
                    ? "Nenhum sistema importado. Use o botao Importar Excel para comecar."
                    : "Nenhum resultado encontrado para os filtros aplicados."}
                </td>
              </tr>
            ) : (
              paginated.map(site => (
                <tr
                  key={site.id}
                  className={`border-b border-border/50 transition-colors hover:bg-muted/20 ${
                    site.currentStatus === "offline"
                      ? "bg-destructive/5"
                      : ""
                  }`}
                >
                  <td className="px-4 py-3">
                    <a
                      href={site.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono text-xs font-semibold text-primary underline-offset-2 hover:text-primary/90 hover:underline"
                    >
                      {site.name}
                    </a>
                  </td>
                  <td className="px-4 py-3">
                    {site.currentStatus === "checking" ? (
                      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        Verificando
                      </span>
                    ) : (
                      <StatusBadge status={site.currentStatus} />
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`font-mono text-xs ${
                      site.httpCode && site.httpCode >= 200 && site.httpCode < 300
                        ? "text-success"
                        : site.httpCode && site.httpCode >= 400
                          ? "text-destructive"
                          : "text-muted-foreground"
                    }`}>
                      {site.httpCode ?? "-"}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <PerformanceBar time={site.responseTime} />
                  </td>
                  <td className="px-4 py-3">
                    <AvailabilityCell
                      row={availabilityBySite?.[site.id]}
                      windowLabel={availabilityWindowLabel}
                      systemLabel={site.name}
                      hoverOpen={availabilityHoverSiteId === site.id}
                      onHoverOpenChange={open =>
                        setAvailabilityHoverSiteId(open ? site.id : null)
                      }
                      detailsOpen={availabilityDetailsOpenBySite[site.id] ?? false}
                      onDetailsOpenChange={open =>
                        setAvailabilityDetailsOpenBySite(prev => ({ ...prev, [site.id]: open }))
                      }
                      primaryUnavailable={effectivePrimaryUnavailable(site.id)}
                      onTogglePrimary={() => toggleRowPrimary(site.id)}
                    />
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex rounded-md px-2 py-0.5 text-[10px] font-medium ${
                      site.category === "Operacional"
                        ? "bg-primary/10 text-primary"
                        : site.category === "Cliente"
                          ? "bg-chart-5/10 text-chart-5"
                          : "bg-muted text-muted-foreground"
                    }`}>
                      {site.category}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {site.lastChecked
                      ? new Date(site.lastChecked).toLocaleTimeString("pt-BR")
                      : "-"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between border-t border-border px-4 py-3">
          <span className="text-xs text-muted-foreground">
            {filtered.length} sistema{filtered.length !== 1 ? "s" : ""} encontrado{filtered.length !== 1 ? "s" : ""}
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={page === 0}
              className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="px-2 text-xs text-muted-foreground">
              {page + 1} / {totalPages}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}, (prev, next) =>
  prev.sites === next.sites &&
  prev.availabilityBySite === next.availabilityBySite &&
  prev.availabilityWindowHours === next.availabilityWindowHours &&
  prev.availabilityWindowLabel === next.availabilityWindowLabel &&
  prev.onAvailabilityWindowHoursChange === next.onAvailabilityWindowHoursChange,
)

function SortHeader({
  label,
  sortKey,
  currentKey,
  dir,
  onSort,
}: {
  label: string
  sortKey: SortKey
  currentKey: SortKey
  dir: SortDir
  onSort: (key: SortKey) => void
}) {
  return (
    <th className="px-4 py-3 text-left">
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className="flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        {label}
        <ArrowUpDown
          className={`h-3 w-3 ${currentKey === sortKey ? "text-primary" : ""}`}
        />
        {currentKey === sortKey && (
          <span className="text-[9px] text-primary">
            {dir === "asc" ? "A" : "D"}
          </span>
        )}
      </button>
    </th>
  )
}
