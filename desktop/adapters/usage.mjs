import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

export function contextUsage(used, limit, model) {
  if (!Number.isSafeInteger(used) || used < 0 || !Number.isSafeInteger(limit) || limit <= 0) return
  return { used, limit, ...(typeof model === 'string' && model && { model }) }
}

export function quotaWindow(minutes, remainingPercent, resetMs) {
  if (
    !Number.isSafeInteger(minutes) ||
    minutes <= 0 ||
    !Number.isFinite(remainingPercent) ||
    remainingPercent < 0 ||
    remainingPercent > 100
  )
    return
  return {
    minutes,
    remainingPercent,
    ...(Number.isSafeInteger(resetMs) &&
      resetMs > 0 &&
      resetMs <= 8.64e15 && { resetsAt: resetMs }),
  }
}

const imageTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

// These paths refer to snapshots staged by the main process. Other attachments
// are still available through the user prompt's compact file manifest.
export function imageSnapshots(attachments = []) {
  return attachments.filter(
    (a) => a && typeof a.path === 'string' && isAbsolute(a.path) && imageTypes.has(a.mimeType),
  )
}

export async function inlineImages(attachments) {
  const images = []
  let bytes = 0
  for (const { path, mimeType } of imageSnapshots(attachments)) {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const info = await file.stat()
      if (
        !info.isFile() ||
        !info.size ||
        info.size > 5 * 1024 * 1024 ||
        bytes + info.size > 15 * 1024 * 1024
      )
        continue
      images.push({ type: 'image', mimeType, data: await file.readFile('base64') })
      bytes += info.size
    } finally {
      await file.close()
    }
  }
  return images
}
