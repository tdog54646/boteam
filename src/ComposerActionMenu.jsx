import { useLanguage } from "./preferences";
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

const permissions = (tr) => ({
  inherit: {
    title: tr("使用项目或 Bot 默认权限", "Use project or bot default"),
    detail: tr("跟随设置中的工具审批与文件访问选项", "Follow tool approval and file access settings"),
    icon: ShieldCheck,
  },
  default: {
    title: tr("默认权限", "Default permissions"),
    detail: tr("由原生工具在需要时请求批准", "Let the CLI request approval when needed"),
    icon: Hand,
  },
  "auto-review": {
    title: tr("帮我批准", "Auto-review"),
    detail: tr("仅对检测到的风险操作请求批准", "Ask for approval for detected risks"),
    icon: ShieldEllipsis,
  },
  full: {
    title: tr("完全访问权限", "Full access"),
    detail: tr("可不受限制地访问互联网和你电脑上的任何文件", "Allow unrestricted internet and file access"),
    icon: ShieldAlert,
  },
  "read-only": { title: tr("只读", "Read-only"), detail: tr("允许查看文件并分析内容", "Read and analyze files"), icon: Eye },
  plan: { title: tr("计划模式", "Plan mode"), detail: tr("先分析并制定计划", "Analyze and plan first"), icon: Lightbulb },
  edits: {
    title: tr("自动接受编辑", "Accept edits"),
    detail: tr("允许原生工具自动应用文件编辑", "Let the CLI apply file edits automatically"),
    icon: SquarePen,
  },
  "workspace-auto": {
    title: tr("工作区自动执行", "Workspace auto"),
    detail: tr("允许在工作区内自动执行操作", "Allow automatic actions in the workspace"),
    icon: ShieldCheck,
  },
});

export function permissionInfo(id, provider, tr) {
  if (id === "default" && provider === "codex")
    return {
      title: tr("请求批准", "Ask for approval"),
      detail: tr("编辑外部文件和使用互联网时始终询问", "Ask before editing external files or using the internet"),
      icon: Hand,
    };
  return permissions(tr)[id] || { title: id, icon: ShieldCheck };
}

export function permissionLabel(id, provider, tr) {
  return id === "full" ? tr("完全访问", "Full access") : permissionInfo(id, provider, tr).title;
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
  const tr = useLanguage();
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
          {tr("应如何批准", "How should")}{" "}
          {provider === "codex"
            ? "ChatGPT"
            : provider === "claude"
              ? "Claude"
              : "Antigravity"}{" "}
          {tr("操作？", "actions be approved?")}
        </span>
        <button type="button" onClick={onLearn}>
          {tr("了解更多", "Learn more")}
        </button>
      </div>
      {memberPicker}
      <div role="menu" aria-label={tr("批准方式", "Approval mode")}>
        {modes.map((id) => {
          const { title, detail, icon: Icon } = permissionInfo(id, provider, tr);
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
          {retry && <button className="text-btn" type="button" onClick={retry}>
            {tr("重试", "Retry")}
          </button>}
        </p>
      )}
    </div>
  );
}

export function ApprovalDetails({ modes, provider, onReadOnly, busy }) {
  const tr = useLanguage();
  return (
    <div className="approval-details">
      {modes.map((mode) => {
        const { title, detail } = permissionInfo(mode, provider, tr);
        return (
          <section key={mode}>
            <h3>{title}</h3>
            <p>
              {mode === "full"
                ? tr("允许原生工具在工作区外读写文件并使用网络。BoTeam 仍隔离订阅账号的登录凭据。", "Allow the CLI to use the network and read or write files outside the workspace. BoTeam keeps subscription credentials isolated.")
                : detail + "。"}
            </p>
          </section>
        );
      })}
      {onReadOnly && (
        <button disabled={busy} className="text-btn" onClick={onReadOnly}>
          {tr("使用只读模式", "Use read-only mode")}
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
  const tr = useLanguage();
  const ref = useCommandFocus();
  const extensions = (actions?.extensions || []).filter(
    (item) => !skillsOnly || item.kind === "skill",
  );
  const groups = [
    [
      tr("插件", "Plugins"),
      extensions.filter(
        (item) => item.kind === "plugin" || item.kind === "app",
      ),
    ],
    [tr("技能", "Skills"), extensions.filter((item) => item.kind === "skill")],
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
      <div role="menu" aria-label={tr("添加", "Add")}>
        {!skillsOnly && (
          <div role="group" aria-label={tr("添加", "Add")}>
            <h3>{tr("添加", "Add")}</h3>
            <CommandRow
              icon={Paperclip}
              label={tr("文件和文件夹", "Files and folders")}
              onClick={onFiles}
            />
            <CommandRow
              icon={Braces}
              label={tr("附加编辑器选区", "Attach editor selection")}
              detail={tr("粘贴选中的代码", "Paste selected code")}
              onClick={onEditor}
            />
            {actions?.goal && (
              <CommandRow
                icon={Target}
                label={tr("目标", "Goal")}
                detail={tr("设置要持续追求的目标", "Set an ongoing goal")}
                onClick={onGoal}
              />
            )}
            {actions?.plan && (
              <CommandRow
                icon={Lightbulb}
                label={tr("计划模式", "Plan mode")}
                detail={planActive ? tr("关闭计划模式", "Disable plan mode") : tr("开启计划模式", "Enable plan mode")}
                selected={planActive}
                onClick={onPlan}
              />
            )}
            <CommandRow
              icon={Text}
              label={tr("添加文本", "Add text")}
              detail={tr("粘贴文字片段", "Paste a text snippet")}
              onClick={onSnippet}
            />
            <CommandRow
              icon={Spline}
              accent="light-dark(#00aa9d, #53d8c9)"
              label={tr("绘图", "Draw")}
              detail={tr("绘制草图", "Draw a sketch")}
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
          {tr("正在读取原生操作…", "Loading CLI actions…")}
        </p>
      )}
      {actions && !extensions.length && !loading && !loadError && (
        <p className="catalog-state">{tr("此成员没有可添加的插件或技能。", "No plugins or skills are available for this member.")}</p>
      )}
      {loadError && (
        <p className="catalog-state">
          {loadError}{" "}
          {retry && <button type="button" className="text-btn" onClick={retry}>
            {tr("重试", "Retry")}
          </button>}
        </p>
      )}
    </div>
  );
}
