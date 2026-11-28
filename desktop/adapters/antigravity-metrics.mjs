import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { uuid } from './antigravity-profile.mjs'
import { disjointTurnMetrics } from './usage.mjs'
import { antigravityLocationReason } from './antigravity-errors.mjs'

const maxTranscriptBytes = 8 * 1024 * 1024
const plannerStepType = 15

async function verifiedOwnedFile(filePath) {
  const info = await lstat(filePath)
  if (
    !info.isFile() ||
    info.nlink !== 1 ||
    info.uid !== process.getuid?.() ||
    (await realpath(filePath)) !== filePath
  ) {
    throw new Error('Unexpected native telemetry path')
  }
  return info
}

async function resolveCliDir(home) {
  const profile = await lstat(home)
  if (!profile.isDirectory() || profile.uid !== process.getuid?.() || profile.mode & 0o077) {
    throw new Error('Unexpected native profile')
  }
  return join(await realpath(home), '.gemini', 'antigravity-cli')
}

function decodeVarint(buf, offset) {
  let result = 0n
  let shift = 0n
  let pos = offset
  while (pos < buf.length) {
    const byte = BigInt(buf[pos++])
    result |= (byte & 0x7fn) << shift
    if ((byte & 0x80n) === 0n) return { value: Number(result), next: pos }
    shift += 7n
    if (shift > 70n) break
  }
  return null
}

function parseProtoFields(buf) {
  const fields = {}
  let pos = 0
  while (pos < buf.length) {
    const tag = decodeVarint(buf, pos)
    if (!tag || tag.value === 0) break
    pos = tag.next
    const field = tag.value >> 3
    const wire = tag.value & 7
    if (wire === 0) {
      const v = decodeVarint(buf, pos)
      if (!v) break
      pos = v.next
      fields[field] = v.value
    } else if (wire === 1) {
      if (pos + 8 > buf.length) break
      pos += 8
    } else if (wire === 5) {
      if (pos + 4 > buf.length) break
      pos += 4
    } else if (wire === 2) {
      const len = decodeVarint(buf, pos)
      if (!len || len.next + len.value > buf.length) break
      pos = len.next
      fields[field] = buf.subarray(pos, pos + len.value)
      pos += len.value
    } else {
      break
    }
  }
  return fields
}

function protoTimestampMs(buf) {
  if (!Buffer.isBuffer(buf) && !(buf instanceof Uint8Array)) return null
  const fields = parseProtoFields(Buffer.from(buf))
  if (!Number.isSafeInteger(fields[1]) || fields[1] <= 0) return null
  const nanos = Number.isSafeInteger(fields[2]) && fields[2] >= 0 ? fields[2] : 0
  return fields[1] * 1000 + Math.round(nanos / 1e6)
}

async function openConversationDb(directory, sessionId) {
  const dbPath = join(directory, 'conversations', sessionId + '.db')
  await verifiedOwnedFile(dbPath)
  for (const suffix of ['-wal', '-shm', '-journal']) {
    await verifiedOwnedFile(dbPath + suffix).catch((err) => {
      if (err.code !== 'ENOENT') throw err
    })
  }
  return new DatabaseSync(dbPath, { readOnly: true })
}

export async function readAntigravityStepWatermark(home, sessionId) {
  if (!uuid.test(sessionId)) return -1
  try {
    const directory = await resolveCliDir(home)
    const db = await openConversationDb(directory, sessionId)
    try {
      const row = db.prepare('SELECT max(idx) AS maxIdx FROM steps').get()
      return Number.isSafeInteger(row?.maxIdx) ? row.maxIdx : -1
    } finally {
      db.close()
    }
  } catch {
    return -1
  }
}

// agy stores a provider refusal in an ERROR_MESSAGE step (17), while a model
// quoting the identical diagnostic writes it in a PLANNER_RESPONSE step (15).
export async function readAntigravityLocationFailure(home, sessionId, afterIdx) {
  if (!uuid.test(sessionId)) return
  let db
  try {
    db = await openConversationDb(await resolveCliDir(home), sessionId)
    const row = db.prepare(`SELECT step_type, instr(step_payload, CAST(? AS BLOB)) AS hasReason
      FROM steps WHERE idx > ? AND step_type IN (14,15,17) ORDER BY idx DESC LIMIT 1`).get(antigravityLocationReason, afterIdx)
    if (row?.hasReason) {
      if (row.step_type === 17) return true
      if (row.step_type === plannerStepType) return false
    }
  } catch { /* The native archive may still be flushing, or may use a different schema. */ }
  finally { db?.close() }
}

async function readTranscriptPlannerSteps(directory, sessionId, afterIdx) {
  const trPath = join(directory, 'brain', sessionId, '.system_generated', 'logs', 'transcript.jsonl')
  let file
  try {
    const expected = await verifiedOwnedFile(trPath)
    if (expected.size > maxTranscriptBytes) return []
    file = await open(trPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const current = await file.stat()
    if (
      current.dev !== expected.dev ||
      current.ino !== expected.ino ||
      current.nlink !== 1 ||
      current.size > maxTranscriptBytes ||
      !current.isFile()
    ) {
      return []
    }
    const buffer = Buffer.alloc(current.size)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    return buffer
      .toString('utf8', 0, bytesRead)
      .split('\n')
      .flatMap((line) => {
        try {
          const step = JSON.parse(line)
          return step?.type === 'PLANNER_RESPONSE' &&
            Number.isSafeInteger(step.step_index) &&
            step.step_index > afterIdx
            ? [step]
            : []
        } catch {
          return []
        }
      })
  } catch {
    return []
  } finally {
    await file?.close().catch(() => {})
  }
}

export async function readAntigravityTurnMetrics(
  home,
  sessionId,
  afterIdx = -1,
  fallbackDurationMs = 0,
  fallbackModel = '',
) {
  if (!uuid.test(sessionId)) return
  try {
    const directory = await resolveCliDir(home)
    let uncachedInputTokens = 0
    let cachedInputTokens = 0
    let cacheCreationTokens = 0
    let outputTokens = 0
    let reasoningTokens = 0
    let durationMs = 0
    let model = fallbackModel || ''
    let matchedSteps = 0

    try {
      const db = await openConversationDb(directory, sessionId)
      try {
        const rows = db
          .prepare(
            'SELECT idx, metadata FROM steps WHERE idx > ? AND step_type = ? AND metadata IS NOT NULL ORDER BY idx',
          )
          .all(afterIdx, plannerStepType)
        for (const row of rows) {
          const meta = parseProtoFields(Buffer.from(row.metadata))
          const usageBuf = meta[9]
          const usage =
            Buffer.isBuffer(usageBuf) || usageBuf instanceof Uint8Array
              ? parseProtoFields(Buffer.from(usageBuf))
              : {}
          const stepIn = Number.isSafeInteger(usage[2]) ? usage[2] : 0
          const stepOut = Number.isSafeInteger(usage[3]) ? usage[3] : 0
          const stepCreate = Number.isSafeInteger(usage[4]) ? usage[4] : 0
          const stepCache = Number.isSafeInteger(usage[5]) ? usage[5] : 0
          const stepThink = Number.isSafeInteger(usage[10]) ? usage[10] : 0
          if (stepIn > 0 || stepOut > 0 || stepCache > 0 || stepCreate > 0) {
            uncachedInputTokens += stepIn
            outputTokens += stepOut
            cacheCreationTokens += stepCreate
            cachedInputTokens += stepCache
            reasoningTokens += stepThink
            matchedSteps++
          }
          const startMs = protoTimestampMs(meta[1])
          const endMs = protoTimestampMs(meta[7])
          if (startMs !== null && endMs !== null && endMs > startMs) {
            durationMs += endMs - startMs
          }
        }
      } finally {
        db.close()
      }
    } catch {
      // Native conversation SQLite may be unavailable in older builds; check transcript.jsonl next.
    }

    const transcriptSteps = await readTranscriptPlannerSteps(directory, sessionId, afterIdx)
    for (const step of transcriptSteps) {
      if (!model && typeof step.model === 'string' && step.model) model = step.model
    }
    if (matchedSteps === 0 && transcriptSteps.length > 0) {
      for (const step of transcriptSteps) {
        uncachedInputTokens += Number.isSafeInteger(step.input_tokens) ? step.input_tokens : 0
        cachedInputTokens += Number.isSafeInteger(step.cache_read_tokens) ? step.cache_read_tokens : 0
        cacheCreationTokens += Number.isSafeInteger(step.cache_creation_tokens)
          ? step.cache_creation_tokens
          : 0
        outputTokens += Number.isSafeInteger(step.output_tokens) ? step.output_tokens : 0
      }
    }

    return disjointTurnMetrics({
      uncachedInputTokens,
      cachedInputTokens,
      cacheCreationTokens,
      outputTokens,
      reasoningTokens,
      durationMs: durationMs > 0 ? durationMs : fallbackDurationMs,
      model: fallbackModel || model,
    })
  } catch {
    return
  }
}

export function usageUpdateMetrics(update, durationMs, model) {
  if (!update || typeof update !== 'object') return
  const meta = update._meta && typeof update._meta === 'object' ? update._meta : update
  const uncached =
    meta.uncachedInputTokens ?? meta.input_tokens ?? meta.inputTokens
  const cached =
    meta.cachedInputTokens ?? meta.cache_read_tokens ?? meta.cacheReadInputTokens ?? meta.cachedTokens
  const created =
    meta.cacheCreationTokens ?? meta.cache_creation_tokens ?? meta.cacheCreationInputTokens ?? 0
  const output = meta.outputTokens ?? meta.output_tokens
  const reasoning = meta.reasoningTokens ?? meta.thinking_tokens ?? meta.reasoningOutputTokens ?? 0
  if (!Number.isSafeInteger(uncached) && !Number.isSafeInteger(output) && !Number.isSafeInteger(cached)) {
    return
  }
  return disjointTurnMetrics({
    uncachedInputTokens: uncached || 0,
    cachedInputTokens: cached || 0,
    cacheCreationTokens: created || 0,
    outputTokens: output || 0,
    reasoningTokens: reasoning || 0,
    durationMs: Number.isSafeInteger(meta.durationMs) && meta.durationMs > 0 ? meta.durationMs : durationMs,
    model,
  })
}
