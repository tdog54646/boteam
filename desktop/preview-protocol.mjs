import { protocol } from 'electron'
import { randomUUID } from 'node:crypto'

const MAX_PREVIEWS = 64
const MAX_PREVIEW_BYTES = 8 * 1024 * 1024
const previews = new Map()

export const PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' data: blob:",
  "style-src 'unsafe-inline' data: blob:",
  "img-src data: blob:",
  "media-src data: blob:",
  "font-src data: blob:",
  "worker-src blob: data:",
  "connect-src data: blob:",
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ')

export function registerPreviewScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'boteam-preview',
      privileges: {
        standard: true,
        secure: true,
      },
    },
  ])
}

export function setupPreviewProtocol() {
  protocol.handle('boteam-preview', (request) => {
    let token = ''
    try {
      const url = new URL(request.url)
      if (url.hostname === 'frame') {
        token = url.pathname.split('/').filter(Boolean)[0] || ''
      }
    } catch {}

    const html = token ? previews.get(token) : null
    if (typeof html !== 'string') {
      return new Response('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>', {
        status: 404,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': PREVIEW_CSP,
          'Cache-Control': 'no-store',
        },
      })
    }

    return new Response(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': PREVIEW_CSP,
        'Cache-Control': 'no-store',
      },
    })
  })
}

export function stageHtmlPreview(html) {
  const content = typeof html === 'string' ? html : String(html ?? '')
  if (Buffer.byteLength(content, 'utf8') > MAX_PREVIEW_BYTES) {
    throw new Error('HTML 预览内容超出限制。')
  }
  const token = randomUUID()
  previews.set(token, content)
  while (previews.size > MAX_PREVIEWS) {
    const oldest = previews.keys().next().value
    if (oldest === undefined) break
    previews.delete(oldest)
  }
  return `boteam-preview://frame/${token}/index.html`
}

export function clearHtmlPreviews() {
  previews.clear()
}
