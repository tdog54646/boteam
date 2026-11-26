import assert from 'node:assert/strict'
import { mkdtemp, mkdir, open, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { crc32, deflateRawSync } from 'node:zlib'
import {
  CODEX_EDITOR_LIMIT,
  CODEX_PREVIEW_FILE_LIMIT,
  CODEX_TEX_PREVIEW_LIMIT,
  CODEX_TEXT_SAMPLE_LIMIT,
  classifyPreviewFile,
  parseFileReference,
} from '../desktop/file-preview-rules.mjs'
import {
  parseDelimitedSheet,
  parseDocxPreview,
  parsePptxPreview,
  parseXlsxPreview,
} from '../desktop/openxml-preview.mjs'
import { Workspace } from '../desktop/workspace.mjs'

function buildZipBuffer(fileEntries) {
  const localParts = []
  const centralParts = []
  let offset = 0

  for (const [name, content] of fileEntries) {
    const nameBuf = Buffer.from(name, 'utf8')
    const rawBuf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
    const compBuf = deflateRawSync(rawBuf)
    const checksum = crc32(rawBuf) >>> 0

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(compBuf.length, 18)
    local.writeUInt32LE(rawBuf.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    localParts.push(local, nameBuf, compBuf)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(compBuf.length, 20)
    central.writeUInt32LE(rawBuf.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, nameBuf)

    offset += 30 + nameBuf.length + compBuf.length
  }

  const centralBuf = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(fileEntries.length, 8)
  eocd.writeUInt16LE(fileEntries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)

  return Buffer.concat([...localParts, centralBuf, eocd])
}

test('Codex file classification & byte limits match official desktop format rules', () => {
  const md = classifyPreviewFile('docs/guide.md')
  assert.equal(md.previewKind, 'markdown')
  assert.equal(md.mode, 'toggle')
  assert.equal(md.maxBytes, CODEX_TEXT_SAMPLE_LIMIT)
  assert.equal(md.editableMaxBytes, CODEX_EDITOR_LIMIT)

  const agentMd = classifyPreviewFile('planner.agent.md')
  assert.equal(agentMd.previewKind, 'markdown')

  const html = classifyPreviewFile('report.html')
  assert.equal(html.previewKind, 'html')
  assert.equal(html.maxBytes, CODEX_TEXT_SAMPLE_LIMIT)

  const svg = classifyPreviewFile('diagram.svg')
  assert.equal(svg.previewKind, 'svg')
  assert.equal(svg.mode, 'toggle')
  assert.equal(svg.maxBytes, CODEX_TEXT_SAMPLE_LIMIT)

  const png = classifyPreviewFile('figure.png')
  assert.equal(png.previewKind, 'image')
  assert.equal(png.maxBytes, CODEX_PREVIEW_FILE_LIMIT)

  const pdf = classifyPreviewFile('paper.pdf')
  assert.equal(pdf.previewKind, 'pdf')
  assert.equal(pdf.maxBytes, CODEX_PREVIEW_FILE_LIMIT)

  const csv = classifyPreviewFile('metrics.csv')
  assert.equal(csv.previewKind, 'spreadsheet')
  assert.equal(csv.mode, 'toggle')
  assert.equal(csv.maxBytes, CODEX_PREVIEW_FILE_LIMIT)

  const xlsx = classifyPreviewFile('budget.xlsx')
  assert.equal(xlsx.previewKind, 'spreadsheet')
  assert.equal(xlsx.mode, 'always')
  assert.equal(xlsx.maxBytes, CODEX_PREVIEW_FILE_LIMIT)

  const docx = classifyPreviewFile('spec.docx')
  assert.equal(docx.previewKind, 'docx')
  assert.equal(docx.maxBytes, CODEX_PREVIEW_FILE_LIMIT)

  const pptx = classifyPreviewFile('deck.pptx')
  assert.equal(pptx.previewKind, 'pptx')
  assert.equal(pptx.maxBytes, CODEX_PREVIEW_FILE_LIMIT)

  const ipynb = classifyPreviewFile('experiment.ipynb')
  assert.equal(ipynb.previewKind, 'ipynb')
  assert.equal(ipynb.mode, 'toggle')
  assert.equal(ipynb.maxBytes, CODEX_TEXT_SAMPLE_LIMIT)

  const tex = classifyPreviewFile('thesis.tex')
  assert.equal(tex.previewKind, 'tex')
  assert.equal(tex.maxBytes, CODEX_TEX_PREVIEW_LIMIT)

  const mmd = classifyPreviewFile('flow.mmd')
  assert.equal(mmd.previewKind, 'mermaid')

  const wasm = classifyPreviewFile('engine.wasm')
  assert.equal(wasm.renderable, false)

  const docker = classifyPreviewFile('Dockerfile')
  assert.equal(docker.previewKind, 'code')
  assert.equal(docker.language, 'dockerfile')
  assert.equal(docker.maxBytes, CODEX_TEXT_SAMPLE_LIMIT)
})

test('parseFileReference extracts path, line, endLine, and column across URL schemes', () => {
  assert.deepEqual(parseFileReference('file:///Users/demo/rag/task_executor.py#L1627-L1635'), {
    path: '/Users/demo/rag/task_executor.py',
    line: 1627,
    endLine: 1635,
    column: null,
  })
  assert.deepEqual(parseFileReference('/Users/demo/internal/agent.go:2169:14'), {
    path: '/Users/demo/internal/agent.go',
    line: 2169,
    endLine: null,
    column: 14,
  })
  assert.deepEqual(parseFileReference('sandbox:/workspace/reports/index.html'), {
    path: '/workspace/reports/index.html',
    line: null,
    endLine: null,
    column: null,
  })
  assert.equal(parseFileReference('https://github.com/org/repo/pull/454'), null)
})

test('OpenXML & delimited parsers extract DOCX, XLSX, PPTX, and CSV structures cleanly', () => {
  const csv = parseDelimitedSheet('模型,速度,结论\n"GPT-6.2, High",1.11x,PASS\nClaude,1.04x,PASS\n', ',')
  assert.equal(csv.sheets[0].rows.length, 3)
  assert.deepEqual(csv.sheets[0].rows[1], ['GPT-6.2, High', '1.11x', 'PASS'])

  const docxZip = buildZipBuffer([
    [
      'word/document.xml',
      `<w:document><w:body>
        <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>架构评审结论</w:t></w:r></w:p>
        <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>核心指标：</w:t></w:r><w:r><w:t>全部通过验收</w:t></w:r></w:p>
        <w:tbl><w:tr><w:tc><w:p><w:r><w:t>模块</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>状态</w:t></w:r></w:p></w:tc></w:tr>
        <w:tr><w:tc><w:p><w:r><w:t>RAG 检索</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>PASS</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
      </w:body></w:document>`,
    ],
  ])
  const parsedDocx = parseDocxPreview(docxZip)
  assert.equal(parsedDocx.blocks.length, 3)
  assert.equal(parsedDocx.blocks[0].level, 1)
  assert.equal(parsedDocx.blocks[0].runs[0].text, '架构评审结论')
  assert.equal(parsedDocx.blocks[1].runs[0].bold, true)
  assert.equal(parsedDocx.blocks[2].type, 'table')
  assert.deepEqual(parsedDocx.blocks[2].rows[1], [{ text: 'RAG 检索' }, { text: 'PASS' }])

  const xlsxZip = buildZipBuffer([
    [
      'xl/workbook.xml',
      `<workbook><sheets><sheet name="概览" sheetId="1" r:id="rId1"/><sheet name="明细" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    ],
    [
      'xl/_rels/workbook.xml.rels',
      `<Relationships>
        <Relationship Id="rId1" Target="worksheets/sheet1.xml"/>
        <Relationship Id="rId2" Target="worksheets/sheet2.xml"/>
      </Relationships>`,
    ],
    [
      'xl/sharedStrings.xml',
      `<sst><si><t>延迟(ms)</t></si><si><t>加速比</t></si><si><t>1.11x</t></si></sst>`,
    ],
    [
      'xl/worksheets/sheet1.xml',
      `<worksheet><sheetData>
        <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
        <row r="2"><c r="A2"><v>6</v></c><c r="B2" t="s"><v>2</v></c></row>
      </sheetData></worksheet>`,
    ],
    [
      'xl/worksheets/sheet2.xml',
      `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>第二页数据</t></is></c></row></sheetData></worksheet>`,
    ],
  ])
  const parsedXlsx = parseXlsxPreview(xlsxZip)
  assert.equal(parsedXlsx.sheets.length, 2)
  assert.equal(parsedXlsx.sheets[0].name, '概览')
  assert.deepEqual(parsedXlsx.sheets[0].rows, [['延迟(ms)', '加速比'], ['6', '1.11x']])
  assert.deepEqual(parsedXlsx.sheets[1].rows, [['第二页数据']])

  const pptxZip = buildZipBuffer([
    [
      'ppt/presentation.xml',
      `<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>`,
    ],
    [
      'ppt/_rels/presentation.xml.rels',
      `<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/></Relationships>`,
    ],
    [
      'ppt/slides/slide1.xml',
      `<p:sld><p:cSld><p:spTree>
        <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>配对加速比汇报</a:t></a:r></a:p></p:txBody></p:sp>
        <p:sp><p:nvSpPr><p:nvPr/></p:nvSpPr><p:txBody><a:p><a:r><a:t>8/9 测量变快</a:t></a:r></a:p></p:txBody></p:sp>
      </p:spTree></p:cSld></p:sld>`,
    ],
  ])
  const parsedPptx = parsePptxPreview(pptxZip)
  assert.equal(parsedPptx.slides.length, 1)
  assert.equal(parsedPptx.slides[0].title, '配对加速比汇报')
  assert.equal(parsedPptx.slides[0].items[0].text, '8/9 测量变快')
})

test('panelRead enforces Codex byte limits, inlines safe local HTML assets, and guards workspace paths', async t => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'boteam-preview-test-')))
  const cwd = join(temp, 'workspace')
  await mkdir(join(cwd, 'web'), { recursive: true })
  const workspace = new Workspace({ root: join(temp, 'app'), adapters: {} })
  t.after(async () => {
    await workspace.close()
    await rm(temp, { recursive: true, force: true })
  })

  workspace.db.run('INSERT INTO accounts(id,provider,identity,info) VALUES(?,?,?,?)', 'acc', 'codex', 'id', '{}')
  const botId = await workspace.handle('createBot', { name: 'Bot', cwd, accountId: 'acc' })
  const chatId = await workspace.handle('createChat', { kind: 'direct', members: [botId] })
  const call = (method, args) => workspace.handle(method, { chatId, botId, ...args })

  // Local CSS/SVG asset inlining in HTML preview
  await writeFile(join(cwd, 'web/style.css'), 'body { color: #1675d1; }')
  await writeFile(join(cwd, 'web/index.html'), '<link rel="stylesheet" href="style.css"><h1>Dashboard</h1>')
  const htmlRead = await call('panelRead', { path: 'web/index.html' })
  assert.equal(htmlRead.previewKind, 'html')
  assert.match(htmlRead.renderedHtml, /data:text\/css;base64,/)

  // Allow absolute path INSIDE workspace when allowWorkspaceAbsolute=true, reject outside
  const absInside = await call('panelRead', {
    path: join(cwd, 'web/style.css'),
    allowWorkspaceAbsolute: true,
  })
  assert.equal(absInside.path, 'web/style.css')
  assert.equal(absInside.content, 'body { color: #1675d1; }')

  await writeFile(join(temp, 'secret.txt'), 'outside')
  await assert.rejects(
    call('panelRead', { path: join(temp, 'secret.txt'), allowWorkspaceAbsolute: true }),
    /工作目录/,
  )
  await symlink(join(temp, 'secret.txt'), join(cwd, 'web/escape.txt'))
  await assert.rejects(call('panelRead', { path: 'web/escape.txt' }))

  // Oversize .tex (> 1 MiB) and oversize .pdf (> 40 MiB sparse file) enforce Codex limits
  await writeFile(join(cwd, 'huge.tex'), 'x'.repeat(CODEX_TEX_PREVIEW_LIMIT + 128))
  const oversizeTex = await call('panelRead', { path: 'huge.tex' })
  assert.equal(oversizeTex.oversize, true)
  assert.match(oversizeTex.limitMessage, /超出预览上限/)

  const sparsePdfPath = join(cwd, 'huge.pdf')
  const fh = await open(sparsePdfPath, 'w')
  await fh.truncate(CODEX_PREVIEW_FILE_LIMIT + 1024)
  await fh.close()
  const oversizePdf = await call('panelRead', { path: 'huge.pdf' })
  assert.equal(oversizePdf.oversize, true)
  assert.equal(oversizePdf.base64, undefined)
})

test('Workspace preserves multi-segment chronological timelines & structured tool events across Codex, Claude Code, and AGY', async t => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'boteam-timeline-test-')))
  const cwd = join(temp, 'repo')
  await mkdir(cwd)
  let currentScenario = []
  const fakeAdapter = {
    async options() { return { models: [], defaultModel: '' } },
    async run({ account, emit }) {
      emit({ type: 'identity', key: account.identity, value: account.identity })
      for (const step of currentScenario) emit(step)
      return { sessionId: 'sess-1' }
    },
  }
  const workspace = new Workspace({
    root: join(temp, 'app'),
    adapters: { codex: fakeAdapter, claude: fakeAdapter, antigravity: fakeAdapter },
  })
  t.after(async () => {
    await workspace.close()
    await rm(temp, { recursive: true, force: true })
  })

  for (const provider of ['codex', 'claude', 'antigravity']) {
    const accId = `acc-${provider}`
    workspace.db.run(
      'INSERT INTO accounts(id,provider,identity,info) VALUES(?,?,?,?)',
      accId,
      provider,
      `${provider}:user`,
      JSON.stringify({ status: 'ready', bin: `/usr/local/bin/${provider}` }),
    )
    const botId = await workspace.handle('createBot', { name: `${provider}-bot`, cwd, accountId: accId })
    const chatId = await workspace.handle('createChat', { kind: 'direct', members: [botId] })

    currentScenario = [
      { type: 'text', value: '我会先检索仓库结构，再汇总表格。', itemId: `${provider}-seg-1`, phase: 'commentary' },
      { type: 'tool', value: '子智能体 · 运行中', agent: { id: 'ag-1', name: 'Feat reporting', status: 'running' } },
      {
        type: 'tool',
        value: '运行了命令 · pwd; ls -la',
        callId: 'cmd-1',
        kind: 'command',
        category: 'command',
        title: 'pwd; ls -la',
        command: 'pwd; ls -la',
        status: 'running',
      },
      {
        type: 'tool',
        value: '运行了命令 · pwd; ls -la',
        callId: 'cmd-1',
        kind: 'command',
        category: 'command',
        title: 'pwd; ls -la',
        command: 'pwd; ls -la',
        output: 'README.md',
        exitCode: 0,
        status: 'completed',
      },
      { type: 'tool', value: '子智能体 · 已完成', agent: { id: 'ag-1', name: 'Feat reporting', status: 'completed' } },
      {
        type: 'text',
        value: '| 模块 | 结论 |\n| --- | --- |\n| Dashboard | `PASS` |',
        itemId: `${provider}-seg-2`,
        phase: 'final_answer',
      },
    ]

    await workspace.handle('send', { chatId, recipients: [botId], text: '分析项目' })
    for (let i = 0; i < 60; i++) {
      const snap = await workspace.handle('snapshot')
      const job = snap.tasks.find(x => x.chatId === chatId)
      if (job?.status === 'done') break
      await new Promise(r => setTimeout(r, 20))
    }

    const snap = await workspace.handle('snapshot')
    const reply = snap.messages.find(m => m.chatId === chatId && m.author === 'bot')
    const job = snap.tasks.find(x => x.chatId === chatId)

    assert.equal(job.status, 'done')
    assert.ok(!Number.isNaN(Date.parse(job.startedAt)) && !Number.isNaN(Date.parse(job.completedAt)))
    assert.equal(reply.segments.length, 2)
    // Segments separated by \n\n so GFM pipe tables never collapse into the previous paragraph!
    assert.match(reply.text, /汇总表格。\n\n\| 模块 \| 结论 \|/)
    // In-place tool event update by callId (no duplicate running + completed command rows)
    const cmdEvents = job.events.filter(e => e.callId === 'cmd-1')
    assert.equal(cmdEvents.length, 1)
    assert.equal(cmdEvents[0].status, 'completed')
    assert.equal(cmdEvents[0].segment, 1)
  }
})

test('panelRead allows bound Antigravity brain artifacts and recorded Claude plan files while blocking internal logs and foreign sessions', async t => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'boteam-session-artifacts-')))
  const cwd = join(temp, 'workspace')
  const agyHome = join(temp, 'agy-profile')
  const claudeHome = join(temp, 'claude-profile')
  await mkdir(cwd, { recursive: true })

  const mainThread = '78ef7848-3399-4b64-87cd-8b761edd513e'
  const childThread = '30c5d45d-87d9-4a85-9f51-10bcc138787b'
  const foreignThread = '11111111-2222-4333-8444-555555555555'

  const mainBrain = join(agyHome, '.gemini', 'antigravity-cli', 'brain', mainThread)
  const childBrain = join(agyHome, '.gemini', 'antigravity-cli', 'brain', childThread)
  const foreignBrain = join(agyHome, '.gemini', 'antigravity-cli', 'brain', foreignThread)
  await mkdir(join(mainBrain, 'scratch'), { recursive: true })
  await mkdir(join(mainBrain, '.system_generated', 'logs'), { recursive: true })
  await mkdir(childBrain, { recursive: true })
  await mkdir(foreignBrain, { recursive: true })
  await mkdir(join(claudeHome, 'plans'), { recursive: true })

  const artifactPath = join(mainBrain, 'jinsiwei_interview_questions.md')
  const scratchPath = join(mainBrain, 'scratch', 'company.txt')
  const childArtifactPath = join(childBrain, 'subagent_summary.md')
  const internalLogPath = join(mainBrain, '.system_generated', 'logs', 'transcript.jsonl')
  const foreignPath = join(foreignBrain, 'other_chat.md')
  const claudePlanPath = join(claudeHome, 'plans', 'migration-plan.md')
  const claudeUnrecordedPlan = join(claudeHome, 'plans', 'other-chat-plan.md')
  const claudeCreds = join(claudeHome, '.credentials.json')

  await writeFile(artifactPath, '# 江苏金思维开发岗位面经题库\n\n详见 [company.txt](scratch/company.txt)')
  await writeFile(scratchPath, '公司主营工业软件 ERP / MES')
  await writeFile(childArtifactPath, '# 子智能体调研报告')
  await writeFile(internalLogPath, '{"secret":"internal"}')
  await writeFile(foreignPath, '# 其他会话私有文件')
  await writeFile(claudePlanPath, '# Claude 计划文档')
  await writeFile(claudeUnrecordedPlan, '# 其他会话计划')
  await writeFile(claudeCreds, '{"accessToken":"secret"}')

  const workspace = new Workspace({ root: join(temp, 'app'), adapters: {} })
  t.after(async () => {
    await workspace.close()
    await rm(temp, { recursive: true, force: true })
  })

  workspace.db.run(
    'INSERT INTO accounts(id,provider,identity,info) VALUES(?,?,?,?)',
    'acc-agy',
    'antigravity',
    'agy-owner',
    JSON.stringify({ status: 'ready', managed: true, source: agyHome }),
  )
  workspace.db.run(
    'INSERT INTO accounts(id,provider,identity,info) VALUES(?,?,?,?)',
    'acc-claude',
    'claude',
    'claude-owner',
    JSON.stringify({ status: 'ready', managed: true, source: claudeHome }),
  )

  const agyBot = await workspace.handle('createBot', { name: 'gemini', cwd, accountId: 'acc-agy' })
  const claudeBot = await workspace.handle('createBot', { name: 'claude', cwd, accountId: 'acc-claude' })
  const chatId = await workspace.handle('createChat', { kind: 'group', name: '联合调研', members: [agyBot, claudeBot] })

  workspace.db.run(
    'INSERT INTO threads(chatId,botId,accountId,threadId,cwd) VALUES(?,?,?,?,?)',
    chatId,
    agyBot,
    'acc-agy',
    mainThread,
    cwd,
  )
  const now = new Date().toISOString()
  workspace.db.run(
    `INSERT INTO messages(id,chatId,author,name,text,createdAt,recipients) VALUES('u1',?,'user','我','生成面经',?,'[]')`,
    chatId,
    now,
  )
  workspace.db.run(
    `INSERT INTO tasks(id,chatId,botId,accountId,messageId,status,tool,events,createdAt) VALUES('task-agy',?,?,'acc-agy','u1','done','agy',?,?)`,
    chatId,
    agyBot,
    JSON.stringify([
      { text: '子智能体 · 已完成', agent: { id: `agy:${mainThread}:call_1`, status: 'completed', nativeThreadId: childThread } },
      { text: '创建文件', kind: 'fileChange', path: artifactPath, status: 'completed' },
    ]),
    now,
  )
  workspace.db.run(
    `INSERT INTO tasks(id,chatId,botId,accountId,messageId,status,tool,events,createdAt) VALUES('task-claude',?,?,'acc-claude','u1','done','claude',?,?)`,
    chatId,
    claudeBot,
    JSON.stringify([{ text: '创建文件', kind: 'fileChange', path: claudePlanPath, status: 'completed' }]),
    now,
  )

  const read = (path) =>
    workspace.handle('panelRead', { chatId, botId: agyBot, path, allowWorkspaceAbsolute: true })

  // 1. Main Antigravity brain artifact opens by absolute path AND relative filename fallback
  const mainDoc = await read(artifactPath)
  assert.equal(mainDoc.previewKind, 'markdown')
  assert.equal(mainDoc.editable, false)
  assert.equal(mainDoc.resolvedDir, mainBrain)
  assert.match(mainDoc.content, /江苏金思维开发岗位面经题库/)

  const relDoc = await read('jinsiwei_interview_questions.md')
  assert.match(relDoc.content, /江苏金思维开发岗位面经题库/)

  const scratchDoc = await read(scratchPath)
  assert.match(scratchDoc.content, /工业软件 ERP/)

  // 2. Child subagent brain artifact also opens cleanly
  const childDoc = await read(childArtifactPath)
  assert.match(childDoc.content, /子智能体调研报告/)

  // 3. Recorded Claude plan file opens, while unrecorded plans & credentials are blocked
  const planDoc = await read(claudePlanPath)
  assert.match(planDoc.content, /Claude 计划文档/)
  await assert.rejects(read(claudeUnrecordedPlan), /只能预览当前会话工作目录内的文件/)
  await assert.rejects(read(claudeCreds), /只能预览当前会话工作目录内的文件/)

  // 4. Internal .system_generated logs and foreign Antigravity brain sessions remain blocked
  await assert.rejects(read(internalLogPath), /普通文件|只能预览/)
  await assert.rejects(read(foreignPath), /只能预览当前会话工作目录内的文件/)
})
