"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { createLogger } from "@/lib/logger"

const log = createLogger("useAvailabilityHealth")
const HEALTH_BACKGROUND_MS = 120_000

export interface AvailabilityHealthResponse {
  configured: boolean
  healthy: boolean
  expectedIntervalMs: number
  maxCarryForwardMs: number
  staleAfterMs: number
  coverageWindowHours: number
  coveragePct: number
  gapCount: number
  largestGapMs: number
  lastRunAt: string | null
  staleNow: boolean
  staleForMs: number | null
  runsInWindow: number
}

export function useAvailabilityHealth(enabled: boolean) {
  const [data, setData] = useState<AvailabilityHealthResponse | null>(null)
  const [loading, setLoading] = useState(enabled)
  const loadRef = useRef<() => Promise<void>>(async () => {})

  const load = useCallback(async () => {
    if (!enabled) {
      setData(null)
      setLoading(false)
      return
    }

    if (!data) setLoading(true)
    try {
      const res = await fetch("/api/availability/health")
      const json = (await res.json()) as AvailabilityHealthResponse
      setData(json)
      if (!res.ok) {
        log.warn("Health de disponibilidade retornou erro HTTP", { status: res.status })
      }
    } catch {
      log.warn("Falha de rede ao carregar health de disponibilidade")
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [enabled, data])

  loadRef.current = load

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!enabled) return
    const t = setInterval(() => void loadRef.current(), HEALTH_BACKGROUND_MS)
    return () => clearInterval(t)
  }, [enabled])

  return { data, loading, reload: load }
}
