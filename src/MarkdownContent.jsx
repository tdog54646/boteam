import React, { useMemo, useState } from "react";
import { Check, Copy, ExternalLink, FileCode2, FileSpreadsheet, FileText, Image as ImageIcon, Presentation } from "lucide-react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import katex from "katex";
import "katex/dist/katex.min.css";
import { linkedChatId } from "../desktop/chat-transfer.mjs";
import { classifyPreviewFile, fileBasename, parseFileReference } from "../desktop/file-preview-rules.mjs";

const remarkPlugins = [remarkGfm, remarkMath];
const rehypePlugins = [[rehypeKatex, { strict: false, throwOnError: false }]];

const KEYWORD_RE = /\b(async|await|break|case|catch|class|const|continue|def|default|defer|delete|do|elif|else|enum|export|extends|false|finally|fn|for|from|func|function|go|if|impl|import|in|interface|let|loop|match|mod|mut|new|nil|None|null|override|package|pass|private|protected|pub|public|raise|readonly|return|select|self|static|struct|super|switch|template|then|this|throw|trait|true|try|type|typeof|undefined|union|unsafe|use|using|var|virtual|void|where|while|with|yield|SELECT|FROM|WHERE|JOIN|LEFT|RIGHT|INNER|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|INDEX|ALTER|ADD|COLUMN|PRIMARY|KEY|ORDER|BY|GROUP|LIMIT)\b/g;

export function highlightCodeLine(line, language) {
  if (!line || line.length > 600 || language === "text") return line;
  const tokens = [];
  const tokenRegex =
    /(\/\/.*$|#(?!!).*$|--\s.*$|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b0x[0-9a-fA-F]+\b|\b\d+(?:\.\d+)?\b)/gm;
  let lastIndex = 0;
  let match;
  const pushPlain = (segment, baseKey) => {
    if (!segment) return;
    let kwLast = 0;
    let kw;
    KEYWORD_RE.lastIndex = 0;
    while ((kw = KEYWORD_RE.exec(segment)) !== null) {
      if (kw.index > kwLast) tokens.push(segment.slice(kwLast, kw.index));
      tokens.push(
        <span className="tok-kw" key={`${baseKey}-k-${kw.index}`}>
          {kw[0]}
        </span>,
      );
      kwLast = kw.index + kw[0].length;
    }
    if (kwLast < segment.length) tokens.push(segment.slice(kwLast));
  };

  while ((match = tokenRegex.exec(line)) !== null) {
    if (match.index > lastIndex) {
      pushPlain(line.slice(lastIndex, match.index), lastIndex);
    }
    const val = match[0];
    const cls =
      val.startsWith("//") || val.startsWith("#") || val.startsWith("--")
        ? "tok-comment"
        : val.startsWith('"') || val.startsWith("'") || val.startsWith("`")
          ? "tok-str"
          : "tok-num";
    tokens.push(
      <span className={cls} key={`t-${match.index}`}>
        {val}
      </span>,
    );
    lastIndex = match.index + val.length;
  }
  if (lastIndex < line.length) pushPlain(line.slice(lastIndex), lastIndex);
  return tokens.length ? tokens : line;
}

function GitHubMark() {
  return (
    <svg className="md-link-glyph" width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8a8.01 8.01 0 0 0 5.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

export function FileCategoryGlyph({ filePath, size = 14 }) {
  const spec = classifyPreviewFile(filePath || "");
  if (spec.category === "spreadsheet") return <FileSpreadsheet size={size} className="fc-spreadsheet" aria-hidden="true" />;
  if (spec.category === "presentation") return <Presentation size={size} className="fc-presentation" aria-hidden="true" />;
  if (spec.category === "image") return <ImageIcon size={size} className="fc-image" aria-hidden="true" />;
  if (spec.category === "code" || spec.category === "html") return <FileCode2 size={size} className="fc-code" aria-hidden="true" />;
  return <FileText size={size} className={`fc-${spec.category}`} aria-hidden="true" />;
}

function CodeBlock({ language, raw }) {
  const [copied, setCopied] = useState(false);

  if (language === "math" || language === "katex") {
    const html = katex.renderToString(raw.trim(), { displayMode: true, throwOnError: false, strict: false });
    return <div className="md-math-block" dangerouslySetInnerHTML={{ __html: html }} />;
  }

  const lines = useMemo(() => {
    const trimmed = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
    return trimmed.split("\n");
  }, [raw]);

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(raw);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {}
  }

  return (
    <div className="md-codeblock">
      <div className="md-codeblock-head">
        <span className="md-codeblock-lang">{language || "code"}</span>
        <button type="button" className="md-codeblock-copy" onClick={copyCode} aria-label="复制代码">
          {copied ? <Check size={13} /> : <Copy size={13} />}
          <span>{copied ? "已复制" : "复制"}</span>
        </button>
      </div>
      <pre>
        <code>
          {lines.map((line, i) => (
            <React.Fragment key={i}>
              {highlightCodeLine(line, language)}
              {i < lines.length - 1 ? "\n" : ""}
            </React.Fragment>
          ))}
        </code>
      </pre>
    </div>
  );
}

function markdownUrlTransform(url) {
  if (!url) return "";
  if (linkedChatId(url)) return url;
  if (/^(?:file:\/\/|sandbox:|https?:\/\/|mailto:)/i.test(url)) return url;
  if (/^(?:javascript|vbscript|data):/i.test(url.trim())) return "";
  if (url.startsWith("/") || url.startsWith("./") || url.startsWith("../") || /^[\w.\u4e00-\u9fff/-]+(?::\d+|#L\d+)?$/i.test(url)) {
    return url;
  }
  return defaultUrlTransform(url);
}

function flattenText(children) {
  let out = "";
  React.Children.forEach(children, (child) => {
    if (typeof child === "string" || typeof child === "number") out += String(child);
    else if (React.isValidElement(child) && child.props?.children) out += flattenText(child.props.children);
  });
  return out;
}

export function normalizeMarkdownMath(input) {
  if (typeof input !== "string" || !input) return "";
  if (!input.includes("$$") && !input.includes("\\[") && !input.includes("\\(")) return input;
  const codeOrSpanRe =
    /(^[ \t]*(?:`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*(?:`{3,}|~{3,})[ \t]*$|(?![\s\S]))|`+[^`\n]*`+)/gm;
  const transformProse = (segment) =>
    segment
      .replace(/\\\[([\s\S]+?)\\\]/g, (_m, body) => `\n$$\n${body.trim()}\n$$\n`)
      .replace(/\\\(([^\n]+?)\\\)/g, (_m, body) => `$${body.trim()}$`)
      .replace(
        /^([ \t]*)\$\$([^\n$]+?)\$\$[ \t]*$/gm,
        (_m, indent, body) => `\n${indent}$$\n${indent}${body.trim()}\n${indent}$$\n`,
      );
  let out = "";
  let lastIndex = 0;
  let match;
  while ((match = codeOrSpanRe.exec(input)) !== null) {
    if (match.index > lastIndex) {
      out += transformProse(input.slice(lastIndex, match.index));
    }
    out += match[0];
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < input.length) {
    out += transformProse(input.slice(lastIndex));
  }
  return out;
}

export function MarkdownContent({
  text,
  onOpenChatLink,
  onOpenFile,
  onOpenUrl,
  knownFiles,
}) {
  const normalizedText = useMemo(() => normalizeMarkdownMath(text), [text]);
  function renderPlainTokens(value) {
    if (typeof value !== "string" || !value) return value;
    if (!value.toLowerCase().includes("boteam://chat/")) return value;
    return value.split(/(boteam:\/\/chat\/[a-f\d-]{36})/gi).map((part, index) =>
      linkedChatId(part) ? (
        <a
          className="chat-deeplink"
          key={index}
          href={part}
          onClick={(event) => {
            event.preventDefault();
            onOpenChatLink?.(part);
          }}
        >
          {part}
        </a>
      ) : (
        part
      ),
    );
  }

  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        urlTransform={markdownUrlTransform}
        components={{
          p: ({ children }) => <p>{React.Children.map(children, renderPlainTokens)}</p>,
          table: ({ children }) => (
            <div className="md-table-wrap">
              <table>{children}</table>
            </div>
          ),
          pre: ({ children }) => {
            const child = React.Children.toArray(children)[0];
            if (React.isValidElement(child)) {
              const cls = String(child.props?.className || "");
              const lang = cls.match(/language-([\w+-]+)/)?.[1]?.toLowerCase() || "";
              const raw = flattenText(child.props?.children);
              return <CodeBlock language={lang} raw={raw} />;
            }
            return <pre>{children}</pre>;
          },
          code: ({ className, children, ...props }) => {
            const content = flattenText(children);
            const inline = !className && !content.includes("\n");
            if (inline && onOpenFile && content.length <= 240) {
              const parsed = parseFileReference(content);
              if (
                parsed &&
                (knownFiles?.has(parsed.path) ||
                  knownFiles?.has(fileBasename(parsed.path)) ||
                  ((parsed.path.includes("/") || parsed.line != null) && /\.[a-z0-9]{1,8}$/i.test(parsed.path)))
              ) {
                return (
                  <button
                    type="button"
                    className="md-inline-file-code"
                    title={content}
                    onClick={() => onOpenFile(parsed)}
                  >
                    <code>{children}</code>
                  </button>
                );
              }
            }
            return (
              <code className={className} {...props}>
                {children}
              </code>
            );
          },
          a: ({ children, href }) => {
            if (!href) return <span>{children}</span>;
            if (linkedChatId(href)) {
              return (
                <a
                  className="chat-deeplink"
                  href={href}
                  onClick={(event) => {
                    event.preventDefault();
                    onOpenChatLink?.(href);
                  }}
                >
                  {children}
                </a>
              );
            }
            if (/^https?:\/\//i.test(href)) {
              let isGithub = false;
              try {
                const parsedUrl = new URL(href);
                isGithub = parsedUrl.hostname === "github.com" || parsedUrl.hostname.endsWith(".github.com");
              } catch {}
              if (!onOpenUrl) {
                return (
                  <span className="md-ext-link" title={href}>
                    {isGithub && <GitHubMark />}
                    {children}
                  </span>
                );
              }
              return (
                <a
                  className="md-ext-link"
                  href={href}
                  title={href}
                  onClick={(event) => {
                    event.preventDefault();
                    onOpenUrl(href);
                  }}
                >
                  {isGithub && <GitHubMark />}
                  <span>{children}</span>
                  {!isGithub && <ExternalLink size={11} className="md-ext-arrow" aria-hidden="true" />}
                </a>
              );
            }
            const fileRef = parseFileReference(href);
            if (fileRef && onOpenFile) {
              const labelText = flattenText(children).trim();
              const base = fileBasename(fileRef.path);
              const isRawPathLabel =
                !labelText ||
                labelText === href ||
                labelText === fileRef.path ||
                labelText.startsWith("/") ||
                labelText.startsWith("file://");
              const displayLabel = isRawPathLabel
                ? `${base}${fileRef.line ? `:${fileRef.line}` : ""}`
                : labelText;
              const tooltip = `${fileRef.path}${fileRef.line ? `:${fileRef.line}` : ""}`;
              return (
                <button
                  type="button"
                  className="md-file-link"
                  title={tooltip}
                  onClick={() => onOpenFile(fileRef)}
                >
                  <FileCategoryGlyph filePath={fileRef.path} size={13} />
                  <span>{displayLabel}</span>
                </button>
              );
            }
            return (
              <span className="link-text" title={href}>
                {children}
              </span>
            );
          },
          img: ({ alt, src }) =>
            src && /^data:image\//i.test(src) ? (
              <img className="md-inline-img" alt={alt || ""} src={src} />
            ) : (
              <span>{alt || "图片"}</span>
            ),
        }}
      >
        {normalizedText}
      </ReactMarkdown>
    </div>
  );
}
