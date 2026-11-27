import { useLanguage } from "./preferences";
import React, { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  FileCode2,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  Globe2,
  Image as ImageIcon,
  Minus,
  Music,
  Pencil,
  Plus,
  Presentation,
  RefreshCw,
  Video,
} from "lucide-react";
import { classifyPreviewFile, fileBasename, formatByteLimit } from "../desktop/file-preview-rules.mjs";
import { highlightCodeLine, MarkdownContent } from "./MarkdownContent";
import { Button, IconButton, Notice, Spinner } from "./ui";
import "./file-preview.css";

const PdfPreview = lazy(() => import("./PdfPreview"));

const ANSI_ESCAPE_RE = /\u001b\[[0-9;]*m/g;

function columnLabel(index) {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export function canTogglePreviewSource(file) {
  if (!file || file.oversize) return false;
  if (file.content == null) return false;
  return ["markdown", "html", "svg", "ipynb", "tex", "mermaid", "json", "spreadsheet"].includes(
    file.previewKind,
  );
}

export function canZoomPreview(file, viewMode) {
  if (!file || file.oversize) return false;
  if (file.previewKind === "image" && file.src) return true;
  if (file.previewKind === "pdf" && file.base64) return true;
  if (file.previewKind === "svg" && file.svgSrc && viewMode === "preview") return true;
  return false;
}

const HTML_SANDBOX_CSP =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' data: blob:; style-src 'unsafe-inline' data: blob:; img-src data: blob:; media-src data: blob:; font-src data: blob:; worker-src blob: data:; connect-src data: blob:; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";

const HTML_SANDBOX_SHIM = `<script>(function(){function m(){var d=Object.create(null);return{get length(){return Object.keys(d).length},key:function(i){var k=Object.keys(d);return i>=0&&i<k.length?k[i]:null},getItem:function(k){k=String(k);return Object.prototype.hasOwnProperty.call(d,k)?d[k]:null},setItem:function(k,v){d[String(k)]=String(v)},removeItem:function(k){delete d[String(k)]},clear:function(){d=Object.create(null)}};}["localStorage","sessionStorage"].forEach(function(n){try{var s=window[n];s.getItem("__bt");}catch(_){try{Object.defineProperty(window,n,{configurable:true,enumerable:true,value:m()});}catch(__){}}});["pushState","replaceState"].forEach(function(fn){try{var orig=history[fn];if(typeof orig==="function"){history[fn]=function(){try{return orig.apply(this,arguments);}catch(_){}};}}catch(_){}});function cp(t){try{var a=document.createElement("textarea");a.value=String(t==null?"":t);a.setAttribute("readonly","");a.style.cssText="position:fixed;top:-9999px;left:-9999px;opacity:0;pointer-events:none;";(document.body||document.documentElement).appendChild(a);a.focus();a.select();var ok=document.execCommand("copy");a.remove();return Boolean(ok);}catch(_){return false;}}try{var c=navigator.clipboard,w=c&&typeof c.writeText==="function"?c.writeText.bind(c):null,wt=function(t){if(cp(t))return Promise.resolve();return w?w(t):Promise.reject(new Error("Clipboard unavailable"));};if(c){try{Object.defineProperty(c,"writeText",{configurable:true,writable:true,value:wt});}catch(_){Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:wt}});}}else{Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:wt}});}}catch(_){}document.addEventListener("click",function(e){var a=e.target&&e.target.closest?e.target.closest("a[href]"):null;if(!a)return;var h=(a.getAttribute("href")||"").trim();if(/^(?:https?:|mailto:|tel:|\\/\\/)/i.test(h)){e.preventDefault();}},true);})();</script>`;

export function injectHtmlSandboxCsp(rawHtml) {
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${HTML_SANDBOX_CSP}">`;
  const baseStyle =
    "<style>:root{color-scheme:light dark;}body{margin:16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC',sans-serif;}</style>";
  if (/<head[\s>]/i.test(rawHtml)) {
    return rawHtml.replace(/<head([^>]*)>/i, (_, attrs = "") => `<head${attrs}>${cspMeta}${HTML_SANDBOX_SHIM}`);
  }
  if (/<html[\s>]/i.test(rawHtml)) {
    return rawHtml.replace(
      /<html([^>]*)>/i,
      (_, attrs = "") => `<html${attrs}><head><meta charset="utf-8">${cspMeta}${HTML_SANDBOX_SHIM}${baseStyle}</head>`,
    );
  }
  return `<!doctype html><html><head><meta charset="utf-8">${cspMeta}${HTML_SANDBOX_SHIM}${baseStyle}</head><body>${rawHtml}</body></html>`;
}

function CodeSourceViewer({ content, language, line, endLine, scrollTrigger }) {
  const tr = useLanguage();
  const targetRef = useRef(null);
  const lines = useMemo(() => {
    const raw = String(content ?? "");
    if (!raw) return [""];
    const normalized = raw.replace(/\r\n/g, "\n");
    return normalized.endsWith("\n") ? normalized.slice(0, -1).split("\n") : normalized.split("\n");
  }, [content]);

  const startTarget = Number.isInteger(line) && line > 0 ? line : null;
  const endTarget =
    startTarget != null
      ? Number.isInteger(endLine) && endLine >= startTarget
        ? endLine
        : startTarget
      : null;

  useEffect(() => {
    if (startTarget != null && targetRef.current) {
      targetRef.current.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [startTarget, endTarget, scrollTrigger]);

  const enableSyntax = lines.length <= 4000;

  return (
    <div className="fp-code-wrap" role="region" aria-label={tr("代码与文本视图", "Code and text view")}>
      <div className="fp-code-table">
        {lines.map((lineText, idx) => {
          const lineNo = idx + 1;
          const highlighted = startTarget != null && lineNo >= startTarget && lineNo <= endTarget;
          return (
            <div
              key={lineNo}
              ref={lineNo === startTarget ? targetRef : undefined}
              data-line={lineNo}
              className={`fp-code-line ${highlighted ? "is-target" : ""}`}
            >
              <span className="fp-line-no">{lineNo}</span>
              <span className="fp-line-code">
                {enableSyntax ? highlightCodeLine(lineText, language || "text") : lineText}
                {lineText === "" ? "\u200b" : ""}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function HtmlSandboxPreview({ html }) {
  const tr = useLanguage();
  const preparedHtml = useMemo(() => injectHtmlSandboxCsp(html || ""), [html]);
  const [previewState, setPreviewState] = useState({ html: "", url: null, useSrcDoc: false });

  useEffect(() => {
    let cancelled = false;
    if (!window.boteam?.invoke) {
      setPreviewState({ html: preparedHtml, url: null, useSrcDoc: true });
      return () => {
        cancelled = true;
      };
    }
    window.boteam
      .invoke("stageHtmlPreview", { html: preparedHtml })
      .then((url) => {
        if (cancelled) return;
        if (typeof url === "string" && url.startsWith("boteam-preview://")) {
          setPreviewState({ html: preparedHtml, url, useSrcDoc: false });
        } else {
          setPreviewState({ html: preparedHtml, url: null, useSrcDoc: true });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPreviewState({ html: preparedHtml, url: null, useSrcDoc: true });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [preparedHtml]);

  const ready = previewState.html === preparedHtml && (Boolean(previewState.url) || previewState.useSrcDoc);

  return (
    <div className="fp-html-wrap">
      {ready && (
        <iframe
          className="fp-html-frame"
          title={tr("HTML 预览", "HTML preview")}
          sandbox="allow-scripts"
          src={previewState.url || undefined}
          srcDoc={previewState.useSrcDoc ? preparedHtml : undefined}
        />
      )}
    </div>
  );
}

function ImageStagePreview({ src, alt, zoom = 1 }) {
  const tr = useLanguage();
  const pct = Math.round(zoom * 100);
  return (
    <div className="fp-image-stage">
      <img
        className="fp-image wp-image"
        alt={alt || tr("图片预览", "Image preview")}
        src={src}
        style={zoom !== 1 ? { width: `${pct}%`, maxWidth: "none" } : undefined}
      />
    </div>
  );
}

function SpreadsheetPreview({ structured }) {
  const tr = useLanguage();
  const sheets = structured?.sheets || [];
  const [sheetIdx, setSheetIdx] = useState(0);
  useEffect(() => {
    setSheetIdx(0);
  }, [structured]);

  if (!sheets.length) return <p className="wp-empty">{tr("表格内容为空。", "This sheet is empty.")}</p>;
  const active = sheets[Math.min(sheetIdx, sheets.length - 1)] || sheets[0];
  const colCount = Math.max(active.colCount || 0, 1);
  const cols = Array.from({ length: colCount }, (_, idx) => columnLabel(idx));

  return (
    <div className="fp-sheet-container">
      <div className="fp-sheet-scroll">
        <table className="fp-sheet-table">
          <thead>
            <tr>
              <th className="fp-sheet-corner" aria-label={tr("行号", "Row number")}>#</th>
              {cols.map((label) => (
                <th key={label}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {active.rows.length ? (
              active.rows.map((row, rIdx) => (
                <tr key={rIdx}>
                  <td className="fp-sheet-rownum">{rIdx + 1}</td>
                  {cols.map((col, cIdx) => (
                    <td key={col}>{row[cIdx] ?? ""}</td>
                  ))}
                </tr>
              ))
            ) : (
              <tr>
                <td className="fp-sheet-rownum">1</td>
                <td colSpan={colCount} className="fp-sheet-empty">
                  {tr("（工作表为空）", "(Empty sheet)")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="fp-sheet-footer">
        {sheets.length > 1 && (
          <div className="fp-sheet-tabs" role="tablist" aria-label={tr("工作表切换", "Switch sheet")}>
            {sheets.map((s, idx) => (
              <button
                key={`${s.name}-${idx}`}
                type="button"
                role="tab"
                aria-selected={idx === sheetIdx}
                className={`fp-sheet-tab ${idx === sheetIdx ? "active" : ""}`}
                onClick={() => setSheetIdx(idx)}
              >
                {s.name}
              </button>
            ))}
          </div>
        )}
        <span className="fp-sheet-meta">
          {tr("共", "Total")} {active.totalRows ?? active.rows.length} {tr("行 ·", " rows ·")} {active.colCount || 0} {tr("列", " columns")}
          {active.truncatedRows ? tr("（仅预览前 1,000 行）", "(Showing the first 1,000 rows)") : ""}
        </span>
      </div>
    </div>
  );
}

function renderDocxRun(run, idx, onOpenUrl) {
  let node = run.text;
  if (run.code) node = <code key={`c-${idx}`}>{node}</code>;
  if (run.bold) node = <strong key={`b-${idx}`}>{node}</strong>;
  if (run.italic) node = <em key={`i-${idx}`}>{node}</em>;
  if (run.underline) node = <u key={`u-${idx}`}>{node}</u>;
  if (run.strike) node = <del key={`s-${idx}`}>{node}</del>;
  if (run.href) {
    return (
      <a
        key={idx}
        href={run.href}
        className="md-ext-link"
        onClick={(e) => {
          e.preventDefault();
          onOpenUrl?.(run.href);
        }}
      >
        {node}
      </a>
    );
  }
  return <React.Fragment key={idx}>{node}</React.Fragment>;
}

function DocxDocumentPreview({ structured, onOpenUrl }) {
  const tr = useLanguage();
  const blocks = structured?.blocks || [];
  if (!blocks.length) return <p className="wp-empty">{tr("文档正文为空。", "This document has no text.")}</p>;

  return (
    <div className="fp-doc-stage">
      <article className="fp-doc-page">
        {blocks.map((block, idx) => {
          if (block.type === "table") {
            return (
              <div className="md-table-wrap" key={idx}>
                <table className="fp-doc-table">
                  <tbody>
                    {block.rows.map((row, rIdx) => (
                      <tr key={rIdx}>
                        {row.map((cell, cIdx) => {
                          const CellTag = rIdx === 0 ? "th" : "td";
                          return (
                            <CellTag key={cIdx} colSpan={cell.colSpan || undefined}>
                              {cell.text}
                            </CellTag>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          }

          const alignStyle =
            block.align === "center" || block.align === "right"
              ? { textAlign: block.align }
              : undefined;
          const content = (
            <>
              {block.runs?.map((r, rIdx) => renderDocxRun(r, rIdx, onOpenUrl))}
              {block.images?.map((src, imgIdx) => (
                <img key={`img-${imgIdx}`} className="fp-doc-img" src={src} alt="" />
              ))}
            </>
          );

          if (block.level >= 1 && block.level <= 6) {
            const HeadingTag = `h${block.level}`;
            return (
              <HeadingTag key={idx} style={alignStyle}>
                {content}
              </HeadingTag>
            );
          }
          if (block.list) {
            return (
              <div
                key={idx}
                className="fp-doc-listitem"
                style={{ paddingLeft: `${18 + (block.listLevel || 0) * 18}px`, ...alignStyle }}
              >
                <span className="fp-doc-bullet" aria-hidden="true">•</span>
                <div>{content}</div>
              </div>
            );
          }
          return (
            <p key={idx} style={alignStyle}>
              {content}
            </p>
          );
        })}
      </article>
    </div>
  );
}

function PptxSlidesPreview({ structured }) {
  const tr = useLanguage();
  const slides = structured?.slides || [];
  const [activeSlide, setActiveSlide] = useState(0);
  useEffect(() => {
    setActiveSlide(0);
  }, [structured]);

  if (!slides.length) return <p className="wp-empty">{tr("演示文稿中未找到幻灯片。", "No slides found in this presentation.")}</p>;
  const current = slides[Math.min(activeSlide, slides.length - 1)] || slides[0];

  return (
    <div className="fp-pptx-stage">
      <div className="fp-pptx-bar">
        <IconButton
          icon={ChevronLeft}
          label={tr("上一张幻灯片", "Previous slide")}
          disabled={activeSlide <= 0}
          onClick={() => setActiveSlide((v) => Math.max(0, v - 1))}
        />
        <span className="fp-pptx-counter">
          {tr("幻灯片", "Slide")} {current.number} / {slides.length}
        </span>
        <IconButton
          icon={ChevronRight}
          label={tr("下一张幻灯片", "Next slide")}
          disabled={activeSlide >= slides.length - 1}
          onClick={() => setActiveSlide((v) => Math.min(slides.length - 1, v + 1))}
        />
      </div>

      <section className="fp-slide-card" aria-label={tr(`幻灯片 ${current.number}`, `Slide ${current.number}`)}>
        <header className="fp-slide-head">
          <span className="fp-slide-badge">{current.number}</span>
          <h2>{current.title}</h2>
        </header>
        <div className="fp-slide-body">
          {current.items?.length > 0 && (
            <ul className="fp-slide-list">
              {current.items.map((item, idx) => (
                <li key={idx} style={{ marginLeft: `${(item.level || 0) * 18}px` }}>
                  {item.text}
                </li>
              ))}
            </ul>
          )}
          {current.tables?.map((rows, tIdx) => (
            <div className="md-table-wrap" key={tIdx}>
              <table className="fp-doc-table">
                <tbody>
                  {rows.map((row, rIdx) => (
                    <tr key={rIdx}>
                      {row.map((cell, cIdx) => {
                        const Tag = rIdx === 0 ? "th" : "td";
                        return <Tag key={cIdx}>{cell}</Tag>;
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
          {current.images?.length > 0 && (
            <div className="fp-slide-images">
              {current.images.map((src, iIdx) => (
                <img key={iIdx} src={src} alt="" />
              ))}
            </div>
          )}
        </div>
      </section>

      {slides.length > 1 && (
        <div className="fp-slide-strip" role="tablist" aria-label={tr("幻灯片列表", "Slides")}>
          {slides.map((s, idx) => (
            <button
              key={s.number}
              type="button"
              role="tab"
              aria-selected={idx === activeSlide}
              className={`fp-slide-pill ${idx === activeSlide ? "active" : ""}`}
              onClick={() => setActiveSlide(idx)}
            >
              <span>{s.number}</span>
              <small>{s.title}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function joinNotebookSource(source) {
  if (Array.isArray(source)) return source.join("");
  return typeof source === "string" ? source : "";
}

function NotebookPreview({ content, onOpenFile, onOpenUrl }) {
  const tr = useLanguage();
  const parsed = useMemo(() => {
    try {
      const nb = JSON.parse(content || "{}");
      const lang =
        nb?.metadata?.kernelspec?.language ||
        nb?.metadata?.language_info?.name ||
        "python";
      return { cells: Array.isArray(nb?.cells) ? nb.cells : [], language: String(lang).toLowerCase() };
    } catch (err) {
      return { error: err?.message || tr("无法解析 Notebook JSON。", "Could not read notebook JSON.") };
    }
  }, [content]);

  if (parsed.error) return <Notice>{parsed.error}</Notice>;
  if (!parsed.cells.length) return <p className="wp-empty">{tr("Notebook 不包含任何单元格。", "The notebook has no cells.")}</p>;

  return (
    <div className="fp-ipynb-wrap">
      {parsed.cells.map((cell, idx) => {
        const src = joinNotebookSource(cell.source);
        if (cell.cell_type === "markdown") {
          return (
            <div className="fp-nb-cell fp-nb-markdown" key={idx}>
              <MarkdownContent text={src} onOpenFile={onOpenFile} onOpenUrl={onOpenUrl} />
            </div>
          );
        }
        const execLabel = cell.execution_count != null ? `In [${cell.execution_count}]:` : "In [ ]:";
        const outputs = Array.isArray(cell.outputs) ? cell.outputs : [];
        return (
          <div className="fp-nb-cell fp-nb-code" key={idx}>
            <div className="fp-nb-prompt">{execLabel}</div>
            <CodeSourceViewer content={src} language={parsed.language} />
            {outputs.length > 0 && (
              <div className="fp-nb-outputs">
                {outputs.map((out, oIdx) => {
                  if (out.output_type === "stream") {
                    return (
                      <pre key={oIdx} className="fp-nb-stream">
                        {joinNotebookSource(out.text)}
                      </pre>
                    );
                  }
                  if (out.output_type === "error") {
                    const tb = (out.traceback || [])
                      .join("\n")
                      .replace(ANSI_ESCAPE_RE, "");
                    return (
                      <pre key={oIdx} className="fp-nb-error">
                        {tb || `${out.ename || "Error"}: ${out.evalue || ""}`}
                      </pre>
                    );
                  }
                  const data = out.data || {};
                  if (data["image/png"]) {
                    const b64 = joinNotebookSource(data["image/png"]).trim();
                    return (
                      <img
                        key={oIdx}
                        className="fp-nb-img"
                        src={`data:image/png;base64,${b64}`}
                        alt={tr("Notebook 输出", "Notebook output")}
                      />
                    );
                  }
                  if (data["image/jpeg"]) {
                    const b64 = joinNotebookSource(data["image/jpeg"]).trim();
                    return (
                      <img
                        key={oIdx}
                        className="fp-nb-img"
                        src={`data:image/jpeg;base64,${b64}`}
                        alt={tr("Notebook 输出", "Notebook output")}
                      />
                    );
                  }
                  if (data["image/svg+xml"]) {
                    const svgRaw = joinNotebookSource(data["image/svg+xml"]);
                    const svgUrl = `data:image/svg+xml;utf8,${encodeURIComponent(svgRaw)}`;
                    return <img key={oIdx} className="fp-nb-img" src={svgUrl} alt={tr("SVG 输出", "SVG output")} />;
                  }
                  if (data["text/markdown"]) {
                    return (
                      <MarkdownContent
                        key={oIdx}
                        text={joinNotebookSource(data["text/markdown"])}
                        onOpenFile={onOpenFile}
                        onOpenUrl={onOpenUrl}
                      />
                    );
                  }
                  if (data["text/plain"]) {
                    return (
                      <pre key={oIdx} className="fp-nb-stream">
                        {joinNotebookSource(data["text/plain"])}
                      </pre>
                    );
                  }
                  return null;
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function convertLatexToMarkdown(tex) {
  let src = String(tex || "").replace(/(^|[^\\])%.*$/gm, "$1");
  const title = src.match(/\\title\{([^}]*)\}/)?.[1]?.trim();
  const author = src.match(/\\author\{([^}]*)\}/)?.[1]?.trim();
  const date = src.match(/\\date\{([^}]*)\}/)?.[1]?.trim();

  const docBody = src.match(/\\begin\{document\}([\s\S]*?)\\end\{document\}/)?.[1] || src;
  let md = docBody
    .replace(/\\maketitle/g, "")
    .replace(/\\begin\{abstract\}([\s\S]*?)\\end\{abstract\}/g, "\n> **摘要**：$1\n")
    .replace(/\\section\*?\{([^}]*)\}/g, "\n## $1\n")
    .replace(/\\subsection\*?\{([^}]*)\}/g, "\n### $1\n")
    .replace(/\\subsubsection\*?\{([^}]*)\}/g, "\n#### $1\n")
    .replace(/\\textbf\{([^}]*)\}/g, "**$1**")
    .replace(/\\textit\{([^}]*)\}/g, "*$1*")
    .replace(/\\emph\{([^}]*)\}/g, "*$1*")
    .replace(/\\texttt\{([^}]*)\}/g, "`$1`")
    .replace(/\\\[([\s\S]*?)\\\]/g, (_, expr) => `\n\`\`\`math\n${expr.trim()}\n\`\`\`\n`)
    .replace(
      /\\begin\{(equation\*?|align\*?|gather\*?)\}([\s\S]*?)\\end\{\1\}/g,
      (_, env, expr) => `\n\`\`\`math\n\\begin{${env}}${expr}\\end{${env}}\n\`\`\`\n`,
    )
    .replace(/\\begin\{(itemize|enumerate)\}/g, "\n")
    .replace(/\\end\{(itemize|enumerate)\}/g, "\n")
    .replace(/^\s*\\item\s+/gm, "- ");

  const headerLines = [];
  if (title) headerLines.push(`# ${title}`);
  if (author || date) headerLines.push(`*${[author, date].filter(Boolean).join(" · ")}*`);
  return [...headerLines, md.trim()].filter(Boolean).join("\n\n");
}

function TexPreview({ content, onOpenFile, onOpenUrl }) {
  const md = useMemo(() => convertLatexToMarkdown(content), [content]);
  return (
    <div className="fp-doc-stage">
      <article className="fp-doc-page">
        <MarkdownContent text={md} onOpenFile={onOpenFile} onOpenUrl={onOpenUrl} />
      </article>
    </div>
  );
}

function parseSimpleMermaidFlowchart(source) {
  const lines = String(source || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("%%"));
  if (!lines.length) return null;
  const header = lines[0].match(/^(?:flowchart|graph)\s+(TD|TB|LR|RL)?/i);
  if (!header) return null;
  const dir = (header[1] || "TD").toUpperCase();
  const horizontal = dir === "LR" || dir === "RL";

  const nodes = new Map();
  const edges = [];
  const ensureNode = (rawToken) => {
    const m = rawToken
      .trim()
      .match(/^([A-Za-z0-9_.-]+)(?:\s*(?:\["?([^"\]]+)"?\]|\("?([^"\)]+)"?\)|"([^"]+)"|\{"?([^"\}]+)"?\}))?$/);
    if (!m) return null;
    const id = m[1];
    const label = (m[2] || m[3] || m[4] || m[5] || nodes.get(id)?.label || id).trim();
    if (!nodes.has(id)) nodes.set(id, { id, label });
    else if (m[2] || m[3] || m[4] || m[5]) nodes.get(id).label = label;
    return id;
  };

  for (const line of lines.slice(1)) {
    if (/^(?:subgraph|end|style|classDef|class|click|linkStyle)\b/i.test(line)) continue;
    const edgeMatch = line.match(/^(.+?)\s*(?:-->|---|-\.->|==>)(?:\|([^|]+)\|)?\s*(.+)$/);
    if (edgeMatch) {
      const from = ensureNode(edgeMatch[1]);
      const to = ensureNode(edgeMatch[3]);
      if (from && to) {
        edges.push({ from, to, label: edgeMatch[2]?.trim() || "" });
        continue;
      }
    }
    ensureNode(line);
  }
  if (!nodes.size) return null;
  return { horizontal, nodes: [...nodes.values()], edges };
}

function MermaidPreview({ content }) {
  const graph = useMemo(() => parseSimpleMermaidFlowchart(content), [content]);
  if (!graph) {
    return <CodeSourceViewer content={content} language="mermaid" />;
  }

  const nodeW = 164;
  const nodeH = 44;
  const gapX = graph.horizontal ? 84 : 28;
  const gapY = graph.horizontal ? 24 : 56;
  const positioned = new Map();
  graph.nodes.forEach((node, idx) => {
    const x = graph.horizontal ? 28 + idx * (nodeW + gapX) : 64;
    const y = graph.horizontal ? 48 : 28 + idx * (nodeH + gapY);
    positioned.set(node.id, { ...node, x, y });
  });
  const width = graph.horizontal
    ? Math.max(320, 56 + graph.nodes.length * (nodeW + gapX) - gapX)
    : 300;
  const height = graph.horizontal
    ? 148
    : Math.max(140, 56 + graph.nodes.length * (nodeH + gapY) - gapY);

  return (
    <div className="fp-mermaid-stage">
      <svg className="fp-mermaid-svg" viewBox={`0 0 ${width} ${height}`} width={width} height={height}>
        <defs>
          <marker id="fp-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 1 L 10 5 L 0 9 z" fill="currentColor" />
          </marker>
        </defs>
        {graph.edges.map((edge, idx) => {
          const a = positioned.get(edge.from);
          const b = positioned.get(edge.to);
          if (!a || !b) return null;
          const x1 = graph.horizontal ? a.x + nodeW : a.x + nodeW / 2;
          const y1 = graph.horizontal ? a.y + nodeH / 2 : a.y + nodeH;
          const x2 = graph.horizontal ? b.x : b.x + nodeW / 2;
          const y2 = graph.horizontal ? b.y + nodeH / 2 : b.y;
          return (
            <g key={idx} className="fp-mermaid-edge">
              <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="currentColor" strokeWidth="1.5" markerEnd="url(#fp-arrow)" />
              {edge.label && (
                <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 6} textAnchor="middle">
                  {edge.label}
                </text>
              )}
            </g>
          );
        })}
        {[...positioned.values()].map((node) => (
          <g key={node.id} transform={`translate(${node.x}, ${node.y})`} className="fp-mermaid-node">
            <rect width={nodeW} height={nodeH} rx="10" />
            <text x={nodeW / 2} y={nodeH / 2 + 4} textAnchor="middle">
              {node.label.length > 20 ? node.label.slice(0, 19) + "…" : node.label}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

function JsonFormattedPreview({ content }) {
  const formatted = useMemo(() => {
    try {
      return JSON.stringify(JSON.parse(content || ""), null, 2);
    } catch {
      return content || "";
    }
  }, [content]);
  return <CodeSourceViewer content={formatted} language="json" />;
}

export function FilePreviewBody({
  file,
  viewMode = "preview",
  zoom = 1,
  line,
  endLine,
  scrollTrigger,
  onReveal,
  onOpenFile,
  onOpenUrl,
}) {
  const tr = useLanguage();
  if (!file) return null;

  if (file.oversize) {
    return (
      <div className="fp-oversize">
        {file.src && <img className="fp-oversize-thumb" alt={file.name} src={file.src} />}
        <p className="fp-oversize-msg">{file.limitMessage || tr("文件体积超出预览上限。", "The file exceeds the preview size limit.")}</p>
        {onReveal && (
          <Button icon={FolderOpen} onClick={onReveal}>
            {tr("在 Finder 中显示", "Show in Finder")}
          </Button>
        )}
      </div>
    );
  }

  if (file.previewError) {
    return (
      <div className="fp-oversize">
        <Notice>{file.previewError}</Notice>
        {onReveal && (
          <Button icon={FolderOpen} onClick={onReveal}>
            {tr("在 Finder 中显示", "Show in Finder")}
          </Button>
        )}
      </div>
    );
  }

  if (viewMode === "source" && file.content != null) {
    return (
      <>
        <CodeSourceViewer
          content={file.content}
          language={file.language || "text"}
          line={line}
          endLine={endLine}
          scrollTrigger={scrollTrigger}
        />
        {file.truncated && <p className="wp-empty">{tr("文件较大，仅显示前", "Large file. Showing the first")} {formatByteLimit(file.maxBytes)} {tr("内容。", " of content.")}</p>}
      </>
    );
  }

  switch (file.previewKind) {
    case "markdown":
      return (
        <div className="fp-doc-stage">
          <article className="fp-doc-page">
            <MarkdownContent text={file.content || ""} onOpenFile={onOpenFile} onOpenUrl={onOpenUrl} />
            {file.truncated && <p className="wp-empty">{tr("文件较大，仅显示部分内容。", "Large file. Showing partial content.")}</p>}
          </article>
        </div>
      );
    case "html":
      return <HtmlSandboxPreview html={file.renderedHtml || file.content || ""} />;
    case "svg":
      if (file.svgSrc) return <ImageStagePreview src={file.svgSrc} alt={file.name} zoom={zoom} />;
      break;
    case "image":
      if (file.src) return <ImageStagePreview src={file.src} alt={file.name} zoom={zoom} />;
      break;
    case "pdf":
      if (file.base64) {
        return (
          <Suspense fallback={<div className="wp-empty"><Spinner /> {tr("正在加载 PDF 预览…", "Loading PDF preview…")}</div>}>
            <PdfPreview base64={file.base64} zoom={zoom} />
          </Suspense>
        );
      }
      break;
    case "spreadsheet":
      if (file.structured) return <SpreadsheetPreview structured={file.structured} />;
      break;
    case "docx":
      if (file.structured) return <DocxDocumentPreview structured={file.structured} onOpenUrl={onOpenUrl} />;
      break;
    case "pptx":
      if (file.structured) return <PptxSlidesPreview structured={file.structured} />;
      break;
    case "ipynb":
      if (file.content != null) {
        return <NotebookPreview content={file.content} onOpenFile={onOpenFile} onOpenUrl={onOpenUrl} />;
      }
      break;
    case "tex":
      if (file.content != null) {
        return <TexPreview content={file.content} onOpenFile={onOpenFile} onOpenUrl={onOpenUrl} />;
      }
      break;
    case "mermaid":
      if (file.content != null) return <MermaidPreview content={file.content} />;
      break;
    case "json":
      if (file.content != null) return <JsonFormattedPreview content={file.content} />;
      break;
    case "audio":
      if (file.src) {
        return (
          <div className="fp-media-stage">
            <audio controls src={file.src} className="fp-audio" />
          </div>
        );
      }
      break;
    case "video":
      if (file.src) {
        return (
          <div className="fp-media-stage">
            <video controls src={file.src} className="fp-video" />
          </div>
        );
      }
      break;
    default:
      break;
  }

  if (file.src) {
    return <ImageStagePreview src={file.src} alt={file.name} zoom={zoom} />;
  }

  if (file.binary || file.content == null) {
    return (
      <div className="fp-oversize">
        <p className="wp-empty">{tr("此文件不支持直接预览。", "A preview is unavailable for this file.")}</p>
        {onReveal && (
          <Button icon={FolderOpen} onClick={onReveal}>
            {tr("在 Finder 中显示", "Show in Finder")}
          </Button>
        )}
      </div>
    );
  }

  return (
    <>
      <CodeSourceViewer
        content={file.content}
        language={file.language || "text"}
        line={line}
        endLine={endLine}
        scrollTrigger={scrollTrigger}
      />
      {file.truncated && <p className="wp-empty">{tr("文件较大，仅显示部分内容。", "Large file. Showing partial content.")}</p>}
    </>
  );
}

export function FileTypeBadge({ filePath }) {
  const spec = classifyPreviewFile(filePath || "");
  let Icon = FileText;
  let tone = "doc";
  if (spec.category === "spreadsheet") {
    Icon = FileSpreadsheet;
    tone = "sheet";
  } else if (spec.category === "presentation") {
    Icon = Presentation;
    tone = "slide";
  } else if (spec.category === "pdf") {
    Icon = FileText;
    tone = "pdf";
  } else if (spec.category === "word-document") {
    Icon = FileText;
    tone = "word";
  } else if (spec.category === "image") {
    Icon = ImageIcon;
    tone = "image";
  } else if (spec.category === "html") {
    Icon = Globe2;
    tone = "html";
  } else if (spec.category === "notebook") {
    Icon = BookOpen;
    tone = "notebook";
  } else if (spec.category === "audio") {
    Icon = Music;
    tone = "media";
  } else if (spec.category === "video") {
    Icon = Video;
    tone = "media";
  } else if (spec.category === "code") {
    Icon = FileCode2;
    tone = "code";
  }
  return (
    <span className={`erc-badge erc-tone-${tone}`} aria-hidden="true">
      <Icon size={17} strokeWidth={1.85} />
    </span>
  );
}

export function EndResourceCard({ filePath, line, action, onOpen }) {
  const tr = useLanguage();
  const spec = classifyPreviewFile(filePath || "");
  const name = fileBasename(filePath || "");
  const actionPrefix =
    action === "added" ? tr("已生成", "Created") : action === "modified" ? tr("已更新", "Updated") : "";
  const defaultSub = [actionPrefix, spec.subtitle, line ? tr(`第 ${line} 行`, `Line ${line}`) : ""]
    .filter(Boolean)
    .join(" · ");

  return (
    <button
      type="button"
      className="end-resource-card"
      title={filePath}
      onClick={onOpen}
    >
      <FileTypeBadge filePath={filePath} />
      <span className="erc-copy">
        <strong className="erc-title">{name}</strong>
        <span className="erc-subtitle-stack">
          <span className="erc-subtitle-default">{defaultSub || tr("文件", "File")}</span>
          <span className="erc-subtitle-hover" aria-hidden="true">{tr("打开预览", "Open preview")}</span>
        </span>
      </span>
      <span className="erc-open-pill">{tr("打开", "Open")}</span>
    </button>
  );
}

export function FilePreviewToolbarControls({
  file,
  viewMode,
  setViewMode,
  zoom,
  setZoom,
  canEdit,
  onEdit,
  onReload,
  onReveal,
}) {
  const tr = useLanguage();
  const [copied, setCopied] = useState(false);
  const toggleable = canTogglePreviewSource(file);
  const zoomable = canZoomPreview(file, viewMode);

  async function copyContent() {
    if (file?.content == null) return;
    try {
      await navigator.clipboard.writeText(file.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  }

  return (
    <div className="fp-toolbar-actions">
      {file?.sizeBytes != null && (
        <span className="fp-size-pill">{formatByteLimit(file.sizeBytes)}</span>
      )}
      {toggleable && (
        <div className="fp-mode-toggle" role="tablist" aria-label={tr("预览模式", "Preview mode")}>
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === "preview"}
            className={viewMode === "preview" ? "active" : ""}
            onClick={() => setViewMode("preview")}
          >
            {tr("预览", "Preview")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === "source"}
            className={viewMode === "source" ? "active" : ""}
            onClick={() => setViewMode("source")}
          >
            {tr("源码", "Source")}
          </button>
        </div>
      )}
      {zoomable && (
        <div className="fp-zoom-bar" aria-label={tr("缩放控制", "Zoom controls")}>
          <IconButton
            icon={Minus}
            label={tr("缩小预览", "Zoom out")}
            disabled={zoom <= 0.5}
            onClick={() => setZoom((z) => Math.max(0.5, Math.round((z - 0.25) * 100) / 100))}
          />
          <button
            type="button"
            className="fp-zoom-reset"
            title={tr("重置缩放", "Reset zoom")}
            onClick={() => setZoom(1)}
          >
            {Math.round(zoom * 100)}%
          </button>
          <IconButton
            icon={Plus}
            label={tr("放大预览", "Zoom in")}
            disabled={zoom >= 3}
            onClick={() => setZoom((z) => Math.min(3, Math.round((z + 0.25) * 100) / 100))}
          />
        </div>
      )}
      {file?.content != null && (
        <IconButton
          icon={copied ? Check : Copy}
          label={copied ? tr("已复制内容", "Content copied") : tr("复制文件内容", "Copy file content")}
          onClick={copyContent}
        />
      )}
      {onReveal && (
        <IconButton icon={FolderOpen} label={tr("在 Finder 中显示", "Show in Finder")} onClick={onReveal} />
      )}
      {canEdit && onEdit && (
        <IconButton icon={Pencil} label={tr("编辑页面", "Edit page")} onClick={onEdit} />
      )}
      {onReload && (
        <IconButton icon={RefreshCw} label={tr("刷新文件内容", "Reload file")} onClick={onReload} />
      )}
    </div>
  );
}
