import React, {
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  AlarmClock,
  Brain,
  CalendarClock,
  ChevronRight,
  CircleGauge,
  CircleHelp,
  CircleUserRound,
  GitPullRequest,
  Lightbulb,
  ListCollapse,
  MessagesSquare,
  Paperclip,
  Plug,
  ShieldCheck,
  Target,
  GitFork,
  Globe,
  ListChecks,
  MessageCirclePlus,
  Network,
  SquarePen,
  Terminal,
  Workflow,
} from "lucide-react";
import {
  accountLabel,
  identityLabel,
  providerName,
  Spinner,
} from "./ui";
import "./composer-slash.css";

const icons = {
  compact: ListCollapse,
  context: CircleGauge,
  extension: Workflow,
  goal: Target,
  mcp: Paperclip,
  model: Brain,
  permission: ShieldCheck,
  plan: Lightbulb,
  prompt: MessagesSquare,
  quota: CircleGauge,
  review: GitPullRequest,
  skills: Plug,
  unavailable: CircleHelp,
};

const commandIcons = {
  browser: Globe,
  fork: GitFork,
  btw: MessageCirclePlus,
  compact: ListCollapse,
  goal: AlarmClock,
  "grill-me": ListChecks,
  new: SquarePen,
  plan: Lightbulb,
  schedule: CalendarClock,
  teamwork: Network,
};

// A second slash in the first token is a filesystem path.
export function slashToken(text) {
  return /^\/([^\s/\\]*)(?:(\s)([\s\S]*))?$/u.exec(text.trimStart());
}

export function useComposerSlash({ match, target, actions }) {
  const name = match?.[1] ?? "";
  const hasArguments = Boolean(match?.[2]);
  const args = match?.[3]?.trim() || "";
  const [hidden, setHidden] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const ready = Boolean(match && target && (actions.data || actions.error));
  const error = ready && !actions.data && actions.error;
  const commands = ready ? actions.data?.slashCommands || [] : [];
  const exact = commands.find(
    (c) => c.name.toLowerCase() === name.toLowerCase(),
  );
  const query = name.toLowerCase();
  const rows = commands.filter((c) =>
    [c.name, c.title, c.description].some((s) =>
      s?.toLowerCase().includes(query),
    ),
  );
  if (exact && rows[0] !== exact)
    rows.unshift(...rows.splice(rows.indexOf(exact), 1));
  const index = target
    ? Math.min(active, Math.max(0, rows.length - 1))
    : active;
  return {
    listId,
    match,
    name,
    args,
    hasArguments,
    ready,
    exact,
    rows,
    index,
    setActive,
    error,
    note: ready && (actions.error || actions.data?.note),
    retry: actions.retry,
    open: Boolean(
      match && !hidden && (!hasArguments || !target || !ready || error),
    ),
    reveal() {
      setHidden(false);
      setActive(0);
    },
    dismiss() {
      setHidden(true);
    },
  };
}

export function ComposerSlashMenu({
  slash,
  members,
  accounts,
  target,
  isGroup,
  onTarget,
  onChoose,
  root,
}) {
  const box = useRef(null);
  const [placement, setPlacement] = useState({});
  useLayoutEffect(() => {
    const wrap = root.current;
    const composer = wrap.querySelector(".composer");
    const area = wrap.closest(".home, .conversation");
    function measure() {
      const anchor = composer.getBoundingClientRect();
      const bounds = wrap.getBoundingClientRect();
      const visible = area?.getBoundingClientRect();
      const above = anchor.top - Math.max(0, visible?.top ?? 0);
      const below = Math.min(innerHeight, visible?.bottom ?? innerHeight) - anchor.bottom;
      const flip = above < 155 && below > above;
      setPlacement({
        ...(flip
          ? { top: anchor.bottom - bounds.top + 4 }
          : { bottom: bounds.bottom - anchor.top + 4 }),
        maxHeight: Math.min(
          320,
          Math.max(40, (flip ? below : above) - 12),
        ),
      });
    }
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(composer);
    if (area) observer.observe(area);
    area?.addEventListener("scroll", measure);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      area?.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
    };
  }, [root]);
  useLayoutEffect(() => {
    box.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest", container: "nearest" });
  }, [slash.index, slash.name, target?.id]);
  const accountFor = (bot) => accounts.find((a) => a.id === bot.accountId);
  const memberLabel = (bot) => {
    const a = accountFor(bot);
    return [bot.name, providerName(a?.provider), a?.note, identityLabel(a)]
      .filter(Boolean)
      .join(" · ");
  };
  const message = slash.note ||
    (!slash.ready
      ? "正在读取原生命令…"
      : slash.rows.length
        ? ""
        : slash.name ? "没有匹配的命令" : "当前原生工具未提供快捷命令");
  return (
    <div
      ref={box}
      className="slash-menu"
      style={placement}
      aria-label="原生快捷命令"
    >
      {isGroup && target && (
        <label className="slash-member-select">
          <CircleUserRound size={14} />
          <select
            aria-label="命令接收人"
            value={target.id}
            onChange={(e) => onTarget(e.target.value)}
          >
            {members.map((bot) => (
              <option key={bot.id} value={bot.id}>
                {memberLabel(bot)}
              </option>
            ))}
          </select>
        </label>
      )}
      {!target && <div className="slash-caption">选择执行命令的群成员</div>}
      <div
        role="listbox"
        aria-label={target ? "快捷命令" : "命令接收人"}
        id={slash.listId}
      >
        {!target &&
          members.map((bot, i) => (
            <button
              type="button"
              role="option"
              tabIndex={-1}
              id={slash.listId + "-" + i}
              key={bot.id}
              className="slash-row"
              aria-selected={i === slash.index}
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={() => slash.setActive(i)}
              onClick={() => onTarget(bot.id)}
            >
              <CircleUserRound size={15} />
              <span>{bot.name}</span>
              <small>{memberLabel(bot).slice(bot.name.length + 3)}</small>
              <ChevronRight size={13} />
            </button>
          ))}
        {target &&
          slash.rows.map((command, i) => {
            const Icon =
              commandIcons[command.name] || icons[command.action] || Terminal;
            return (
              <button
                type="button"
                role="option"
                tabIndex={-1}
                id={slash.listId + "-" + i}
                key={command.name}
                className="slash-row"
                aria-selected={i === slash.index}
                aria-disabled={command.action === "unavailable" || undefined}
                title={["/" + command.name, command.description, command.reason]
                  .filter(Boolean)
                  .join(" · ")}
                onMouseDown={(e) => e.preventDefault()}
                onMouseMove={() => slash.setActive(i)}
                onClick={() => onChoose(command)}
              >
                <Icon size={15} strokeWidth={1.7} />
                <span>{command.title || command.name}</span>
                <small>{command.reason || command.description}</small>
                {command.title && command.title !== command.name && (
                  <kbd>/{command.name}</kbd>
                )}
              </button>
            );
          })}
      </div>
      {target && message && (
        <div className="slash-status" role="status">
          {!slash.ready && <Spinner size={13} />}
          {message}
          {slash.note && slash.retry && (
            <button type="button" onClick={slash.retry}>
              重试
            </button>
          )}
        </div>
      )}
    </div>
  );
}
