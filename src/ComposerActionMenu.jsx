import React, { useLayoutEffect, useRef } from "react";
import {
  Check,
  Hand,
  Lightbulb,
  Boxes,
  Braces,
  Paperclip,
  Spline,
  Plug,
  ShieldAlert,
  ShieldCheck,
  ShieldEllipsis,
  Sparkles,
  SquarePen,
  Target,
  Text,
  Eye,
} from "lucide-react";

const permissions = {
  default: {
    title: "默认权限",
    detail: "由原生工具在需要时请求批准",
    icon: Hand,
  },
  "auto-review": {
    title: "帮我批准",
    detail: "仅对检测到的风险操作请求批准",
    icon: ShieldEllipsis,
  },
  full: {
    title: "完全访问权限",
    detail: "可不受限制地访问互联网和你电脑上的任何文件",
    icon: ShieldAlert,
  },
  "read-only": { title: "只读", detail: "允许查看文件并分析内容", icon: Eye },
  plan: { title: "计划模式", detail: "先分析并制定计划", icon: Lightbulb },
  edits: {
    title: "自动接受编辑",
    detail: "允许原生工具自动应用文件编辑",
    icon: SquarePen,
  },
  "workspace-auto": {
    title: "工作区自动执行",
    detail: "允许在工作区内自动执行操作",
    icon: ShieldCheck,
  },
};

function permissionInfo(id, provider) {
  if (id === "default" && provider === "codex")
    return {
      title: "请求批准",
      detail: "编辑外部文件和使用互联网时始终询问",
      icon: Hand,
    };
  return permissions[id] || { title: id, icon: ShieldCheck };
}

export function permissionLabel(id, provider) {
  return id === "full" ? "完全访问" : permissionInfo(id, provider).title;
}

function moveBetweenRows(event) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const rows = [
    ...event.currentTarget.querySelectorAll("[data-command]:enabled"),
  ];
  const index = rows.indexOf(document.activeElement);
  if (!rows.length || index < 0) return;
  event.preventDefault();
  let next = index + (event.key === "ArrowUp" ? -1 : 1);
  if (event.key === "Home") next = 0;
  if (event.key === "End") next = rows.length - 1;
  rows[(next + rows.length) % rows.length].focus();
}

function focusHoveredRow(event) {
  const row = event.target.closest("[data-command]:enabled");
  if (event.pointerType === "mouse" && row && row !== document.activeElement)
    row.focus({ preventScroll: true });
}

function setTabStop(event) {
  const focused = event.target.closest("[data-command]");
  if (!focused) return;
  const last = event.currentTarget.querySelector(
    '[data-command][tabindex="0"]',
  );
  if (last && last !== focused) last.tabIndex = -1;
  focused.tabIndex = 0;
}

function useCommandFocus() {
  const ref = useRef(null);
  useLayoutEffect(() => {
    ref.current
      ?.querySelector("[data-command]:enabled")
      ?.focus({ preventScroll: true });
  }, []);
  return ref;
}

export function ApprovalMenu({
  modes,
  provider,
  value,
  onChoose,
  onLearn,
  busy,
  memberPicker,
  catalogError,
  retry,
}) {
  const ref = useCommandFocus();
  return (
    <div
      ref={ref}
      className="approval-menu"
      onKeyDown={moveBetweenRows}
      onFocusCapture={setTabStop}
      onPointerMove={focusHoveredRow}
    >
      <div className="approval-heading">
        <span>
          应如何批准{" "}
          {provider === "codex"
            ? "ChatGPT"
            : provider === "claude"
              ? "Claude"
              : "Antigravity"}{" "}
          操作？
        </span>
        <button type="button" onClick={onLearn}>
          了解更多
        </button>
      </div>
      {memberPicker}
      <div role="menu" aria-label="批准方式">
        {modes.map((id) => {
          const { title, detail, icon: Icon } = permissionInfo(id, provider);
          return (
            <button
              type="button"
              key={id}
              className={"approval-row permission-" + id}
              role="menuitemradio"
              aria-checked={value === id}
              aria-label={title}
              disabled={busy}
              tabIndex={-1}
              data-command
              onClick={() => onChoose(id)}
            >
              <Icon size={16} strokeWidth={1.65} aria-hidden="true" />
              <span className="approval-copy">
                <span>{title}</span>
                <small>{detail}</small>
              </span>
              {value === id && (
                <Check
                  className="approval-check"
                  size={15}
                  aria-hidden="true"
                />
              )}
            </button>
          );
        })}
      </div>
      {catalogError && (
        <p className="catalog-state">
          {catalogError}{" "}
          <button className="text-btn" type="button" onClick={retry}>
            重试
          </button>
        </p>
      )}
    </div>
  );
}

export function ApprovalDetails({ modes, provider, onReadOnly, busy }) {
  return (
    <div className="approval-details">
      {modes.map((mode) => {
        const { title, detail } = permissionInfo(mode, provider);
        return (
          <section key={mode}>
            <h3>{title}</h3>
            <p>
              {mode === "full"
                ? "允许原生工具在工作区外读写文件并使用网络。BoTeam 仍隔离订阅账号的登录凭据。"
                : detail + "。"}
            </p>
          </section>
        );
      })}
      {onReadOnly && (
        <button disabled={busy} className="text-btn" onClick={onReadOnly}>
          使用只读模式
        </button>
      )}
    </div>
  );
}

function CommandRow({ icon: Icon, label, detail, selected, accent, onClick }) {
  return (
    <button
      type="button"
      role="menuitem"
      className="add-command"
      tabIndex={-1}
      data-command
      title={[label, detail].filter(Boolean).join(" · ")}
      onClick={onClick}
    >
      <Icon
        size={15}
        strokeWidth={1.7}
        style={accent ? { color: accent } : undefined}
        aria-hidden="true"
      />
      <span className="command-label">{label}</span>
      {detail && <span className="command-detail">{detail}</span>}
      {selected && (
        <Check className="command-check" size={14} aria-hidden="true" />
      )}
    </button>
  );
}

export function AddMenu({
  skillsOnly = false,
  memberPicker,
  actions,
  loading,
  loadError,
  retry,
  onFiles,
  onSnippet,
  onSketch,
  onEditor,
  onGoal,
  onPlan,
  planActive,
  selected,
  onNative,
}) {
  const ref = useCommandFocus();
  const extensions = (actions?.extensions || []).filter(
    (item) => !skillsOnly || item.kind === "skill",
  );
  const groups = [
    [
      "插件",
      extensions.filter(
        (item) => item.kind === "plugin" || item.kind === "app",
      ),
    ],
    ["技能", extensions.filter((item) => item.kind === "skill")],
  ];
  return (
    <div
      ref={ref}
      className="add-commands"
      onKeyDown={moveBetweenRows}
      onFocusCapture={setTabStop}
      onPointerMove={focusHoveredRow}
    >
      {memberPicker}
      <div role="menu" aria-label="添加">
        {!skillsOnly && (
          <div role="group" aria-label="添加">
            <h3>添加</h3>
            <CommandRow
              icon={Paperclip}
              label="文件和文件夹"
              onClick={onFiles}
            />
            <CommandRow
              icon={Braces}
              label="附加编辑器选区"
              detail="粘贴选中的代码"
              onClick={onEditor}
            />
            {actions?.goal && (
              <CommandRow
                icon={Target}
                label="目标"
                detail="设置要持续追求的目标"
                onClick={onGoal}
              />
            )}
            {actions?.plan && (
              <CommandRow
                icon={Lightbulb}
                label="计划模式"
                detail={planActive ? "关闭计划模式" : "开启计划模式"}
                selected={planActive}
                onClick={onPlan}
              />
            )}
            <CommandRow
              icon={Text}
              label="添加文本"
              detail="粘贴文字片段"
              onClick={onSnippet}
            />
            <CommandRow
              icon={Spline}
              accent="light-dark(#00aa9d, #53d8c9)"
              label="绘图"
              detail="绘制草图"
              onClick={onSketch}
            />
          </div>
        )}
        {groups.map(
          ([heading, items]) =>
            items.length > 0 && (
              <div key={heading} role="group" aria-label={heading}>
                <h3>{heading}</h3>
                {items.map((item) => (
                  <CommandRow
                    key={item.id}
                    icon={
                      item.kind === "skill"
                        ? Sparkles
                        : item.kind === "app"
                          ? Boxes
                          : Plug
                    }
                    accent={item.kind === "app" ? "var(--accent)" : undefined}
                    label={item.label}
                    detail={item.description}
                    selected={selected.some((entry) => entry.id === item.id)}
                    onClick={() => onNative(item)}
                  />
                ))}
              </div>
            ),
        )}
      </div>
      {loading && (
        <p role="status" className="catalog-state">
          正在读取原生操作…
        </p>
      )}
      {actions && !extensions.length && !loading && !loadError && (
        <p className="catalog-state">此成员没有可添加的插件或技能。</p>
      )}
      {loadError && (
        <p className="catalog-state">
          {loadError}{" "}
          <button type="button" className="text-btn" onClick={retry}>
            重试
          </button>
        </p>
      )}
    </div>
  );
}
