/** Presets de janela para agregados do Supabase (horas = duração retroativa). */
export const AVAILABILITY_WINDOW_PRESETS = [
  { hours: 24, label: "24 horas" },
  { hours: 48, label: "2 dias" },
  { hours: 72, label: "3 dias" },
  { hours: 168, label: "1 semana" },
  { hours: 720, label: "30 dias (≈1 mês)" },
] as const

export type AvailabilityWindowPreset = (typeof AVAILABILITY_WINDOW_PRESETS)[number]

const MAX_API_HOURS = 720

export function clampAvailabilityHours(h: number): number {
  if (!Number.isFinite(h)) return 24
  return Math.min(MAX_API_HOURS, Math.max(1, Math.floor(h)))
}

export function getAvailabilityWindowLabel(hours: number): string {
  const preset = AVAILABILITY_WINDOW_PRESETS.find(p => p.hours === hours)
  return preset?.label ?? `${hours} h`
}
