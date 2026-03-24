export interface SiteIdentityInput {
  name: string
  url: string
}

function normalizeName(name: string): string {
  const collapsed = name.trim().toLowerCase().replace(/\s+/g, " ")
  const ascii = collapsed.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  return ascii
}

function normalizeUrl(url: string): string {
  const raw = url.trim()
  if (!raw) return ""
  try {
    const parsed = new URL(raw)
    const host = parsed.hostname.toLowerCase()
    const pathname = parsed.pathname.replace(/\/+$/, "").toLowerCase() || "/"
    return `${host}${pathname}`
  } catch {
    return raw.toLowerCase()
  }
}

function slugifyName(name: string): string {
  const slug = normalizeName(name)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug || "site"
}

function fnv1a32(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash +=
      (hash << 1) +
      (hash << 4) +
      (hash << 7) +
      (hash << 8) +
      (hash << 24)
  }
  return hash >>> 0
}

/**
 * Chave estável para correlacionar o mesmo site em diferentes máquinas/importações.
 * Usa nome normalizado + host/path da URL (ignora querystring para reduzir ruído).
 */
export function buildSiteIdentityKey(site: SiteIdentityInput): string {
  return `${normalizeName(site.name)}|${normalizeUrl(site.url)}`
}

/**
 * External ID determinístico para persistência no Supabase.
 * Mantém um slug legível + hash curto da identidade.
 */
export function buildStableSiteExternalId(site: SiteIdentityInput): string {
  const slug = slugifyName(site.name).slice(0, 40)
  const hash = fnv1a32(buildSiteIdentityKey(site)).toString(36)
  return `site-${slug}-${hash}`
}
