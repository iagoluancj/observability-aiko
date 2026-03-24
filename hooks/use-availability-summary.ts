"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import type { AvailabilitySummaryResponse } from "@/lib/availability-summary-types"
import { availabilitySummaryStableEqual } from "@/lib/availability-summary-compare"
import { createLogger } from "@/lib/logger"

const log = createLogger("useAvailabilitySummary")

/** Atualização em segundo plano do resumo (logs esparsos / outras abas), sem amarrar ao polling da tabela. */
const SUMMARY_BACKGROUND_MS = 120_000

export function useAvailabilitySummary(
  externalIds: string[],
  /** Incrementa quando a tabela mudou status/HTTP/tempo — evita refetch a cada poll inútil. */
  refreshNonce: number,
  windowHours: number,
) {
  const [data, setData] = useState<AvailabilitySummaryResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const dataRef = useRef<AvailabilitySummaryResponse | null>(null)

  useEffect(() => {
    dataRef.current = data
  }, [data])

  const idsKey = externalIds.join("\0")
  const hoursKey = String(windowHours)
  const externalIdsRef = useRef(externalIds)
  externalIdsRef.current = externalIds

  useEffect(() => {
    setData(null)
    if (externalIds.length > 0) setLoading(true)
  }, [idsKey, hoursKey, externalIds.length])

  const load = useCallback(async () => {
    const ids = externalIdsRef.current
    if (ids.length === 0) {
      setData(null)
      setLoading(false)
      return
    }

    const showSpinner = dataRef.current === null
    if (showSpinner) setLoading(true)

    try {
      const params = new URLSearchParams({
        hours: String(windowHours),
        ids: ids.join(","),
      })
      const res = await fetch(`/api/availability/summary?${params}`)
      const json = (await res.json()) as AvailabilitySummaryResponse
      setData(prev => (availabilitySummaryStableEqual(prev, json) ? prev : json))
      if (!res.ok) {
        log.warn("Resumo Supabase com erro HTTP", { status: res.status })
      }
    } catch {
      log.warn("Falha de rede ao carregar resumo Supabase")
      setData({ configured: false })
    } finally {
      setLoading(false)
    }
  }, [idsKey, hoursKey, refreshNonce, windowHours])

  useEffect(() => {
    void load()
  }, [load])

  const loadRef = useRef(load)
  loadRef.current = load

  useEffect(() => {
    if (externalIds.length === 0) return
    const t = setInterval(() => void loadRef.current(), SUMMARY_BACKGROUND_MS)
    return () => clearInterval(t)
  }, [idsKey, externalIds.length])

  return { data, loading, reload: load }
}
