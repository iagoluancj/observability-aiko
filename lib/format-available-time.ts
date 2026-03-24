/**
 * Formata minutos como "Xh Ym" (pt-BR).
 */
export function formatAvailableMinutes(minutes: number): string {
  const m = Math.max(0, Math.round(minutes))
  const h = Math.floor(m / 60)
  const rest = m % 60
  if (h === 0) return `${rest}m`
  return `${h}h ${rest.toString().padStart(2, "0")}m`
}
