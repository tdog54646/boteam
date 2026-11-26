// Codex file preview classification, format rules, and byte limits (aligned with Codex desktop 26.1111+).

export const CODEX_EDITOR_LIMIT = 0x100000 // 1 MiB (editable text & .tex preview limit)
export const CODEX_TEX_PREVIEW_LIMIT = 0x100000 // 1 MiB
export const CODEX_TEXT_SAMPLE_LIMIT = 0xa00000 // 10 MiB (smHt.RP)
export const CODEX_PREVIEW_FILE_LIMIT = 0x2800000 // 40 MiB (smHt.dC)
export const CODEX_ARCHIVE_INPUT_LIMIT = 0x8000000 // 128 MiB (TVwl.h)
export const CODEX_ARCHIVE_MAX_ENTRIES = 10_000
export const CODEX_ARCHIVE_EXPANDED_LIMIT = 0x20000000 // 512 MiB
export const CODEX_DIFF_CHANGED_BYTES_LIMIT = 3_145_728 // 3 MiB
export const CODEX_DIFF_LINE_BYTES_LIMIT = 1_048_576 // 1 MiB
export const CODEX_DIFF_MAX_LINES = 15_000
export const CODEX_THUMBNAIL_MAX_SIZE = 352

const markdownExts = new Set(['md', 'markdown', 'mdown', 'mdx', 'mkd'])
const htmlExts = new Set(['html', 'htm', 'xhtml'])
const rasterImageExts = new Set(['avif', 'bmp', 'gif', 'ico', 'jpeg', 'jpg', 'png', 'webp'])
const tiffExts = new Set(['tif', 'tiff'])
const audioExts = new Set(['aac', 'flac', 'm4a', 'mp3', 'mp4a', 'oga', 'ogg', 'opus', 'wav'])
const videoExts = new Set(['mp4', 'ogv', 'webm'])
const spreadsheetExts = new Map([
  ['csv', 'csv'],
  ['tsv', 'tsv'],
  ['xlsx', 'xlsx'],
  ['xlsm', 'xlsx'],
])
const mermaidExts = new Set(['mmd', 'mermaid'])

const codeLanguageByExt = new Map([
  ['ts', 'typescript'], ['cts', 'typescript'], ['mts', 'typescript'],
  ['tsx', 'tsx'],
  ['js', 'javascript'], ['cjs', 'javascript'], ['mjs', 'javascript'], ['es6', 'javascript'],
  ['jsx', 'jsx'],
  ['json', 'json'], ['jsonc', 'jsonc'], ['json5', 'json'], ['jsonl', 'jsonl'], ['ndjson', 'jsonl'], ['webmanifest', 'json'],
  ['py', 'python'], ['pyi', 'python'], ['cpy', 'python'],
  ['go', 'go'],
  ['rs', 'rust'],
  ['java', 'java'],
  ['kt', 'kotlin'], ['kts', 'kotlin'],
  ['c', 'c'], ['h', 'c'],
  ['cc', 'cpp'], ['cpp', 'cpp'], ['cxx', 'cpp'], ['ccm', 'cpp'], ['cppm', 'cpp'], ['hpp', 'cpp'], ['hxx', 'cpp'],
  ['cs', 'csharp'], ['csx', 'csharp'], ['cake', 'csharp'],
  ['swift', 'swift'],
  ['rb', 'ruby'],
  ['php', 'php'],
  ['lua', 'lua'],
  ['r', 'r'],
  ['sql', 'sql'], ['dsql', 'sql'],
  ['sh', 'bash'], ['bash', 'bash'], ['zsh', 'bash'], ['fish', 'bash'], ['envrc', 'bash'],
  ['ps1', 'powershell'],
  ['bat', 'bat'], ['cmd', 'bat'],
  ['css', 'css'], ['scss', 'scss'], ['sass', 'sass'], ['less', 'less'],
  ['xml', 'xml'], ['plist', 'xml'], ['xsd', 'xml'], ['xsl', 'xml'],
  ['yml', 'yaml'], ['yaml', 'yaml'], ['eyaml', 'yaml'],
  ['toml', 'toml'],
  ['ini', 'ini'], ['cfg', 'ini'], ['conf', 'ini'], ['properties', 'ini'],
  ['dockerfile', 'dockerfile'], ['containerfile', 'dockerfile'],
  ['cmake', 'cmake'], ['mk', 'makefile'],
  ['proto', 'protobuf'],
  ['graphql', 'graphql'], ['gql', 'graphql'],
  ['vue', 'vue'], ['svelte', 'svelte'], ['astro', 'astro'],
  ['zig', 'zig'], ['scala', 'scala'], ['dart', 'dart'],
  ['ex', 'elixir'], ['exs', 'elixir'], ['erl', 'erlang'],
  ['hs', 'haskell'], ['clj', 'clojure'], ['cljs', 'clojure'],
  ['diff', 'diff'], ['patch', 'diff'],
  ['log', 'text'], ['txt', 'text'],
])

const specialFilenameLanguage = new Map([
  ['makefile', 'makefile'], ['gnumakefile', 'makefile'], ['ocamlmakefile', 'makefile'],
  ['dockerfile', 'dockerfile'], ['containerfile', 'dockerfile'],
  ['cmakelists.txt', 'cmake'],
  ['gemfile', 'ruby'], ['rakefile', 'ruby'], ['podfile', 'ruby'], ['brewfile', 'ruby'], ['fastfile', 'ruby'], ['vagrantfile', 'ruby'],
  ['jenkinsfile', 'groovy'],
  ['codeowners', 'text'],
  ['.gitignore', 'ini'], ['.gitattributes', 'ini'], ['.dockerignore', 'ini'], ['.npmignore', 'ini'], ['.editorconfig', 'ini'],
  ['.bashrc', 'bash'], ['.bash_profile', 'bash'], ['.zshrc', 'bash'], ['.zprofile', 'bash'], ['.zshenv', 'bash'], ['.profile', 'bash'],
  ['.babelrc', 'jsonc'], ['.eslintrc', 'jsonc'], ['.prettierrc', 'jsonc'], ['.swcrc', 'jsonc'],
  ['tsconfig.json', 'jsonc'], ['jsconfig.json', 'jsonc'], ['devcontainer.json', 'jsonc'],
])

const mimeByExt = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['avif', 'image/avif'],
  ['bmp', 'image/bmp'],
  ['ico', 'image/x-icon'],
  ['svg', 'image/svg+xml'],
  ['tif', 'image/tiff'],
  ['tiff', 'image/tiff'],
  ['pdf', 'application/pdf'],
  ['mp3', 'audio/mpeg'],
  ['wav', 'audio/wav'],
  ['ogg', 'audio/ogg'],
  ['oga', 'audio/ogg'],
  ['opus', 'audio/opus'],
  ['m4a', 'audio/mp4'],
  ['mp4a', 'audio/mp4'],
  ['aac', 'audio/aac'],
  ['flac', 'audio/flac'],
  ['mp4', 'video/mp4'],
  ['webm', 'video/webm'],
  ['ogv', 'video/ogg'],
])

export function fileBasename(filePath) {
  const raw = String(filePath || '')
  const idx = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\'))
  return idx >= 0 ? raw.slice(idx + 1) : raw
}

export function fileExtension(filePath) {
  const base = fileBasename(filePath).toLowerCase().replace(/ \(\d+\)$/u, '')
  const dot = base.lastIndexOf('.')
  return dot > 0 && dot < base.length - 1 ? base.slice(dot + 1) : null
}

export function mimeForExtension(ext) {
  return ext ? mimeByExt.get(ext.toLowerCase()) || null : null
}

export function formatByteLimit(bytes) {
  if (bytes >= 1024 * 1024) {
    const mb = bytes / (1024 * 1024)
    return (Number.isInteger(mb) ? String(mb) : mb.toFixed(1)) + ' MB'
  }
  if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB'
  return bytes + ' B'
}

export function classifyPreviewFile(filePath) {
  const base = fileBasename(filePath)
  const lower = base.toLowerCase()
  const ext = fileExtension(base)

  if (lower.endsWith('.wasm')) {
    return {
      previewKind: 'binary',
      category: 'binary',
      subtitle: 'WebAssembly 二进制文件',
      renderable: false,
      mode: 'none',
      maxBytes: 0,
    }
  }

  if (lower.endsWith('.agent.md') || lower.endsWith('.chatmode.md') || (ext && markdownExts.has(ext))) {
    return {
      previewKind: 'markdown',
      category: 'document',
      language: 'markdown',
      subtitle: 'Markdown 文档',
      renderable: true,
      mode: 'toggle',
      editable: true,
      maxBytes: CODEX_TEXT_SAMPLE_LIMIT,
      editableMaxBytes: CODEX_EDITOR_LIMIT,
    }
  }

  if (ext && htmlExts.has(ext)) {
    return {
      previewKind: 'html',
      category: 'html',
      language: 'html',
      subtitle: '网页预览',
      renderable: true,
      mode: 'toggle',
      maxBytes: CODEX_TEXT_SAMPLE_LIMIT,
    }
  }

  if (ext === 'svg') {
    return {
      previewKind: 'svg',
      category: 'image',
      language: 'xml',
      mime: 'image/svg+xml',
      subtitle: 'SVG 矢量图形',
      renderable: true,
      mode: 'toggle',
      maxBytes: CODEX_TEXT_SAMPLE_LIMIT,
    }
  }

  if (ext && rasterImageExts.has(ext)) {
    return {
      previewKind: 'image',
      category: 'image',
      mime: mimeForExtension(ext),
      subtitle: ext.toUpperCase() + ' 图片',
      renderable: true,
      mode: 'always',
      maxBytes: CODEX_PREVIEW_FILE_LIMIT,
    }
  }

  if (ext && tiffExts.has(ext)) {
    return {
      previewKind: 'image',
      category: 'image',
      mime: mimeForExtension(ext),
      tiff: true,
      subtitle: 'TIFF 图片',
      renderable: true,
      mode: 'always',
      maxBytes: CODEX_PREVIEW_FILE_LIMIT,
    }
  }

  if (ext === 'pdf') {
    return {
      previewKind: 'pdf',
      importKind: 'pdf',
      artifactType: 'pdf',
      category: 'pdf',
      mime: 'application/pdf',
      subtitle: 'PDF 文档',
      renderable: true,
      mode: 'always',
      maxBytes: CODEX_PREVIEW_FILE_LIMIT,
    }
  }

  if (ext && spreadsheetExts.has(ext)) {
    const importKind = spreadsheetExts.get(ext)
    const isTextSheet = importKind === 'csv' || importKind === 'tsv'
    return {
      previewKind: 'spreadsheet',
      importKind,
      artifactType: 'spreadsheet',
      category: 'spreadsheet',
      language: isTextSheet ? importKind : undefined,
      subtitle: importKind === 'xlsx' ? '电子表格' : importKind.toUpperCase() + ' 表格',
      renderable: true,
      mode: isTextSheet ? 'toggle' : 'always',
      maxBytes: CODEX_PREVIEW_FILE_LIMIT,
    }
  }

  if (ext === 'docx') {
    return {
      previewKind: 'docx',
      importKind: 'docx',
      artifactType: 'document',
      category: 'word-document',
      subtitle: 'Word 文档',
      renderable: true,
      mode: 'always',
      maxBytes: CODEX_PREVIEW_FILE_LIMIT,
    }
  }

  if (ext === 'pptx') {
    return {
      previewKind: 'pptx',
      importKind: 'pptx',
      artifactType: 'slides',
      category: 'presentation',
      subtitle: '演示文稿',
      renderable: true,
      mode: 'always',
      maxBytes: CODEX_PREVIEW_FILE_LIMIT,
    }
  }

  if (ext === 'ipynb') {
    return {
      previewKind: 'ipynb',
      importKind: 'ipynb',
      artifactType: 'notebook',
      category: 'notebook',
      language: 'json',
      subtitle: 'Jupyter Notebook',
      renderable: true,
      mode: 'toggle',
      maxBytes: CODEX_TEXT_SAMPLE_LIMIT,
    }
  }

  if (ext === 'tex' || ext === 'xtx') {
    return {
      previewKind: 'tex',
      importKind: 'tex',
      artifactType: 'pdf',
      category: 'document',
      language: 'tex',
      subtitle: 'LaTeX 文档 · 可编辑源文件',
      renderable: true,
      mode: 'toggle',
      editable: true,
      maxBytes: CODEX_TEX_PREVIEW_LIMIT,
      editableMaxBytes: CODEX_EDITOR_LIMIT,
    }
  }

  if (ext && mermaidExts.has(ext)) {
    return {
      previewKind: 'mermaid',
      category: 'document',
      language: 'mermaid',
      subtitle: '流程图文档',
      renderable: true,
      mode: 'toggle',
      maxBytes: CODEX_TEXT_SAMPLE_LIMIT,
    }
  }

  if (ext && audioExts.has(ext)) {
    return {
      previewKind: 'audio',
      category: 'audio',
      mime: mimeForExtension(ext),
      subtitle: ext.toUpperCase() + ' 音频',
      renderable: true,
      mode: 'always',
      maxBytes: CODEX_PREVIEW_FILE_LIMIT,
    }
  }

  if (ext && videoExts.has(ext)) {
    return {
      previewKind: 'video',
      category: 'video',
      mime: mimeForExtension(ext),
      subtitle: ext.toUpperCase() + ' 视频',
      renderable: true,
      mode: 'always',
      maxBytes: CODEX_PREVIEW_FILE_LIMIT,
    }
  }

  const language = specialFilenameLanguage.get(lower) || (ext && codeLanguageByExt.get(ext)) || null
  if (language) {
    return {
      previewKind: language === 'json' || language === 'jsonc' ? 'json' : 'code',
      category: 'code',
      language,
      subtitle: language === 'text' ? '纯文本' : language.toUpperCase() + ' 源码',
      renderable: true,
      mode: language === 'json' ? 'toggle' : 'source',
      editable: true,
      maxBytes: CODEX_TEXT_SAMPLE_LIMIT,
      editableMaxBytes: CODEX_EDITOR_LIMIT,
    }
  }

  return {
    previewKind: 'code',
    category: 'file',
    language: 'text',
    subtitle: ext ? ext.toUpperCase() + ' 文件' : '文件',
    renderable: true,
    mode: 'source',
    maxBytes: CODEX_TEXT_SAMPLE_LIMIT,
    editableMaxBytes: CODEX_EDITOR_LIMIT,
  }
}

// Parse local file links / citations such as:
// - file:///abs/path/file.py#L120-L140
// - /abs/path/file.py:120:8
// - sandbox:/path/to/report.html
// - ./src/App.jsx#L42
export function parseFileReference(href) {
  if (typeof href !== 'string' || !href.trim()) return null
  const trimmed = href.trim()
  if (/^(?:https?|mailto|tel|javascript|data|blob|boteam):/i.test(trimmed)) return null

  let working = trimmed
  if (/^file:\/\//i.test(working)) {
    try {
      const url = new URL(working)
      if (url.hostname && url.hostname !== 'localhost') return null
      working = decodeURIComponent(url.pathname) + (url.hash || '')
      if (/^\/[A-Za-z]:\//.test(working)) working = working.slice(1)
    } catch {
      return null
    }
  } else if (/^sandbox:/i.test(working)) {
    working = working.slice('sandbox:'.length).replace(/^\/\/+/, '/')
  }

  let line = null
  let endLine = null
  let column = null

  const hashMatch = working.match(/#L(\d+)(?:C(\d+))?(?:-L?(\d+))?$/i)
  if (hashMatch) {
    line = Number(hashMatch[1])
    if (hashMatch[2]) column = Number(hashMatch[2])
    if (hashMatch[3]) endLine = Number(hashMatch[3])
    working = working.slice(0, hashMatch.index)
  } else {
    const colonMatch = working.match(/:(\d+)(?::(\d+))?$/)
    if (colonMatch && !/^[A-Za-z]:$/.test(working.slice(0, colonMatch.index))) {
      line = Number(colonMatch[1])
      if (colonMatch[2]) column = Number(colonMatch[2])
      working = working.slice(0, colonMatch.index)
    }
  }

  try {
    working = decodeURIComponent(working)
  } catch {
    // Keep literal path if it contains unescaped % characters.
  }
  if (!working || working.includes('\0') || /[\r\n]/.test(working)) return null
  return {
    path: working,
    line: Number.isInteger(line) && line > 0 ? line : null,
    endLine: Number.isInteger(endLine) && endLine >= (line || 1) ? endLine : null,
    column: Number.isInteger(column) && column > 0 ? column : null,
  }
}
