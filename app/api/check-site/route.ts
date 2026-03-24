import { NextRequest, NextResponse } from "next/server"
import { createLogger } from "@/lib/logger"
import { checkUrl } from "@/lib/check-url"
import { deriveSiteCheckFromUrlResult } from "@/lib/derive-site-check"

const log = createLogger("api:check-site")

// Contador global de requisições (reinicia por processo/servidor)
let requestCount = 0
let lastRequestTime = 0

export async function POST(request: NextRequest) {
  const now = Date.now()
  const timeSinceLast = lastRequestTime > 0 ? now - lastRequestTime : 0
  requestCount++
  lastRequestTime = now

  const { url } = await request.json()

  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  log.info("Requisição recebida", { requestId, url, totalRequests: requestCount, timeSinceLastMs: timeSinceLast })

  if (!url || typeof url !== "string") {
    log.warn("URL inválida recebida", { requestId, url })
    return NextResponse.json({ error: "URL is required" }, { status: 400 })
  }

  const startTime = Date.now()

  try {
    const result = await checkUrl(url)
    const payload = deriveSiteCheckFromUrlResult(result, Date.now() - startTime)
    return NextResponse.json(payload)
  } catch (error: unknown) {
    const responseTime = Date.now() - startTime

    log.error("Erro ao checar site", {
      requestId,
      url,
      error: error instanceof Error ? error.message : String(error),
      responseTime,
    })

    return NextResponse.json(
      {
        status: "offline",
        httpCode: 0,
        responseTime,
        timestamp: new Date().toISOString(),
      },
      { status: 500 },
    )
  }
}
