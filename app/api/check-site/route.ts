import { NextRequest, NextResponse } from "next/server"
import { createLogger } from "@/lib/logger"
import { checkUrl } from "@/lib/check-url"
import { deriveSiteCheckFromUrlResult } from "@/lib/derive-site-check"

const log = createLogger("api:check-site")

export async function POST(request: NextRequest) {
  const { url } = await request.json()

  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  log.info("Requisição recebida", { requestId, url })

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
