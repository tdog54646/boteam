import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

const inputOverflow = [
  /\b(?:prompt|input)(?: (?:text|size|length))? (?:is |was )?too (?:long|large)\b/i,
  /\b(?:context (?:length|window)|(?:input|prompt) token limit)(?: has been| was| is)? (?:exceeded|exhausted|full)\b/i,
  /\bexceed(?:s|ed)? (?:the |its )?(?:model['’]s )?(?:maximum |max )?context (?:length|window)\b/i,
  /\bmaximum context length is [\d,]+ tokens\b/i,
  /\binput token count\b[^\n]{0,80}\bexceeds? the maximum number of tokens\b/i,
]

export function inputWindowError(message, nativeCode) {
  const text = typeof message === 'string' ? message.replace(/[_-]/g, ' ') : ''
  const rateLimit = /\brate limit|\bquota\b|\bper (?:second|minute|hour|day)\b|\btpm\b/i.test(text)
  if (nativeCode === 'contextWindowExceeded' || (!rateLimit && inputOverflow.some(pattern => pattern.test(text)))) {
    return new Error('本次输入超过模型的上下文窗口，请缩短问题、引用或附件内容后重试。')
  }
}

export function contextUsage(used, limit, model) {
  if (!Number.isSafeInteger(used) || used < 0 || !Number.isSafeInteger(limit) || limit <= 0) return
  return { used, limit, ...(typeof model === 'string' && model && { model }) }
}

function nonNegativeInt(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

export function turnMetrics({
  totalInputTokens = 0,
  cachedInputTokens = 0,
  cacheCreationTokens = 0,
  outputTokens = 0,
  reasoningTokens = 0,
  durationMs = 0,
  model,
} = {}) {
  const cached = nonNegativeInt(cachedInputTokens)
  const created = nonNegativeInt(cacheCreationTokens)
  const input = Math.max(nonNegativeInt(totalInputTokens), cached + created)
  const output = nonNegativeInt(outputTokens)
  const reasoning = Math.min(nonNegativeInt(reasoningTokens), output || nonNegativeInt(reasoningTokens))
  const duration = nonNegativeInt(durationMs)
  if (input <= 0 && output <= 0) return
  const tokensPerSecond =
    output > 0 && duration > 0 ? Math.round((output / (duration / 1000)) * 10) / 10 : null
  const cacheHitPercent =
    input > 0 ? Math.round((cached / input) * 1000) / 10 : null
  return {
    inputTokens: input,
    cachedInputTokens: cached,
    cacheCreationTokens: created,
    outputTokens: output,
    reasoningTokens: reasoning,
    durationMs: duration,
    tokensPerSecond,
    cacheHitPercent,
    ...(typeof model === 'string' && model && { model }),
  }
}

// OpenAI / Codex TokenUsageBreakdown: inputTokens includes cachedInputTokens
// unless totalTokens proves the breakdown was reported in disjoint buckets.
export function inclusiveTurnMetrics(breakdown, durationMs, model) {
  if (
    !breakdown ||
    (!Number.isSafeInteger(breakdown.inputTokens) && !Number.isSafeInteger(breakdown.outputTokens))
  )
    return
  const rawInput = nonNegativeInt(breakdown.inputTokens)
  const cached = nonNegativeInt(breakdown.cachedInputTokens)
  const created = nonNegativeInt(breakdown.cacheWriteInputTokens)
  const output = nonNegativeInt(breakdown.outputTokens)
  const reasoning = nonNegativeInt(breakdown.reasoningOutputTokens)
  const total = nonNegativeInt(breakdown.totalTokens)
  const disjoint = cached > 0 && total >= rawInput + cached + output && rawInput + output < total
  const totalInputTokens = disjoint ? rawInput + cached + created : Math.max(rawInput, cached + created)
  return turnMetrics({
    totalInputTokens,
    cachedInputTokens: cached,
    cacheCreationTokens: created,
    outputTokens: output,
    reasoningTokens: reasoning,
    durationMs,
    model,
  })
}

// Anthropic / Antigravity ModelUsageStats: uncached input, cache creation,
// and cache read tokens are reported as disjoint buckets.
export function disjointTurnMetrics(
  {
    uncachedInputTokens = 0,
    cachedInputTokens = 0,
    cacheCreationTokens = 0,
    outputTokens = 0,
    reasoningTokens = 0,
    durationMs = 0,
    model,
  } = {},
) {
  const uncached = nonNegativeInt(uncachedInputTokens)
  const cached = nonNegativeInt(cachedInputTokens)
  const created = nonNegativeInt(cacheCreationTokens)
  return turnMetrics({
    totalInputTokens: uncached + cached + created,
    cachedInputTokens: cached,
    cacheCreationTokens: created,
    outputTokens,
    reasoningTokens,
    durationMs,
    model,
  })
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
