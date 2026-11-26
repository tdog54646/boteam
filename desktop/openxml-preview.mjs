import { inflateRawSync } from 'node:zlib'
import { posix } from 'node:path'
import {
  CODEX_ARCHIVE_EXPANDED_LIMIT,
  CODEX_ARCHIVE_INPUT_LIMIT,
  CODEX_ARCHIVE_MAX_ENTRIES,
  fileExtension,
  mimeForExtension,
} from './file-preview-rules.mjs'

const EOCD_SIGNATURE = 0x06054b50
const CEN_SIGNATURE = 0x02014b50
const LOC_SIGNATURE = 0x04034b50
const MAX_MEDIA_TOTAL = 8 * 1024 * 1024

function decodeXmlEntities(text) {
  if (!text || !text.includes('&')) return text || ''
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (full, entity) => {
    switch (entity) {
      case 'amp': return '&'
      case 'lt': return '<'
      case 'gt': return '>'
      case 'quot': return '"'
      case 'apos': return "'"
      default: {
        const code = entity.startsWith('#x') || entity.startsWith('#X')
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10)
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : full
      }
    }
  })
}

function readZipArchive(bytes) {
  if (bytes.byteLength > CODEX_ARCHIVE_INPUT_LIMIT) {
    throw new Error('压缩文档超出预览大小限制。')
  }
  const minSearch = Math.max(0, bytes.length - 65557)
  let eocdOffset = -1
  for (let i = bytes.length - 22; i >= minSearch; i--) {
    if (bytes.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocdOffset = i
      break
    }
  }
  if (eocdOffset < 0) throw new Error('文档压缩结构已损坏，无法预览。')

  const totalEntries = bytes.readUInt16LE(eocdOffset + 10)
  const centralDirSize = bytes.readUInt32LE(eocdOffset + 12)
  const centralDirOffset = bytes.readUInt32LE(eocdOffset + 16)
  if (totalEntries === 0) throw new Error('文档压缩包为空。')
  if (totalEntries > CODEX_ARCHIVE_MAX_ENTRIES) {
    throw new Error('文档内部条目过多，超出预览上限。')
  }
  if (centralDirOffset + centralDirSize > bytes.length) {
    throw new Error('文档目录索引超出文件范围。')
  }

  const entries = new Map()
  let expandedTotal = 0
  let cursor = centralDirOffset
  for (let idx = 0; idx < totalEntries && cursor + 46 <= centralDirOffset + centralDirSize; idx++) {
    if (bytes.readUInt32LE(cursor) !== CEN_SIGNATURE) break
    const method = bytes.readUInt16LE(cursor + 10)
    const compressedSize = bytes.readUInt32LE(cursor + 20)
    const uncompressedSize = bytes.readUInt32LE(cursor + 24)
    const nameLen = bytes.readUInt16LE(cursor + 28)
    const extraLen = bytes.readUInt16LE(cursor + 30)
    const commentLen = bytes.readUInt16LE(cursor + 32)
    const localHeaderOffset = bytes.readUInt32LE(cursor + 42)
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8').replace(/\\/g, '/')
    cursor += 46 + nameLen + extraLen + commentLen

    expandedTotal += uncompressedSize
    if (!Number.isSafeInteger(expandedTotal) || expandedTotal > CODEX_ARCHIVE_EXPANDED_LIMIT) {
      throw new Error('文档解压体积超出预览安全限制。')
    }
    if (!name || name.endsWith('/') || name.includes('..')) continue
    entries.set(name, { method, compressedSize, uncompressedSize, localHeaderOffset })
  }

  function extractBuffer(name) {
    const entry = entries.get(name)
    if (!entry) return null
    const off = entry.localHeaderOffset
    if (off + 30 > bytes.length || bytes.readUInt32LE(off) !== LOC_SIGNATURE) return null
    const nameLen = bytes.readUInt16LE(off + 26)
    const extraLen = bytes.readUInt16LE(off + 28)
    const dataStart = off + 30 + nameLen + extraLen
    const dataEnd = dataStart + entry.compressedSize
    if (dataEnd > bytes.length) return null
    const slice = bytes.subarray(dataStart, dataEnd)
    if (entry.method === 0) return slice
    if (entry.method === 8) {
      return inflateRawSync(slice, { maxOutputLength: Math.min(entry.uncompressedSize + 1024, 64 * 1024 * 1024) })
    }
    return null
  }

  function extractText(name) {
    const buf = extractBuffer(name)
    return buf ? buf.toString('utf8') : null
  }

  return { entries, extractBuffer, extractText }
}

function parseRelationships(xml, baseDir) {
  const map = new Map()
  if (!xml) return map
  for (const match of xml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const attrs = match[1]
    const id = attrs.match(/\bId="([^"]+)"/)?.[1]
    const target = attrs.match(/\bTarget="([^"]+)"/)?.[1]
    const mode = attrs.match(/\bTargetMode="([^"]+)"/)?.[1]
    if (!id || !target) continue
    if (mode === 'External') {
      map.set(id, { external: true, target: decodeXmlEntities(target) })
    } else {
      const normalized = target.startsWith('/')
        ? target.slice(1)
        : posix.normalize(posix.join(baseDir, target))
      map.set(id, { external: false, target: normalized })
    }
  }
  return map
}

function extractMediaDataUrl(zip, targetPath, mediaBudget) {
  if (!targetPath || mediaBudget.used >= MAX_MEDIA_TOTAL) return null
  const ext = fileExtension(targetPath)
  const mime = mimeForExtension(ext)
  if (!mime || !mime.startsWith('image/') || ext === 'tif' || ext === 'tiff') return null
  const buf = zip.extractBuffer(targetPath)
  if (!buf || !buf.length || mediaBudget.used + buf.length > MAX_MEDIA_TOTAL) return null
  mediaBudget.used += buf.length
  return `data:${mime};base64,${buf.toString('base64')}`
}

function parseDocxParagraph(pXml, rels, zip, mediaBudget) {
  const styleVal = pXml.match(/<w:pStyle\b[^>]*\bw:val="([^"]+)"/i)?.[1] || ''
  let level = 0
  const headingMatch = styleVal.match(/^Heading(\d)$/i) || styleVal.match(/^(\d)$/)
  if (headingMatch) level = Math.min(6, Math.max(1, Number(headingMatch[1])))
  else if (/^Title$/i.test(styleVal)) level = 1
  else if (/^Subtitle$/i.test(styleVal)) level = 2

  const isList = /<w:numPr\b/.test(pXml)
  const listLevel = Number(pXml.match(/<w:ilvl\b[^>]*\bw:val="(\d+)"/)?.[1] || 0)
  const align = pXml.match(/<w:jc\b[^>]*\bw:val="([^"]+)"/)?.[1] || null

  const runs = []
  const images = []
  const tokenRe = /<w:hyperlink\b([^>]*)>([\s\S]*?)<\/w:hyperlink>|<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g
  for (const m of pXml.matchAll(tokenRe)) {
    if (m[1] !== undefined) {
      const rId = m[1].match(/\br:id="([^"]+)"/)?.[1]
      const rel = rId && rels.get(rId)
      const href = rel?.external && /^https?:\/\//i.test(rel.target) ? rel.target : null
      const textParts = [...m[2].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map(t => decodeXmlEntities(t[1]))
      const text = textParts.join('')
      if (text) runs.push({ text, ...(href && { href }) })
      continue
    }
    const rBody = m[3] || ''
    for (const blip of rBody.matchAll(/<a:blip\b[^>]*\br:embed="([^"]+)"/g)) {
      const rel = rels.get(blip[1])
      if (rel && !rel.external) {
        const src = extractMediaDataUrl(zip, rel.target, mediaBudget)
        if (src) images.push(src)
      }
    }
    const bold = /<w:b(?:\s*\/|\s[^>]*>|>)/.test(rBody) && !/<w:b\b[^>]*\bw:val="(?:false|0)"/.test(rBody)
    const italic = /<w:i(?:\s*\/|\s[^>]*>|>)/.test(rBody) && !/<w:i\b[^>]*\bw:val="(?:false|0)"/.test(rBody)
    const underline = /<w:u\b/.test(rBody) && !/<w:u\b[^>]*\bw:val="none"/.test(rBody)
    const strike = /<w:strike(?:\s*\/|\s[^>]*>|>)/.test(rBody) && !/<w:strike\b[^>]*\bw:val="(?:false|0)"/.test(rBody)
    const code = /Consolas|Menlo|Monaco|Courier|Mono/i.test(rBody)
    let text = ''
    for (const piece of rBody.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:(?:br|cr)\b[^>]*\/>/g)) {
      if (piece[1] !== undefined) text += decodeXmlEntities(piece[1])
      else if (piece[0].startsWith('<w:tab')) text += '\t'
      else text += '\n'
    }
    if (text) {
      runs.push({
        text,
        ...(bold && { bold: true }),
        ...(italic && { italic: true }),
        ...(underline && { underline: true }),
        ...(strike && { strike: true }),
        ...(code && { code: true }),
      })
    }
  }

  return {
    type: 'paragraph',
    ...(level > 0 && { level }),
    ...(isList && { list: true, listLevel }),
    ...(align && { align }),
    runs,
    ...(images.length > 0 && { images }),
  }
}

export function parseDocxPreview(bytes) {
  const zip = readZipArchive(bytes)
  const docXml = zip.extractText('word/document.xml')
  if (!docXml) throw new Error('无法读取 Word 文档正文内容。')
  const rels = parseRelationships(zip.extractText('word/_rels/document.xml.rels'), 'word')
  const mediaBudget = { used: 0 }
  const bodyXml = docXml.match(/<w:body\b[^>]*>([\s\S]*?)<\/w:body>/)?.[1] || docXml

  const blocks = []
  const blockRe = /<w:tbl\b[^>]*>([\s\S]*?)<\/w:tbl>|<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g
  for (const match of bodyXml.matchAll(blockRe)) {
    if (blocks.length >= 1200) break
    if (match[1] !== undefined) {
      const rows = []
      for (const tr of match[1].matchAll(/<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g)) {
        if (rows.length >= 200) break
        const cells = []
        for (const tc of tr[1].matchAll(/<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g)) {
          const span = Number(tc[1].match(/<w:gridSpan\b[^>]*\bw:val="(\d+)"/)?.[1] || 1)
          const cellText = [...tc[1].matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)]
            .map(p => [...p[1].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map(t => decodeXmlEntities(t[1])).join(''))
            .filter(Boolean)
            .join('\n')
          cells.push({ text: cellText, ...(span > 1 && { colSpan: span }) })
        }
        if (cells.length) rows.push(cells)
      }
      if (rows.length) blocks.push({ type: 'table', rows })
    } else if (match[2] !== undefined) {
      const para = parseDocxParagraph(match[2], rels, zip, mediaBudget)
      if (para.runs.length || para.images?.length) blocks.push(para)
    }
  }
  return { blocks }
}

function columnLettersToIndex(letters) {
  let col = 0
  for (let i = 0; i < letters.length; i++) {
    col = col * 26 + (letters.charCodeAt(i) - 64)
  }
  return col - 1
}

export function parseDelimitedSheet(text, delimiter = ',') {
  const rows = []
  let row = []
  let cell = ''
  let quoted = false
  let truncatedRows = false
  const limitRows = 1000
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i++
        } else quoted = false
      } else {
        cell += ch
      }
    } else if (ch === '"') {
      quoted = true
    } else if (ch === delimiter) {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      cell = ''
      if (row.length > 1 || row[0] !== '') {
        if (rows.length >= limitRows) {
          truncatedRows = true
          break
        }
        rows.push(row.slice(0, 64))
      }
      row = []
    } else {
      cell += ch
    }
  }
  if (!truncatedRows && (cell !== '' || row.length > 0)) {
    row.push(cell)
    if (rows.length < limitRows) rows.push(row.slice(0, 64))
    else truncatedRows = true
  }
  const colCount = rows.reduce((max, r) => Math.max(max, r.length), 0)
  return {
    sheets: [{ name: 'Sheet1', rows, colCount, totalRows: rows.length, truncatedRows }],
  }
}

export function parseXlsxPreview(bytes) {
  const zip = readZipArchive(bytes)
  const wbXml = zip.extractText('xl/workbook.xml')
  if (!wbXml) throw new Error('无法读取电子表格工作簿结构。')
  const rels = parseRelationships(zip.extractText('xl/_rels/workbook.xml.rels'), 'xl')

  const sharedStrings = []
  const sstXml = zip.extractText('xl/sharedStrings.xml')
  if (sstXml) {
    for (const si of sstXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
      const val = [...si[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
        .map(t => decodeXmlEntities(t[1]))
        .join('')
      sharedStrings.push(val)
    }
  }

  const sheetDefs = []
  for (const s of wbXml.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const attrs = s[1]
    const name = decodeXmlEntities(attrs.match(/\bname="([^"]+)"/)?.[1] || 'Sheet')
    const rId = attrs.match(/\br:id="([^"]+)"/)?.[1]
    const target = (rId && rels.get(rId)?.target) || `xl/worksheets/sheet${sheetDefs.length + 1}.xml`
    sheetDefs.push({ name, target })
  }

  const sheets = []
  for (const def of sheetDefs.slice(0, 24)) {
    const xml = zip.extractText(def.target)
    if (!xml) continue
    const rows = []
    let maxCol = 0
    let totalRows = 0
    let truncatedRows = false
    for (const rowMatch of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
      totalRows++
      if (rows.length >= 1000) {
        truncatedRows = true
        continue
      }
      const cells = []
      let fallbackCol = 0
      for (const cellMatch of rowMatch[2].matchAll(/<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const cAttrs = cellMatch[1]
        const cBody = cellMatch[2] || ''
        const ref = cAttrs.match(/\br="([A-Z]+)\d+"/)?.[1]
        const colIdx = ref ? columnLettersToIndex(ref) : fallbackCol
        fallbackCol = colIdx + 1
        if (colIdx >= 64) continue
        const type = cAttrs.match(/\bt="([^"]+)"/)?.[1] || ''
        let value = ''
        if (type === 'inlineStr') {
          value = [...cBody.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
            .map(t => decodeXmlEntities(t[1]))
            .join('')
        } else {
          const rawV = cBody.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/)?.[1]
          if (rawV !== undefined) {
            if (type === 's') value = sharedStrings[Number(rawV)] ?? ''
            else if (type === 'b') value = rawV === '1' ? 'TRUE' : 'FALSE'
            else value = decodeXmlEntities(rawV)
          }
        }
        while (cells.length <= colIdx) cells.push('')
        cells[colIdx] = value
        if (colIdx + 1 > maxCol) maxCol = colIdx + 1
      }
      rows.push(cells)
    }
    sheets.push({
      name: def.name,
      rows,
      colCount: maxCol,
      totalRows,
      truncatedRows,
    })
  }
  return { sheets }
}

export function parsePptxPreview(bytes) {
  const zip = readZipArchive(bytes)
  const presXml = zip.extractText('ppt/presentation.xml')
  if (!presXml) throw new Error('无法读取演示文稿结构。')
  const presRels = parseRelationships(zip.extractText('ppt/_rels/presentation.xml.rels'), 'ppt')

  const slideTargets = []
  for (const sld of presXml.matchAll(/<p:sldId\b([^>]*)\/?>/g)) {
    const rId = sld[1].match(/\br:id="([^"]+)"/)?.[1]
    const target = rId && presRels.get(rId)?.target
    if (target) slideTargets.push(target)
  }
  if (!slideTargets.length) {
    for (const key of [...zip.entries.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
      if (/^ppt\/slides\/slide\d+\.xml$/i.test(key)) slideTargets.push(key)
    }
  }

  const mediaBudget = { used: 0 }
  const slides = []
  for (const [idx, target] of slideTargets.slice(0, 120).entries()) {
    const xml = zip.extractText(target)
    if (!xml) continue
    const slideName = posix.basename(target)
    const slideDir = posix.dirname(target)
    const rels = parseRelationships(zip.extractText(`${slideDir}/_rels/${slideName}.rels`), slideDir)

    let title = ''
    const items = []
    const tables = []
    const images = []

    for (const sp of xml.matchAll(/<p:sp\b[^>]*>([\s\S]*?)<\/p:sp>/g)) {
      const spBody = sp[1]
      const phType = spBody.match(/<p:ph\b[^>]*\btype="([^"]+)"/)?.[1] || ''
      const isTitle = phType === 'title' || phType === 'ctrTitle'
      for (const aP of spBody.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)) {
        const level = Number(aP[1].match(/<a:pPr\b[^>]*\blvl="(\d+)"/)?.[1] || 0)
        const text = [...aP[1].matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)]
          .map(t => decodeXmlEntities(t[1]))
          .join('')
          .trim()
        if (!text) continue
        if (isTitle && !title) title = text
        else items.push({ text, level })
      }
    }

    for (const tbl of xml.matchAll(/<a:tbl\b[^>]*>([\s\S]*?)<\/a:tbl>/g)) {
      const rows = []
      for (const tr of tbl[1].matchAll(/<a:tr\b[^>]*>([\s\S]*?)<\/a:tr>/g)) {
        const cells = []
        for (const tc of tr[1].matchAll(/<a:tc\b[^>]*>([\s\S]*?)<\/a:tc>/g)) {
          const text = [...tc[1].matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)]
            .map(t => decodeXmlEntities(t[1]))
            .join(' ')
            .trim()
          cells.push(text)
        }
        if (cells.length) rows.push(cells)
      }
      if (rows.length) tables.push(rows)
    }

    for (const blip of xml.matchAll(/<a:blip\b[^>]*\br:embed="([^"]+)"/g)) {
      const rel = rels.get(blip[1])
      if (rel && !rel.external) {
        const src = extractMediaDataUrl(zip, rel.target, mediaBudget)
        if (src) images.push(src)
      }
    }

    slides.push({
      number: idx + 1,
      title: title || `幻灯片 ${idx + 1}`,
      items,
      ...(tables.length > 0 && { tables }),
      ...(images.length > 0 && { images }),
    })
  }
  return { slides }
}
