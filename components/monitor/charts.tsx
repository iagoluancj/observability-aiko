"use client"

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  AreaChart,
  Area,
} from "recharts"
import type { MonitoredSite, DashboardStats } from "@/lib/types"
import type { AvailabilitySummaryResponse } from "@/lib/availability-summary-types"
import { getAvailabilityWindowLabel } from "@/lib/availability-window-presets"

interface ChartsProps {
  sites: MonitoredSite[]
  stats: DashboardStats
  dbSummary: AvailabilitySummaryResponse | null
  dbLoading: boolean
}

const COLORS = {
  online: "#27ae60",
  offline: "#C0392B",
  unstable: "#f39c12",
  unknown: "#4a6358",
}

function CustomTooltipContent({ active, payload, label }: { active?: boolean; payload?: Array<{ value: number; name: string }>; label?: string }) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-lg border border-[#2a3a31] bg-[#1a2420] px-3 py-2 text-xs text-[#e8ede9] shadow-lg">
      <p className="font-medium">{label}</p>
      {payload.map((p, i) => (
        <p key={i} className="text-muted-foreground">
          {p.name}: {p.value}ms
        </p>
      ))}
    </div>
  )
}

function TimelineTooltip({
  active,
  payload,
}: {
  active?: boolean
  payload?: Array<{ payload: { label: string; avgMs: number; checks: number } }>
}) {
  if (!active || !payload?.length) return null
  const p = payload[0].payload
  return (
    <div className="rounded-lg border border-[#2a3a31] bg-[#1a2420] px-3 py-2 text-xs text-[#e8ede9] shadow-lg">
      <p className="font-medium">{p.label}</p>
      <p className="text-muted-foreground">Tempo medio: {p.avgMs} ms</p>
      <p className="text-muted-foreground">Registros: {p.checks}</p>
    </div>
  )
}

export function Charts({ sites, stats, dbSummary, dbLoading }: ChartsProps) {
  const pieData = [
    { name: "Online", value: stats.online, color: COLORS.online },
    { name: "Offline", value: stats.offline, color: COLORS.offline },
    { name: "Instavel", value: stats.unstable, color: COLORS.unstable },
    {
      name: "Desconhecido",
      value: stats.total - stats.online - stats.offline - stats.unstable,
      color: COLORS.unknown,
    },
  ].filter(d => d.value > 0)

  const barData = [...sites]
    .filter(s => s.responseTime !== null)
    .sort((a, b) => (b.responseTime ?? 0) - (a.responseTime ?? 0))
    .slice(0, 15)
    .map(s => ({
      name: s.name,
      tempo: s.responseTime,
    }))

  const sla = stats.total > 0
    ? ((stats.online / stats.total) * 100).toFixed(1)
    : "0.0"

  const historyDataLocal: Array<{ check: string; avg: number }> = []
  for (let i = 0; i < 10; i++) {
    const times = sites
      .map(s => s.history[i]?.responseTime)
      .filter((t): t is number => t !== null)
    if (times.length > 0) {
      historyDataLocal.unshift({
        check: `#${10 - i}`,
        avg: Math.round(times.reduce((a, b) => a + b, 0) / times.length),
      })
    }
  }

  const dbConfigured = dbSummary && dbSummary.configured === true
  const timelineFromDb =
    dbConfigured && dbSummary.timeline.length > 0
      ? dbSummary.timeline.map(t => ({
          check: t.label,
          avg: t.avgMs,
          label: t.label,
          checks: t.checks,
        }))
      : null

  const historyData = timelineFromDb ?? historyDataLocal.map(h => ({ ...h, label: h.check, checks: 0 }))
  const supabasePeriodLabel =
    dbConfigured && dbSummary ? getAvailabilityWindowLabel(dbSummary.hours) : ""
  const historyTitle = timelineFromDb
    ? `Historico (Supabase · ${supabasePeriodLabel})`
    : "Historico - Tempo Medio"

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 lg:grid-cols-3">
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-medium text-card-foreground">Disponibilidade (agora)</h3>
            <div className="flex items-center gap-1 rounded-md bg-muted px-2 py-1">
              <span className={`text-sm font-bold ${Number(sla) >= 99 ? "text-success" : Number(sla) >= 95 ? "text-warning" : "text-destructive"}`}>
                {sla}%
              </span>
              <span className="text-[10px] text-muted-foreground">SLA</span>
            </div>
          </div>
          <div className="h-48">
            {pieData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={pieData}
                    cx="50%"
                    cy="50%"
                    innerRadius={45}
                    outerRadius={75}
                    dataKey="value"
                    stroke="none"
                  >
                    {pieData.map((entry, index) => (
                      <Cell key={index} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip
                    content={({ active, payload }) => {
                      if (!active || !payload?.length) return null
                      const d = payload[0]
                      return (
                        <div className="rounded-lg border border-[#2a3a31] bg-[#1a2420] px-3 py-2 text-xs text-[#e8ede9] shadow-lg">
                          <p>{d.name}: {String(d.value)}</p>
                        </div>
                      )
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                Nenhum dado disponivel
              </div>
            )}
          </div>
          <div className="mt-2 flex flex-wrap justify-center gap-3">
            {pieData.map((d, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <div className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: d.color }} />
                <span className="text-[10px] text-muted-foreground">{d.name} ({d.value})</span>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-lg border border-border bg-card p-4">
          <h3 className="mb-3 text-sm font-medium text-card-foreground">Tempo de Resposta (ms)</h3>
          <div className="h-56">
            {barData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={barData} layout="vertical" margin={{ left: 0, right: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#2a3a31" horizontal={false} />
                  <XAxis type="number" tick={{ fill: "#8fa898", fontSize: 10 }} axisLine={false} tickLine={false} />
                  <YAxis
                    dataKey="name"
                    type="category"
                    tick={{ fill: "#8fa898", fontSize: 10 }}
                    width={40}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip content={<CustomTooltipContent />} />
                  <Bar
                    dataKey="tempo"
                    name="Tempo"
                    fill="#1F7A4C"
                    radius={[0, 4, 4, 0]}
                    maxBarSize={16}
                  />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                Nenhum dado disponivel
              </div>
            )}
          </div>
        </div>

        <div className="rounded-lg border border-border bg-card p-4">
          <h3 className="mb-3 text-sm font-medium text-card-foreground">{historyTitle}</h3>
          <div className="h-56">
            {historyData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={historyData}>
                  <defs>
                    <linearGradient id="colorAvg" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#1F7A4C" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#1F7A4C" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#2a3a31" />
                  <XAxis dataKey="check" tick={{ fill: "#8fa898", fontSize: 9 }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                  <YAxis tick={{ fill: "#8fa898", fontSize: 10 }} axisLine={false} tickLine={false} />
                  <Tooltip content={timelineFromDb ? <TimelineTooltip /> : <CustomTooltipContent />} />
                  <Area
                    type="monotone"
                    dataKey="avg"
                    name="Media"
                    stroke="#1F7A4C"
                    fill="url(#colorAvg)"
                    strokeWidth={2}
                  />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                {dbLoading
                  ? "Carregando historico..."
                  : dbConfigured
                    ? `Sem registros de tempo de resposta em ${supabasePeriodLabel || "este período"}. Mantenha o app aberto para gravar no Supabase.`
                    : "Execute verificacoes para gerar historico local ou configure o Supabase."}
              </div>
            )}
          </div>
        </div>
      </div>


    </div>
  )
}
