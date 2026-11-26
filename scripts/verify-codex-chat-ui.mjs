// Desktop E2E acceptance test for Codex-style conversation timeline, animations,
// multi-CLI compatibility (Codex / Claude Code / AGY), and multi-format click-to-render previews.
import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { crc32, deflateRawSync } from 'node:zlib'
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

const root = await realpath(await mkdtemp(join(tmpdir(), 'boteam-codex-ui-')))
const projectDir = join(root, 'infer-project')
const executable = process.env.BOTEAM_TEST_EXECUTABLE
let app

async function createSampleWorkspaceFiles() {
  await mkdir(join(projectDir, 'src'), { recursive: true })
  await mkdir(join(projectDir, 'reports'), { recursive: true })

  // 1. Source code file for :line citation highlight & scroll verification
  const pyLines = Array.from({ length: 45 }, (_, i) => {
    const n = i + 1
    if (n === 28) return 'def compute_paired_speedup_interval(samples: list[float]) -> tuple[float, float]:'
    return `# line ${n} pipeline helper`
  })
  await writeFile(join(projectDir, 'src/pipeline.py'), pyLines.join('\n') + '\n')

  // 2. HTML interactive report (inline <script>, onclick handlers, localStorage, SVG/DOM init, clipboard copy)
  await writeFile(
    join(projectDir, 'reports/dashboard.html'),
    `<!doctype html><html lang="zh-CN" data-theme="light"><head><meta charset="utf-8"><style>:root[data-theme="dark"]{background:#12161f;color:#f1f5f9;}</style></head><body>
      <header><h1 id="report-heading">配对加速比可视化面板</h1><button id="theme-btn" type="button" onclick="toggleTheme()">🌙 深色模式</button></header>
      <p>8/9 测量变快，中位加速比 1.11x</p>
      <div id="ferrers-box"><input id="n-slider" type="range" min="2" max="8" value="5" oninput="renderFerrers(Number(this.value))"><span id="partition-count">未初始化</span><svg id="ferrers-svg" width="120" height="60"></svg></div>
      <button id="copy-code-btn" type="button" onclick="copyCode()">复制代码</button><span id="copy-status">待复制</span>
      <script>
        const savedTheme = localStorage.getItem('demo-theme') || 'light';
        document.documentElement.dataset.theme = savedTheme;
        function toggleTheme() {
          const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
          document.documentElement.dataset.theme = next;
          localStorage.setItem('demo-theme', next);
          document.getElementById('theme-btn').textContent = next === 'dark' ? '☀️ 浅色模式' : '🌙 深色模式';
        }
        function renderFerrers(n) {
          const counts = { 2: 1, 3: 2, 4: 4, 5: 6, 6: 10, 7: 14, 8: 21 };
          document.getElementById('partition-count').textContent = '真分拆数: ' + (counts[n] ?? 0);
          const svg = document.getElementById('ferrers-svg');
          svg.innerHTML = Array.from({ length: n }, (_, i) => '<circle cx="' + (12 + i * 16) + '" cy="24" r="5" />').join('');
        }
        async function copyCode() {
          await navigator.clipboard.writeText('def accel_asc(n): yield [n]');
          document.getElementById('copy-status').textContent = '已复制';
        }
        renderFerrers(5);
        let parentBlocked = false;
        try { void window.parent.document.title; } catch { parentBlocked = true; }
        document.body.dataset.parentIsolated = String(parentBlocked && typeof window.boteam === 'undefined');
      </script>
    </body></html>`,
  )

  // 3. Multi-sheet OpenXML .xlsx
  const xlsxBuf = buildZipBuffer([
    ['xl/workbook.xml', `<workbook><sheets><sheet name="汇总指标" sheetId="1" r:id="rId1"/><sheet name="轮次明细" sheetId="2" r:id="rId2"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>`],
    ['xl/worksheets/sheet1.xml', `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>基线耗时</t></is></c><c r="B1" t="inlineStr"><is><t>候选耗时</t></is></c></row><row r="2"><c r="A2"><v>6</v></c><c r="B2"><v>9</v></c></row></sheetData></worksheet>`],
    ['xl/worksheets/sheet2.xml', `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>中位加速比 1.11x</t></is></c></row></sheetData></worksheet>`],
  ])
  await writeFile(join(projectDir, 'reports/metrics.xlsx'), xlsxBuf)

  // 4. OpenXML .docx
  const docxBuf = buildZipBuffer([
    [
      'word/document.xml',
      `<w:document><w:body>
        <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>InferRSI 评审设计文档</w:t></w:r></w:p>
        <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>核心结论：</w:t></w:r><w:r><w:t>首选配对加速比区间方案。</w:t></w:r></w:p>
      </w:body></w:document>`,
    ],
  ])
  await writeFile(join(projectDir, 'reports/spec.docx'), docxBuf)

  // 5. OpenXML .pptx
  const pptxBuf = buildZipBuffer([
    ['ppt/presentation.xml', `<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>`],
    ['ppt/_rels/presentation.xml.rels', `<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/><Relationship Id="rId2" Target="slides/slide2.xml"/></Relationships>`],
    ['ppt/slides/slide1.xml', `<p:sld><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>第一页：方案概览</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:nvPr/></p:nvSpPr><p:txBody><a:p><a:r><a:t>复现 CPU 合成测试</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`],
    ['ppt/slides/slide2.xml', `<p:sld><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>第二页：CLI 入口扩展</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`],
  ])
  await writeFile(join(projectDir, 'reports/roadmap.pptx'), pptxBuf)

  // 6. Jupyter Notebook .ipynb
  await writeFile(
    join(projectDir, 'reports/analysis.ipynb'),
    JSON.stringify({
      metadata: { kernelspec: { language: 'python' } },
      cells: [
        { cell_type: 'markdown', source: ['## 配对样本实验记录\n'] },
        {
          cell_type: 'code',
          execution_count: 1,
          source: ['speedup = 1.11\nprint(f"median={speedup}x")'],
          outputs: [{ output_type: 'stream', text: ['median=1.11x\n'] }],
        },
      ],
    }),
  )

  // 7. Minimal valid PDF 1.4 document for pdfjs-dist worker & canvas verification
  const pdfObjs = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 260] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
    '4 0 obj\n<< /Length 53 >>\nstream\nBT /F1 16 Tf 36 180 Td (InferRSI Paired Report) Tj ET\nendstream\nendobj\n',
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ]
  let pdfBody = '%PDF-1.4\n'
  const pdfOffsets = [0]
  for (const obj of pdfObjs) {
    pdfOffsets.push(Buffer.byteLength(pdfBody, 'utf8'))
    pdfBody += obj
  }
  const xrefOffset = Buffer.byteLength(pdfBody, 'utf8')
  pdfBody += `xref\n0 ${pdfObjs.length + 1}\n0000000000 65535 f \n`
  for (let i = 1; i <= pdfObjs.length; i++) {
    pdfBody += `${String(pdfOffsets[i]).padStart(10, '0')} 00000 n \n`
  }
  pdfBody += `trailer\n<< /Size ${pdfObjs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  await writeFile(join(projectDir, 'reports/paper.pdf'), Buffer.from(pdfBody, 'utf8'))

  // 8. SVG & LaTeX (.tex)
  await writeFile(
    join(projectDir, 'reports/architecture.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120"><rect width="240" height="120" rx="12" fill="#1675d1"/><text x="120" y="65" fill="#fff" text-anchor="middle">Pipeline</text></svg>',
  )
  await writeFile(
    join(projectDir, 'reports/notes.tex'),
    '\\title{配对加速比推导}\n\\author{BoTeam}\n\\begin{document}\n\\maketitle\n\\section{区间定义}\n\\[ S = \\frac{T_0}{T_1} \\]\n\\end{document}\n',
  )
}

async function seedDatabase() {
  await createSampleWorkspaceFiles()
  const workspace = new Workspace({ root, adapters: {} })
  try {
    workspace.db.run(
      'INSERT INTO accounts(id,provider,identity,info) VALUES(?,?,?,?)',
      'acc-codex',
      'codex',
      'codex:user',
      JSON.stringify({ status: 'blocked' }),
    )
    workspace.db.run(
      'INSERT INTO bots(id,accountId,name,cwd) VALUES(?,?,?,?)',
      'bot-codex',
      'acc-codex',
      'Codex 助手',
      projectDir,
    )
    const chatId = await workspace.handle('createChat', {
      kind: 'direct',
      members: ['bot-codex'],
    })
    await workspace.handle('renameChat', { chatId, name: '调研 InferRSI 易通过的 PR' })
    await workspace.handle('finishOnboarding')

    const startMs = Date.now() - 196_000 // 3m 16s
    const endMs = startMs + 196_000
    const createdAt = new Date(startMs).toISOString()

    workspace.db.run(
      `INSERT INTO messages(id,chatId,author,name,text,createdAt,recipients)
       VALUES('u1',?,'user','我','帮我调研 InferRSI 并生成可视化与办公文档产物',?,'["bot-codex"]')`,
      chatId,
      createdAt,
    )

    const events = [
      { kind: 'meta', text: '模型 gpt-6.2 · 思考强度 high' },
      {
        segment: 1,
        text: '子智能体 · 已完成',
        agent: { id: 'ag-feat', name: 'Feat reporting', status: 'completed', nativeThreadId: 'seed-feat-0' },
      },
      {
        segment: 1,
        text: '子智能体 · 已完成',
        agent: { id: 'ag-issues', name: 'Issues', status: 'completed', nativeThreadId: 'seed-issues-4' },
      },
      {
        segment: 1,
        text: '子智能体 · 已完成',
        agent: { id: 'ag-code', name: 'Code', status: 'completed', nativeThreadId: 'seed-code-1' },
      },
      {
        segment: 1,
        callId: 'load-1',
        kind: 'loadedTool',
        category: 'loaded',
        title: '加载了工具',
        status: 'completed',
      },
      {
        segment: 1,
        callId: 'read-1',
        kind: 'toolCall',
        category: 'read',
        title: '读取 src/pipeline.py',
        filePath: join(projectDir, 'src/pipeline.py'),
        line: 28,
        status: 'completed',
      },
      {
        segment: 1,
        callId: 'web-1',
        kind: 'webSearch',
        category: 'web',
        title: '已搜索网页：https://github.com/InferMatrixLab/InferRSI/issues',
        url: 'https://github.com/InferMatrixLab/InferRSI/issues',
        status: 'completed',
      },
      ...Array.from({ length: 14 }, (_, idx) => ({
        segment: 1,
        callId: `cmd-${idx}`,
        kind: 'command',
        category: 'command',
        title: idx === 0 ? 'pwd; ls -la' : `gh issue view ${330 + idx} -R InferMatrixLab/InferRSI --json body`,
        command: idx === 0 ? 'pwd; ls -la' : `gh issue view ${330 + idx} -R InferMatrixLab/InferRSI --json body`,
        output: idx === 0 ? 'README.md\nsrc/\nreports/' : `{"number":${330 + idx}}`,
        exitCode: 0,
        status: 'completed',
      })),
      {
        segment: 1,
        callId: 'edit-artifacts',
        kind: 'fileChange',
        category: 'edit',
        title: '已更新 4 个文件',
        files: [
          { path: 'reports/dashboard.html', kind: 'added', added: 12, removed: 0 },
          { path: 'reports/metrics.xlsx', kind: 'added', added: 0, removed: 0 },
          { path: 'reports/spec.docx', kind: 'added', added: 0, removed: 0 },
          { path: 'reports/roadmap.pptx', kind: 'added', added: 0, removed: 0 },
        ],
        status: 'completed',
      },
    ]

    const agyProfile = join(root, 'profiles', 'profile-agy-test')
    const agyThreadId = '78ef7848-3399-4b64-87cd-8b761edd513e'
    const agyBrainDir = join(agyProfile, '.gemini', 'antigravity-cli', 'brain', agyThreadId)
    await mkdir(agyBrainDir, { recursive: true })
    const agyArtifactPath = join(agyBrainDir, 'jinsiwei_interview_questions.md')
    await writeFile(
      agyArtifactPath,
      '# 江苏金思维开发岗位面经题库\n\n- **机考形式**：线下断网 90 分钟算法与 SQL 编程\n',
    )
    workspace.db.run(
      'INSERT INTO accounts(id,provider,identity,info) VALUES(?,?,?,?)',
      'acc-agy',
      'antigravity',
      'agy-user',
      JSON.stringify({ status: 'ready', managed: true, source: agyProfile }),
    )
    workspace.db.run(
      'INSERT INTO bots(id,accountId,name,cwd,model,effort) VALUES(?,?,?,?,?,?)',
      'bot-agy',
      'acc-agy',
      'gemini',
      projectDir,
      'gemini-4-carbon-high',
      'high',
    )

    workspace.db.run(
      `INSERT INTO tasks(id,chatId,botId,accountId,messageId,status,tool,events,createdAt,startedAt,completedAt)
       VALUES('t1',?,'bot-codex','acc-codex','u1','done','/usr/local/bin/codex',?,?,?,?)`,
      chatId,
      JSON.stringify(events),
      createdAt,
      new Date(startMs).toISOString(),
      new Date(endMs).toISOString(),
    )
    const subagentSeedEntries = [
      ['u-dispatch', 'user', '检索 InferRSI 公开候选池与配对加速比实现细节，输出结构化核对结论。', null],
      ['a-comment', 'assistant', '先检索公开议题列表并定位核心配对计算函数。', null],
      [
        'act-web',
        'activity',
        '搜索网页',
        JSON.stringify({
          kind: 'webSearch',
          category: 'web',
          status: 'completed',
          query: 'InferRSI dashboard paired speedup',
          title: '已搜索网页：InferRSI dashboard paired speedup',
        }),
      ],
      [
        'act-read',
        'activity',
        '读取文件',
        JSON.stringify({
          kind: 'read',
          category: 'read',
          status: 'completed',
          path: 'src/pipeline.py',
          line: 28,
          title: '读取文件 · src/pipeline.py',
        }),
      ],
      [
        'act-write',
        'activity',
        '写入文件',
        JSON.stringify({
          kind: 'fileChange',
          category: 'edit',
          status: 'completed',
          path: 'reports/spec.docx',
          files: [{ path: 'reports/spec.docx', mode: 'add' }],
          title: '创建文件 · reports/spec.docx',
        }),
      ],
      ['e1', 'assistant', '已完成 **Feat reporting** 候选池核对，核心入口见 `src/pipeline.py`。', null],
    ]
    for (const [entryId, role, text, meta] of subagentSeedEntries) {
      workspace.db.run(
        `INSERT INTO subagent_entries(taskId,agentId,entryId,role,text,meta)
         VALUES('t1','ag-feat',?,?,?,?)`,
        entryId,
        role,
        text,
        meta,
      )
    }

    // Seed Antigravity chat with artifact generated in brain/<sessionId>/jinsiwei_interview_questions.md
    const agyChatId = await workspace.handle('createChat', { kind: 'direct', members: ['bot-agy'] })
    await workspace.handle('renameChat', { chatId: agyChatId, name: '江苏金思维开发岗位面经生成' })
    workspace.db.run(
      'INSERT INTO threads(chatId,botId,accountId,threadId,cwd) VALUES(?,?,?,?,?)',
      agyChatId,
      'bot-agy',
      'acc-agy',
      agyThreadId,
      projectDir,
    )
    workspace.db.run(
      `INSERT INTO messages(id,chatId,author,name,text,createdAt,recipients)
       VALUES('u-agy',?,'user','我','生成江苏金思维面试题库',?,'["bot-agy"]')`,
      agyChatId,
      createdAt,
    )
    workspace.db.run(
      `INSERT INTO tasks(id,chatId,botId,accountId,messageId,status,tool,events,createdAt,startedAt,completedAt)
       VALUES('t-agy',?,'bot-agy','acc-agy','u-agy','done','agy',?,?,?,?)`,
      agyChatId,
      JSON.stringify([
        {
          callId: 'agy-write-md',
          kind: 'fileChange',
          path: agyArtifactPath,
          files: [{ path: agyArtifactPath, mode: 'add' }],
          text: '创建文件 · ' + agyArtifactPath,
          status: 'completed',
        },
      ]),
      createdAt,
      new Date(startMs).toISOString(),
      new Date(endMs).toISOString(),
    )
    workspace.db.run(
      `INSERT INTO messages(id,chatId,botId,author,name,text,createdAt,recipients,taskId)
       VALUES('m-agy',?,'bot-agy','bot','gemini','已整理完整面经题库文档。',?,'[]','t-agy')`,
      agyChatId,
      new Date(endMs).toISOString(),
    )

    const seg0 = '我会继续用 Agent Reach 和 submit-pr 查 InferRSI，重点核对维护者是否提过需求、主线是否已实现。'
    const seg1 = [
      '首选做 Dashboard 的「配对加速比区间」。 [需求 #454](https://github.com/InferMatrixLab/InferRSI/issues/454)',
      '',
      '| 探索方向 | 代码实现位置 | 判定状态 |',
      '| --- | --- | --- |',
      `| 配对区间计算 | [Python 配对函数](${join(projectDir, 'src/pipeline.py')}:28) | \`PASS\` |`,
      `| 实验记录本 | [analysis.ipynb](reports/analysis.ipynb) | \`PASS\` |`,
      `| 论文附录与架构图 | [paper.pdf](reports/paper.pdf) · [architecture.svg](reports/architecture.svg) · [notes.tex](reports/notes.tex) | \`PASS\` |`,
      '',
      '中位加速比公式为 $\\text{speedup} = \\frac{T_{\\text{base}}}{T_{\\text{cand}}} \\approx 1.11\\times$。',
    ].join('\n')

    const segments = [
      { id: 'seg-0', phase: 'commentary', text: seg0 },
      { id: 'seg-1', phase: 'final_answer', text: seg1 },
    ]
    workspace.db.run(
      `INSERT INTO messages(id,chatId,botId,author,name,text,segments,createdAt,recipients,taskId)
       VALUES('m1',?,'bot-codex','bot','Codex 助手',?,?,?,'[]','t1')`,
      chatId,
      `${seg0}\n\n${seg1}`,
      JSON.stringify(segments),
      new Date(endMs).toISOString(),
    )

    // Seed second chat to verify "重新授权" ONLY appears when account/token is expired
    const authChatId = await workspace.handle('createChat', {
      kind: 'direct',
      members: ['bot-codex'],
    })
    await workspace.handle('renameChat', { chatId: authChatId, name: '权限与过期校验对话' })
    workspace.db.run(
      `INSERT INTO messages(id,chatId,author,name,text,createdAt,recipients)
       VALUES('u2',?,'user','我','普通超时失败测试',?,'["bot-codex"]')`,
      authChatId,
      createdAt,
    )
    workspace.db.run(
      `INSERT INTO tasks(id,chatId,botId,accountId,messageId,status,tool,error,authExpired,createdAt,startedAt,completedAt)
       VALUES('t2',?,'bot-codex','acc-codex','u2','failed','/usr/local/bin/codex','Antigravity 子智能体及主会话连续 10 分钟没有新进展（已收到 2/3 份报告）。',0,?,?,?)`,
      authChatId,
      createdAt,
      createdAt,
      new Date(endMs).toISOString(),
    )
    workspace.db.run(
      `INSERT INTO messages(id,chatId,botId,author,name,text,createdAt,recipients,taskId)
       VALUES('m2',?,'bot-codex','bot','Codex 助手','已收到 2 份报告。',?,'[]','t2')`,
      authChatId,
      new Date(endMs).toISOString(),
    )
    workspace.db.run(
      `INSERT INTO messages(id,chatId,author,name,text,createdAt,recipients)
       VALUES('u3',?,'user','我','令牌过期失败测试',?,'["bot-codex"]')`,
      authChatId,
      createdAt,
    )
    workspace.db.run(
      `INSERT INTO tasks(id,chatId,botId,accountId,messageId,status,tool,error,authExpired,createdAt,startedAt,completedAt)
       VALUES('t3',?,'bot-codex','acc-codex','u3','failed','/usr/local/bin/codex','Codex 访问令牌已过期，请在原客户端刷新登录，或在此重新授权。',1,?,?,?)`,
      authChatId,
      createdAt,
      createdAt,
      new Date(endMs).toISOString(),
    )
    workspace.db.run(
      `INSERT INTO messages(id,chatId,botId,author,name,text,createdAt,recipients,taskId)
       VALUES('m3',?,'bot-codex','bot','Codex 助手','',?,'[]','t3')`,
      authChatId,
      new Date(endMs).toISOString(),
    )
  } finally {
    await workspace.close()
  }
}

try {
  await seedDatabase()
  app = await electron.launch({
    ...(executable && { executablePath: resolve(executable) }),
    args: [...(executable ? [] : ['.']), '--user-data-dir=' + root],
  })
  const page = await app.firstWindow()
  const win = await app.browserWindow(page)
  await win.evaluate(w => {
    w.webContents.setBackgroundThrottling(false)
    w.setIgnoreMouseEvents(true)
    w.hide()
  })
  await win.dispose()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1360, 820))

  const pageErrors = []
  page.on('pageerror', err => pageErrors.push(err.message))
  page.setDefaultTimeout(10_000)

  await page.getByTitle('调研 InferRSI 易通过的 PR', { exact: true }).click()
  const log = page.getByRole('log', { name: '消息记录' })
  await expect(log).toContainText('首选做 Dashboard 的「配对加速比区间」')

  // 1. Verify Codex elapsed duration disclosure header ("用时 3m 16s") & collapse behavior
  const durationBtn = log.getByRole('button', { name: '用时 3m 16s' })
  await expect(durationBtn).toBeVisible()
  await expect(durationBtn).toHaveAttribute('aria-expanded', 'true')

  // 2. Verify colored Subagent batch row ("Feat reporting、Issues和Code 已完成")
  const subagentRow = log.locator('.codex-subagent-row')
  await expect(subagentRow).toContainText('Feat reporting、Issues和Code 已完成')
  const featBtn = subagentRow.getByRole('button', { name: 'Feat reporting' })
  const featColor = await featBtn.evaluate(el => getComputedStyle(el).color)
  expect(featColor).not.toBe('rgb(0, 0, 0)')

  // Clicking colored subagent name opens right-hand subagent transcript with full Codex chat UI & motion
  await featBtn.click()
  const agentPanel = page.getByRole('tabpanel', { name: '子智能体', exact: true })
  await expect(agentPanel.locator('.user-bubble')).toContainText('检索 InferRSI 公开候选池')
  await expect(agentPanel.locator('.turn-final-answer')).toContainText('已完成 Feat reporting 候选池核对')
  // Subagent turn header & tool group match main chat disclosure & motion!
  const subTurnToggle = agentPanel.getByRole('button', { name: /执行过程 · 3 项操作/ })
  await expect(subTurnToggle).toHaveAttribute('aria-expanded', 'true')
  await subTurnToggle.click()
  await expect(subTurnToggle).toHaveAttribute('aria-expanded', 'false')
  await subTurnToggle.click()
  await expect(subTurnToggle).toHaveAttribute('aria-expanded', 'true')
  await expect(agentPanel.locator('.turn-commentary')).toContainText('先检索公开议题列表')
  await expect(agentPanel.locator('.codex-tool-header')).toContainText('读取文件')
  await expect(agentPanel.locator('.codex-tool-header')).toContainText('编辑了文件')
  await expect(agentPanel.locator('.codex-tool-header')).toContainText('已搜索网页')
  await expect(agentPanel.locator('.codex-tool-row').first()).toContainText('已搜索网页：InferRSI dashboard paired speedup')
  await expect(agentPanel.locator('.end-resource-card')).toContainText('spec.docx')
  if (process.env.BOTEAM_SUBAGENT_SCREENSHOT) {
    await page.screenshot({ path: process.env.BOTEAM_SUBAGENT_SCREENSHOT, animations: 'disabled', scale: 'device' })
  }

  // 3. Verify Collapsible Tool Activity Group + bounded scroll + floating ↓ button + command drawer
  const toolHeader = log.locator('.codex-tool-header')
  await expect(toolHeader).toContainText('加载了工具')
  await expect(toolHeader).toContainText('读取文件')
  await expect(toolHeader).toContainText('运行了命令')
  await expect(toolHeader).toContainText('已搜索网页')

  const toolScroll = log.locator('.codex-tool-scroll')
  const scrollBox = await toolScroll.boundingBox()
  expect(scrollBox.height).toBeLessThanOrEqual(270)

  const bottomBtn = log.getByRole('button', { name: '滚动到最新工具记录' })
  await expect(bottomBtn).toBeVisible()
  await bottomBtn.click()
  await expect(bottomBtn).toHaveCount(0)

  // Scroll back to top of tool list and expand first command drawer
  await toolScroll.evaluate(el => { el.scrollTop = 0 })
  await log.locator('.codex-tool-row').filter({ hasText: 'pwd; ls -la' }).click()
  await expect(log.locator('.codex-drawer-out')).toContainText('README.md')

  // Collapsing "用时 3m 16s" hides intermediate steps while keeping final answer visible!
  await durationBtn.click()
  await expect(durationBtn).toHaveAttribute('aria-expanded', 'false')
  await expect(log.locator('.turn-final-answer')).toContainText('首选做 Dashboard')
  await durationBtn.click()
  await expect(durationBtn).toHaveAttribute('aria-expanded', 'true')

  // 4. Verify GFM table, KaTeX math, and GitHub octocat link
  await expect(log.locator('.turn-final-answer table th')).toHaveCount(3)
  await expect(log.locator('.turn-final-answer .katex').first()).toBeVisible()
  await expect(log.locator('.turn-final-answer .md-link-glyph').first()).toBeVisible()

  // 5. Click inline local file citation (`pipeline.py:28`) -> opens source view with line 28 highlighted!
  await log.getByRole('button', { name: 'Python 配对函数' }).click()
  const rightPanel = page.getByLabel('右侧工作区')
  const activeTab = rightPanel.locator('.wp-tab-body:not([hidden])')
  const targetLine = activeTab.locator('.fp-code-line.is-target[data-line="28"]')
  await expect(targetLine).toContainText('def compute_paired_speedup_interval')

  // 6. Click EndResourceCards to verify HTML, XLSX, DOCX, PPTX, and IPYNB rendering!
  const resourceList = log.getByLabel('生成与更新的文件')
  await expect(resourceList.locator('.end-resource-card')).toHaveCount(6)

  // HTML sandboxed iframe preview + interactive JS / onclick / localStorage / SVG / clipboard + dual pane splitters
  await resourceList.getByRole('button', { name: /dashboard\.html/ }).click()
  const htmlFrame = activeTab.locator('iframe.fp-html-frame')
  await expect(htmlFrame).toHaveAttribute('sandbox', 'allow-scripts')
  const previewDoc = activeTab.frameLocator('iframe.fp-html-frame')
  await expect(previewDoc.locator('#report-heading')).toHaveText('配对加速比可视化面板')
  await expect(previewDoc.locator('body')).toHaveAttribute('data-parent-isolated', 'true')
  await expect(previewDoc.locator('#partition-count')).toHaveText('真分拆数: 6')
  await expect(previewDoc.locator('#ferrers-svg circle')).toHaveCount(5)
  await previewDoc.locator('#theme-btn').click()
  await expect(previewDoc.locator('#theme-btn')).toHaveText('☀️ 浅色模式')
  await expect(previewDoc.locator('html')).toHaveAttribute('data-theme', 'dark')
  await previewDoc.locator('#n-slider').fill('6')
  await expect(previewDoc.locator('#partition-count')).toHaveText('真分拆数: 10')
  await expect(previewDoc.locator('#ferrers-svg circle')).toHaveCount(6)
  await previewDoc.locator('#copy-code-btn').click()
  await expect(previewDoc.locator('#copy-status')).toHaveText('已复制')

  // Verify both Codex-style draggable splitters (left sidebar <-> main, main <-> right workspace panel)
  const sidebarEl = page.locator('.sidebar')
  const leftResizer = page.getByRole('separator', { name: '调整侧边栏宽度' })
  const rightResizer = page.getByRole('separator', { name: '调整右侧面板宽度' })
  await expect(leftResizer).toBeVisible()
  await expect(rightResizer).toBeVisible()

  const initialSidebarBox = await sidebarEl.boundingBox()
  const leftBox = await leftResizer.boundingBox()
  await page.mouse.move(leftBox.x + leftBox.width / 2, leftBox.y + 180)
  await page.mouse.down()
  await page.mouse.move(leftBox.x + leftBox.width / 2 + 64, leftBox.y + 180, { steps: 6 })
  await page.mouse.up()
  await expect.poll(async () => Math.round((await sidebarEl.boundingBox()).width)).toBe(Math.round(initialSidebarBox.width + 64))
  expect(await page.evaluate(() => localStorage.getItem('boteam:sidebar-width'))).toBe(String(Math.round(initialSidebarBox.width + 64)))
  await leftResizer.dblclick()
  await expect.poll(async () => Math.round((await sidebarEl.boundingBox()).width)).toBe(Math.round(initialSidebarBox.width))
  expect(await page.evaluate(() => localStorage.getItem('boteam:sidebar-width'))).toBeNull()

  const panelEl = page.locator('.workspace-panel')
  const initialPanelBox = await panelEl.boundingBox()
  const rightBox = await rightResizer.boundingBox()
  await page.mouse.move(rightBox.x + rightBox.width / 2, rightBox.y + 220)
  await page.mouse.down()
  await page.mouse.move(rightBox.x + rightBox.width / 2 - 80, rightBox.y + 220, { steps: 6 })
  await page.mouse.up()
  await expect.poll(async () => Math.round((await panelEl.boundingBox()).width)).toBe(Math.round(initialPanelBox.width + 80))
  expect(await page.evaluate(() => localStorage.getItem('boteam:panel-width'))).toBe(String(Math.round(initialPanelBox.width + 80)))
  await rightResizer.dblclick()
  await expect.poll(async () => Math.round((await panelEl.boundingBox()).width)).toBe(Math.round(initialPanelBox.width))
  expect(await page.evaluate(() => localStorage.getItem('boteam:panel-width'))).toBeNull()

  // XLSX multi-sheet spreadsheet preview
  await resourceList.getByRole('button', { name: /metrics\.xlsx/ }).click()
  await expect(activeTab.locator('.fp-sheet-table')).toContainText('基线耗时')
  await activeTab.getByRole('tab', { name: '轮次明细' }).click()
  await expect(activeTab.locator('.fp-sheet-table')).toContainText('中位加速比 1.11x')

  // DOCX rich document preview
  await resourceList.getByRole('button', { name: /spec\.docx/ }).click()
  await expect(activeTab.locator('.fp-doc-page h1')).toHaveText('InferRSI 评审设计文档')

  // PPTX slide deck preview + slide switching
  await resourceList.getByRole('button', { name: /roadmap\.pptx/ }).click()
  await expect(activeTab.locator('.fp-slide-card')).toContainText('第一页：方案概览')
  await activeTab.getByRole('button', { name: '下一张幻灯片' }).click()
  await expect(activeTab.locator('.fp-slide-card')).toContainText('第二页：CLI 入口扩展')

  // IPYNB notebook preview (from linked rich artifact card)
  await resourceList.getByRole('button', { name: /analysis\.ipynb/ }).click()
  await expect(activeTab.locator('.fp-ipynb-wrap')).toContainText('In [1]:')
  await expect(activeTab.locator('.fp-ipynb-wrap')).toContainText('median=1.11x')

  // PDF canvas preview via inline Markdown link (verifying pdfjs-dist worker & Electron CSP)
  await log.getByRole('button', { name: 'paper.pdf', exact: true }).click()
  const pdfCanvas = activeTab.locator('canvas.fp-pdf-canvas')
  await expect(pdfCanvas).toBeVisible()
  await expect.poll(() => pdfCanvas.evaluate(c => c.width)).toBeGreaterThan(100)

  // SVG preview + zoom + source toggle
  await log.getByRole('button', { name: 'architecture.svg', exact: true }).click()
  await expect(activeTab.locator('img.fp-image')).toBeVisible()
  await activeTab.getByRole('button', { name: '放大预览' }).click()
  await expect(activeTab.getByTitle('重置缩放')).toHaveText('125%')
  await activeTab.getByRole('tab', { name: '源码' }).click()
  await expect(activeTab.locator('.fp-code-wrap')).toContainText('<svg')

  // LaTeX (.tex) preview + KaTeX rendering
  await log.getByRole('button', { name: 'notes.tex', exact: true }).click()
  await expect(activeTab.locator('.fp-doc-page h1')).toHaveText('配对加速比推导')
  await expect(activeTab.locator('.fp-doc-page .katex')).toBeVisible()

  // 7. Verify dark mode adaptation cleanly
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(activeTab.locator('.fp-doc-page')).toBeVisible()

  // 8. Verify Antigravity brain/<sessionId>/jinsiwei_interview_questions.md artifact opens & renders without path error
  await page.emulateMedia({ colorScheme: 'light' })
  await page.getByTitle('江苏金思维开发岗位面经生成', { exact: true }).click()
  const agyCard = page.getByLabel('生成与更新的文件').getByRole('button', { name: /jinsiwei_interview_questions\.md/ })
  await expect(agyCard).toBeVisible()
  await agyCard.click()
  const agyPreviewTab = page.getByLabel('右侧工作区').locator('.wp-tab-body:not([hidden])')
  await expect(agyPreviewTab.locator('.fp-doc-page h1')).toHaveText('江苏金思维开发岗位面经题库')
  await expect(agyPreviewTab).not.toContainText('只能预览当前会话工作目录内的文件')

  // 9. Verify "重新授权" is hidden on non-auth task failures and shown ONLY on expired auth
  await page.getByTitle('权限与过期校验对话', { exact: true }).click()
  const nonAuthArticle = page.locator('#message-m2')
  const expiredAuthArticle = page.locator('#message-m3')
  await expect(nonAuthArticle).toContainText('连续 10 分钟没有新进展')
  await expect(nonAuthArticle.getByRole('button', { name: '重新授权' })).toHaveCount(0)
  await expect(expiredAuthArticle).toContainText('访问令牌已过期')
  await expect(expiredAuthArticle.getByRole('button', { name: '重新授权' })).toHaveCount(1)

  expect(pageErrors).toEqual([])
  console.log('Passed: Codex conversation timeline, shimmer/disclosure animations, colored subagents, tool activity scroll/floating button, GFM/KaTeX, line-targeted code preview, and HTML/XLSX/DOCX/PPTX/IPYNB click-to-render.')
} finally {
  await app?.close()
  await rm(root, { recursive: true, force: true })
}
