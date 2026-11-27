import { useLanguage } from "./preferences";
import React, {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Plus } from "lucide-react";
import { createPortal } from "react-dom";
import { accountLabel, errorText, Modal, Select } from "./ui";
import { NativeModelPicker, describeModel, modelLabelFor } from "./NativeModelPicker";
import { useModelCatalog } from "./useModelCatalog";

import {
  AddMenu,
  ApprovalMenu,
  ApprovalDetails,
  permissionLabel,
} from "./ComposerActionMenu";

export function ToolPopover({
  id,
  popup,
  setPopup,
  label,
  trigger,
  className = "",
  children,
  inspect = false,
  trailing = false,
  alignToTrigger = false,
  placement = "control",
  disabled = false,
}) {
  const open = popup?.id === id;
  const slot = useRef(null);
  const button = useRef(null);
  const panel = useRef(null);
  const leaveTimer = useRef(null);
  useEffect(() => () => clearTimeout(leaveTimer.current), []);
  const previousOpen = useRef(false);
  useLayoutEffect(() => {
    if (
      previousOpen.current &&
      !open &&
      placement !== "control" &&
      document.activeElement === document.body
    )
      button.current?.focus({ preventScroll: true });
    previousOpen.current = open;
  }, [open, placement]);
  const dialogId = useId();
  const [position, setPosition] = useState({});
  const close = () => setPopup(null);
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const wrap = slot.current
        .closest(".composer-wrap")
        .getBoundingClientRect();
      const anchor = button.current.getBoundingClientRect();
      const bounds =
        placement === "composer"
          ? slot.current.closest(".composer").getBoundingClientRect()
          : anchor;
      const below = window.innerHeight - bounds.bottom;
      const flip =
        bounds.top < (placement === "composer" ? 180 : 295) &&
        below > bounds.top;
      const gap = placement === "composer" ? 4 : 5;
      setPosition({
        ...(placement === "permission" && {
          left: Math.max(
            0,
            Math.min(anchor.left - wrap.left, wrap.width - 320),
          ),
        }),
        ...(alignToTrigger && {
          right: Math.max(
            0,
            Math.min(wrap.right - anchor.right, wrap.width - 255),
          ),
        }),
        ...(flip
          ? { top: bounds.bottom - wrap.top + gap, bottom: "auto" }
          : { bottom: wrap.bottom - bounds.top + gap }),
        maxHeight: Math.max(
          36,
          Math.min(
            placement === "composer" ? 320 : Infinity,
            (flip ? below : bounds.top) - 12,
          ),
        ),
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(slot.current.closest(".composer-wrap"));
    observer.observe(button.current);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [open, alignToTrigger, placement]);
  useLayoutEffect(() => {
    if (
      !open ||
      !popup.botId ||
      panel.current?.contains(document.activeElement)
    )
      return;
    const control = panel.current?.querySelector(
      "[data-popover-focus], [data-command]:enabled, select:enabled",
    );
    (control || panel.current)?.focus({ preventScroll: true });
  }, [open, popup?.botId]);
  function preview() {
    clearTimeout(leaveTimer.current);
    if (inspect)
      setPopup((previous) =>
        previous?.pinned ? previous : { id, pinned: false },
      );
  }
  return (
    <div
      ref={slot}
      className={`composer-slot ${className}`}
      onPointerEnter={preview}
      onPointerLeave={() => {
        if (
          open &&
          !popup.pinned &&
          !slot.current.contains(document.activeElement)
        ) {
          leaveTimer.current = setTimeout(() => {
            setPopup((current) =>
              current?.id === id && !current.pinned ? null : current,
            );
          }, 180);
        }
      }}
      onBlur={(event) => {
        if (
          open &&
          event.relatedTarget &&
          !slot.current.contains(event.relatedTarget)
        )
          close();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          button.current.focus();
          close();
        } else if (
          event.key === "ArrowDown" &&
          event.target === button.current
        ) {
          event.preventDefault();
          setPopup({ id, pinned: true });
          requestAnimationFrame(() => {
            const first =
              panel.current?.querySelector(
                "[data-popover-focus], [data-command]:enabled",
              ) ||
              panel.current?.querySelector("select:enabled, button:enabled");
            first?.focus();
          });
        }
      }}
    >
      <button
        type="button"
        className="composer-control"
        ref={button}
        aria-label={label}
        title={inspect ? undefined : label}
        aria-haspopup="dialog"
        aria-controls={open ? dialogId : undefined}
        aria-expanded={open}
        disabled={disabled}
        onFocus={preview}
        onClick={() =>
          setPopup(open && popup.pinned ? null : { id, pinned: true })
        }
      >
        {trigger}
      </button>
      {open && (
        <div
          ref={panel}
          tabIndex={-1}
          role="dialog"
          aria-label={label}
          id={dialogId}
          className={`composer-popover ${trailing ? "trailing" : ""}`}
          style={position}
        >
          {children}
        </div>
      )}
    </div>
  );
}

function Ring({ values }) {
  return (
    <svg
      className={`usage-ring ${values.length > 1 ? "double" : ""}`}
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      {values.map((value, i) => {
        const radius = i === 0 ? 9.5 : 5.9;
        const known = Number.isFinite(value);
        return (
          <g
            key={i}
            fill="none"
            strokeWidth={values.length > 1 ? 2.5 : 3}
            transform="rotate(-90 12 12)"
          >
            <circle
              className={`ring-track ${known ? "" : "unknown"}`}
              cx="12"
              cy="12"
              r={radius}
            />
            {known && value > 0 && (
              <circle
                className="ring-value"
                cx="12"
                cy="12"
                r={radius}
                pathLength="100"
                strokeDasharray={`${Math.min(100, value)} 100`}
              />
            )}
          </g>
        );
      })}
    </svg>
  );
}

function SpeedGauge({ value }) {
  const known = Number.isFinite(value) && value >= 0;
  const pct = known && value > 0 ? Math.min(100, Math.max(8, (value / 120) * 100)) : 0;
  const angle = known ? -115 + pct * 2.3 : -35;
  const arcPath = "M 4.03 17.4 A 9.2 9.2 0 1 1 19.97 17.4";
  return (
    <svg className="usage-ring speed-gauge" viewBox="0 0 24 24" aria-hidden="true">
      <g fill="none" strokeWidth="2.8" strokeLinecap="round">
        <path className={`ring-track ${known ? "" : "unknown"}`} d={arcPath} />
        {known && pct > 0 && (
          <path
            className="ring-value"
            d={arcPath}
            pathLength="100"
            strokeDasharray={`${pct} 100`}
          />
        )}
      </g>
      <g transform={`rotate(${angle} 12 13.2)`}>
        <line
          className={`gauge-needle ${known ? "" : "unknown"}`}
          x1="12"
          y1="13.2"
          x2="12"
          y2="7.4"
          strokeWidth="2.1"
          strokeLinecap="round"
        />
      </g>
      <circle className={`gauge-hub ${known ? "" : "unknown"}`} cx="12" cy="13.2" r="1.5" />
    </svg>
  );
}

function CacheRing({ value }) {
  const known = Number.isFinite(value) && value >= 0;
  return (
    <svg className="usage-ring cache-ring" viewBox="0 0 24 24" aria-hidden="true">
      <g fill="none" strokeWidth="2.8" transform="rotate(-90 12 12)">
        <circle
          className={`ring-track ${known ? "" : "unknown"}`}
          cx="12"
          cy="12"
          r="9.5"
        />
        {known && value > 0 && (
          <circle
            className="ring-value"
            cx="12"
            cy="12"
            r="9.5"
            pathLength="100"
            strokeDasharray={`${Math.min(100, value)} 100`}
          />
        )}
      </g>
      <path
        className={`cache-glyph ${known ? "" : "unknown"}`}
        d="M12.7 7.6L9.6 12.2h2.5l-.8 4.2 3.1-4.6h-2.5z"
      />
    </svg>
  );
}

const number = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 });
const displayTime = (date, tr) => {
  const time = new Date(date);
  return date != null && Number.isFinite(+time)
    ? time.toLocaleString(tr("zh-CN", "en"), {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";
};
function contextPercent(usage) {
  if (!Number.isFinite(usage?.used) || usage.used < 0 ||
      !Number.isFinite(usage.limit) || usage.limit <= 0) return null;
  return (usage.used * 100) / usage.limit;
}

function ContextReading({ usage }) {
  const tr = useLanguage();
  const percentage = contextPercent(usage);
  return (
    <>
      <div className="usage-line">
        <span>{tr("已使用", "Used")}</span>
        <strong>{percentage == null ? tr("占比未知", "Percentage unknown") : `${number.format(percentage)}%`}</strong>
      </div>
      <p>
        {Number.isFinite(usage.used) ? number.format(usage.used) : tr("未知", "Unknown")}
        {" / "}
        {Number.isFinite(usage.limit) ? number.format(usage.limit) : tr("未知", "Unknown")} tokens
      </p>
      {usage.updatedAt && <p>{tr("更新于", "Updated")} {displayTime(usage.updatedAt, tr)}</p>}
    </>
  );
}

function formatMetricDuration(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return "";
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  const seconds = durationMs / 1000;
  if (seconds < 60) return `${number.format(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const rem = Math.round(seconds % 60);
  return rem > 0 ? `${mins}m ${rem}s` : `${mins}m`;
}

function matchesMetricModel(modelId, metricModel) {
  if (!modelId || !metricModel) return true;
  const left = modelId.toLowerCase();
  const right = metricModel.toLowerCase();
  return left === right || left.startsWith(right) || right.startsWith(left);
}

function SpeedReading({ metrics }) {
  const tr = useLanguage();
  const speed = Number.isFinite(metrics?.tokensPerSecond) ? metrics.tokensPerSecond : null;
  const sessionSpeed = Number.isFinite(metrics?.sessionTokensPerSecond)
    ? metrics.sessionTokensPerSecond
    : null;
  const durationLabel = formatMetricDuration(metrics?.durationMs);
  return (
    <>
      <div className="usage-line">
        <span>{tr("本轮速度", "Turn speed")}</span>
        <strong>{speed == null ? tr("等待输出读数", "Waiting for output metrics") : `${number.format(speed)} tok/s`}</strong>
      </div>
      <p>
        {tr("本轮输出", "Turn output")} {number.format(metrics?.outputTokens || 0)} tokens
        {metrics?.reasoningTokens > 0 ? tr(`（含思考 ${number.format(metrics.reasoningTokens)}）`, ` (including ${number.format(metrics.reasoningTokens)} reasoning)`) : ""}
        {durationLabel ? tr(` · 耗时 ${durationLabel}`, ` · Took ${durationLabel}`) : ""}
      </p>
      {metrics?.turnCount > 1 && sessionSpeed != null && (
        <div className="usage-line">
          <span>{tr("会话均速（", "Chat average (")}{metrics.turnCount} {tr("轮）", " turns)")}</span>
          <strong>{number.format(sessionSpeed)} tok/s</strong>
        </div>
      )}
      {metrics?.updatedAt && <p>{tr("更新于", "Updated")} {displayTime(metrics.updatedAt, tr)}</p>}
    </>
  );
}

function CacheReading({ metrics }) {
  const tr = useLanguage();
  const hit = Number.isFinite(metrics?.cacheHitPercent) ? metrics.cacheHitPercent : null;
  const sessionHit = Number.isFinite(metrics?.sessionCacheHitPercent)
    ? metrics.sessionCacheHitPercent
    : null;
  return (
    <>
      <div className="usage-line">
        <span>{tr("本轮命中率", "Turn cache hit rate")}</span>
        <strong>{hit == null ? tr("暂无输入读数", "No input metrics yet") : `${number.format(hit)}%`}</strong>
      </div>
      <p>
        {tr("命中", "Hits")} {number.format(metrics?.cachedInputTokens || 0)} / {number.format(metrics?.inputTokens || 0)} {tr("输入 tokens", " input tokens")}
        {metrics?.cacheCreationTokens > 0
          ? tr(` · 新建缓存 ${number.format(metrics.cacheCreationTokens)}`, ` · New cache ${number.format(metrics.cacheCreationTokens)}`)
          : ""}
      </p>
      {metrics?.turnCount > 1 && sessionHit != null && (
        <div className="usage-line">
          <span>{tr("会话累计（", "Chat total (")}{metrics.turnCount} {tr("轮）", " turns)")}</span>
          <strong>{number.format(sessionHit)}%</strong>
        </div>
      )}
      {metrics?.updatedAt && <p>{tr("更新于", "Updated")} {displayTime(metrics.updatedAt, tr)}</p>}
    </>
  );
}

function remaining(window) {
  return Number.isFinite(window?.remainingPercent)
    ? window.remainingPercent
    : null;
}
function windowLabel(minutes, tr) {
  if (minutes === 10080) return tr("每周", "Weekly");
  if (minutes === 300) return tr("5 小时", "5 hours");
  return minutes % 60 ? tr(`${minutes} 分钟`, `${minutes} min`) : tr(`${minutes / 60} 小时`, `${minutes / 60} hours`);
}

export function ComposerTools({
  chatId,
  bot,
  actionCatalog,
  onInspect,
  state,
  members,
  isGroup,
  invoke,
  draftSettings,
  saveSettings,
  popup,
  setPopup,
  busy,
  setBusy,
  setError,
  children,
  onFiles,
  onSnippet,
  onSketch,
  onEditor,
  onNative,
  onGoal,
  selectedExtensions,
  filesDisabled,
}) {
  const tr = useLanguage();
  const account = state.accounts.find((a) => a.id === bot?.accountId);
  const { catalog, loading, refresh } = useModelCatalog(account, invoke, { refreshOnEntry: true });
  const [pending, setPending] = useState(null);
  const saveChain = useRef(Promise.resolve());
  const saveSeq = useRef(0);
  const stored = draftSettings?.[bot?.id] || state.composerSettings?.find(
    (s) => s.chatId === chatId && s.botId === bot?.id,
  );
  useEffect(() => {
    if (
      pending &&
      pending.botId === bot?.id &&
      Object.entries(pending.patch).every(
        ([field, value]) => (stored?.[field] ?? null) === value,
      )
    ) {
      setPending(null);
    }
  }, [pending, stored, bot?.id]);
  const settings =
    pending && pending.botId === bot?.id
      ? { ...stored, ...pending.patch }
      : stored || {};
  const model = settings.model ?? bot?.model ?? "";
  const effort = settings.effort ?? bot?.effort ?? "";
  const { modelId, modelLabel, effortLabel, maximum } = describeModel(
    catalog,
    model,
    effort,
    account?.provider, tr,
  );
  const permission = settings.permission ?? actionCatalog.inheritedPermission;
  const providerModes = state.permissionModes?.[account?.provider] || [
    "default",
  ];
  const [detail, setDetail] = useState(null);
  const actions = actionCatalog.data;
  const codex = account?.provider === "codex";
  const modes = providerModes.filter((mode) => {
    if (permission === mode) return true;
    if (mode === "auto-review") return Boolean(actions?.autoReview);
    if (mode === "workspace-auto" && account?.provider === "antigravity") {
      return actions ? Boolean(actions.workspaceAuto) : account?.status === "ready";
    }
    return true;
  });
  const menuModes = codex
    ? [
        "default",
        "auto-review",
        "full",
        ...(permission === "read-only" ? ["read-only"] : []),
      ].filter((mode) => modes.includes(mode))
    : modes;
  const lastUsage = (state.contextUsage || []).find(
    (r) => r.chatId === chatId && r.botId === bot?.id,
  );
  const usage = modelId && lastUsage?.model === modelId ? lastUsage : null;
  const lastMetrics = (state.tokenMetrics || []).find(
    (r) => r.chatId === chatId && r.botId === bot?.id,
  );
  const metrics =
    lastMetrics && matchesMetricModel(modelId, lastMetrics.model) ? lastMetrics : null;
  const [quotaRequest, setQuotaRequest] = useState(null);
  const [lastReset, setLastReset] = useState(0);
  // The quota IPC reads the persisted chat settings, including during an optimistic edit.
  const storedModel = (stored?.model ?? bot?.model) || catalog?.defaultModel;
  const requestKey = JSON.stringify([
    account?.id,
    account?.identity,
    account?.source,
    account?.bin,
    account?.status,
    chatId,
    bot?.id,
    storedModel,
    lastReset,
  ]);
  const inspectingQuota = popup?.id === "quota";
  const lastRequest = useRef(null);
  useEffect(() => {
    if (!bot || account?.status !== "ready") return;
    const same = lastRequest.current?.key === requestKey;
    if (
      same &&
      (!inspectingQuota || Date.now() - lastRequest.current.time < 1000)
    )
      return;
    const request = { key: requestKey, time: Date.now() };
    lastRequest.current = request;
    setQuotaRequest((last) => ({
      key: requestKey,
      loading: true,
      value: last?.key === requestKey ? last.value : null,
    }));
    invoke("refreshQuota", { ...(chatId && { chatId }), botId: bot.id,
      ...(draftSettings && { draftModel: storedModel || "" }) })
      .then((value) => {
        if (lastRequest.current === request)
          setQuotaRequest({ key: requestKey, value });
      })
      .catch((e) => {
        if (lastRequest.current === request)
          setQuotaRequest({ key: requestKey, error: errorText(e) });
      });
  }, [requestKey, inspectingQuota, invoke]);
  const result = quotaRequest?.key === requestKey ? quotaRequest.value : null;
  const now = Date.now();
  const live = (w) => w.resetsAt == null || w.resetsAt > now;
  const quotas = [...(state.quotas || []), result].filter(
    (r) => r?.accountId === account?.id && r?.windows?.some(live),
  );
  const quotaModel = modelId || result?.model;
  const quota =
    quotas.find((r) => r.scope === "model" && r.model === quotaModel) ||
    quotas.find((r) => r.scope === "account");
  const windows = (quota?.windows || []).filter(live);
  const nextReset = Math.min(...windows.map((w) => w.resetsAt ?? Infinity));
  useEffect(() => {
    if (!Number.isFinite(nextReset)) return;
    const timer = setTimeout(
      () => setLastReset(Date.now()),
      Math.min(2_147_483_647, Math.max(0, nextReset - Date.now()) + 1),
    );
    return () => clearTimeout(timer);
  }, [nextReset, lastReset]);
  const week = windows.find((w) => w.minutes === 10080);
  const short = windows.find((w) => w.minutes === 300);
  const ringValues = [week, short].filter(Boolean).map(remaining);
  if (!bot) return children;
  const groupPicker = isGroup && (
    <label className="inspect-member">
      <span>{tr("群成员", "Group members")}</span>
      <Select
        aria-label={tr("查看群成员设置与用量", "View member settings and usage")}
        value={bot.id}
        disabled={busy}
        onChange={e => onInspect(e.target.value)}
      >
        {members.map((m) => (
          <option value={m.id} key={m.id}>
            {m.name} ·{" "}
            {accountLabel(state.accounts.find((a) => a.id === m.accountId))}
          </option>
        ))}
      </Select>
    </label>
  );
  const shared = { popup, setPopup };
  async function save(values, closeAfter = true) {
    if (busy) return;
    const seq = ++saveSeq.current;
    const previous = pending;
    const nextPatch = {
      ...(previous?.botId === bot.id ? previous.patch : {}),
      ...values,
    };
    if (providerModes.includes("plan")) {
      if (values.planMode !== undefined) {
        nextPatch.permission = values.planMode ? "plan" : "default";
        nextPatch.planMode = Boolean(values.planMode);
      } else if (values.permission !== undefined) {
        nextPatch.planMode = values.permission === "plan";
      }
    }
    setPending({ botId: bot.id, patch: nextPatch });
    if (closeAfter) setPopup(null);
    setError("");
    const runSave = saveChain.current.catch(() => {}).then(() => saveSettings(bot.id, values));
    saveChain.current = runSave;
    try {
      await runSave;
    } catch (e) {
      if (saveSeq.current === seq) {
        setPending(previous);
        setError(errorText(e));
      }
    }
  }
  return (
    <>
      <ToolPopover
        {...shared}
        id="add"
        label={tr("添加文件或内容", "Add files or content")}
        placement="composer"
        className="add-tool"
        trigger={<Plus size={19} strokeWidth={1.8} />}
        disabled={filesDisabled}
      >
        <AddMenu
          skillsOnly={popup?.skillsOnly}
          memberPicker={groupPicker}
          actions={actions}
          loading={actionCatalog.pending && !actions}
          loadError={actionCatalog.error || actions?.note}
          retry={actionCatalog.retry}
          onFiles={onFiles}
          onSnippet={onSnippet}
          onSketch={onSketch}
          onEditor={onEditor}
          onGoal={() => {
            setPopup(null);
            onGoal(bot);
          }}
          planActive={Boolean(settings.planMode || permission === "plan")}
          onPlan={() =>
            save({ planMode: !(settings.planMode || permission === "plan") })
          }
          selected={selectedExtensions[bot.id] || []}
          onNative={(item) => {
            onNative(
              bot,
              item,
              actions?.maxExtensions ?? (account.provider === "codex" ? 32 : 1),
              Boolean(popup?.skillsOnly),
            );
            setPopup(null);
          }}
        />
      </ToolPopover>
      <ToolPopover
        {...shared}
        id="permission"
        label={tr("更改权限", "Change permissions")}
        placement="permission"
        className={`permission-tool mode-${permission}`}
        trigger={permissionLabel(permission, account?.provider, tr)}
      >
        <ApprovalMenu
          modes={actionCatalog.hasPermissionDefault ? ["inherit", ...menuModes] : menuModes}
          provider={account?.provider}
          value={actionCatalog.hasPermissionDefault && settings.permission == null ? "inherit" : permission}
          busy={busy}
          memberPicker={groupPicker}
          onChoose={(mode) => save({ permission: mode === "inherit" ? null : mode })}
          catalogError={actionCatalog.error || actions?.note}
          retry={actionCatalog.retry}
          onLearn={() => {
            setPopup(null);
            setDetail("permissions");
          }}
        />
      </ToolPopover>
      {detail === "permissions" &&
        createPortal(
          <Modal title={tr("操作批准", "Approval mode")} onClose={() => setDetail(null)}>
            <ApprovalDetails
              modes={modes}
              provider={account?.provider}
              busy={busy}
              onReadOnly={
                codex && modes.includes("read-only")
                  ? async () => {
                      await save({ permission: "read-only" });
                      setDetail(null);
                    }
                  : null
              }
            />
          </Modal>,
          document.body,
        )}
      {children}
      <div className="composer-trailing">
        <ToolPopover
          {...shared}
          id="speed"
          label={tr("Token 输出速度", "Token output speed")}
          inspect
          trailing
          className="ring-tool speed-tool"
          trigger={<SpeedGauge value={metrics?.tokensPerSecond ?? null} />}
        >
          <h3>{tr("Token 输出速度", "Token output speed")}</h3>
          {groupPicker}
          <p title={modelId}>{tr("当前模型 ·", "Current model ·")} {modelLabel}</p>
          {metrics ? (
            <SpeedReading metrics={metrics} />
          ) : (
            <p>
              {modelId
                ? tr("发送消息后自动统计当前模型的输出速度。", "Send a message to see this model’s output speed.")
                : loading
                  ? tr("正在读取原生模型…", "Loading CLI models…")
                  : tr("当前原生模型尚未确认。", "The current CLI model is unverified.")}
            </p>
          )}
          {!metrics && lastMetrics && (
            <details className="previous-context" key={bot.id}>
              <summary>{tr("上次原生读数", "Last CLI reading")}</summary>
              <p title={lastMetrics.model}>
                {modelLabelFor(catalog, lastMetrics.model) || lastMetrics.model || tr("原生工具未报告模型", "The CLI did not report a model")}
              </p>
              <SpeedReading metrics={lastMetrics} />
            </details>
          )}
        </ToolPopover>
        <ToolPopover
          {...shared}
          id="cache"
          label={tr("缓存命中率", "Cache hit rate")}
          inspect
          trailing
          className="ring-tool cache-tool"
          trigger={<CacheRing value={metrics?.cacheHitPercent ?? null} />}
        >
          <h3>{tr("缓存命中率", "Cache hit rate")}</h3>
          {groupPicker}
          <p title={modelId}>{tr("当前模型 ·", "Current model ·")} {modelLabel}</p>
          {metrics ? (
            <CacheReading metrics={metrics} />
          ) : (
            <p>
              {modelId
                ? tr("发送消息后自动统计当前模型的缓存命中率。", "Send a message to see this model’s cache hit rate.")
                : loading
                  ? tr("正在读取原生模型…", "Loading CLI models…")
                  : tr("当前原生模型尚未确认。", "The current CLI model is unverified.")}
            </p>
          )}
          {!metrics && lastMetrics && (
            <details className="previous-context" key={bot.id}>
              <summary>{tr("上次原生读数", "Last CLI reading")}</summary>
              <p title={lastMetrics.model}>
                {modelLabelFor(catalog, lastMetrics.model) || lastMetrics.model || tr("原生工具未报告模型", "The CLI did not report a model")}
              </p>
              <CacheReading metrics={lastMetrics} />
            </details>
          )}
        </ToolPopover>
        <ToolPopover
          {...shared}
          id="context"
          label={tr("上下文使用情况", "Context usage")}
          inspect
          trailing
          className="ring-tool"
          trigger={<Ring values={[contextPercent(usage)]} />}
        >
          <h3>{tr("上下文使用情况", "Context usage")}</h3>
          {groupPicker}
          <p title={modelId}>{tr("当前模型 ·", "Current model ·")} {modelLabel}</p>
          {usage ? (
            <ContextReading usage={usage} />
          ) : (
            <p>{modelId ? tr("等待当前模型的原生用量。", "Waiting for usage data from the CLI.") : loading ? tr("正在读取原生模型…", "Loading CLI models…") : tr("当前原生模型尚未确认。", "The current CLI model is unverified.")}</p>
          )}
          {!usage && lastUsage && (
            <details className="previous-context" key={bot.id}>
              <summary>{tr("上次原生读数", "Last CLI reading")}</summary>
              <p title={lastUsage.model}>{modelLabelFor(catalog, lastUsage.model) || tr("原生工具未报告模型", "The CLI did not report a model")}</p>
              <ContextReading usage={lastUsage} />
            </details>
          )}
        </ToolPopover>
        <ToolPopover
          {...shared}
          id="quota"
          label={tr("模型剩余额度", "Remaining model quota")}
          inspect
          trailing
          className="ring-tool quota-tool"
          trigger={<Ring values={ringValues.length ? ringValues : [null]} />}
        >
          <h3>{tr("模型剩余额度", "Remaining model quota")}</h3>
          {groupPicker}
          <p className="quota-scope">
            {modelLabel} · {accountLabel(account)}
          </p>
          {quota?.scope === "account" && <p>{tr("账号共享额度", "Shared account quota")}</p>}
          {windows.map((w, index) => {
            const value = remaining(w);
            return (
              <div className="quota-window" key={`${w.minutes}-${index}`}>
                <div className="usage-line">
                  <span>{windowLabel(w.minutes, tr)}</span>
                  <strong>
                    {value == null
                      ? tr("剩余未知", "Remaining quota unknown")
                      : tr(`剩余 ${number.format(value)}%`, `${number.format(value)}% remaining`)}
                  </strong>
                </div>
                {w.shared && <p>{tr("账号共享额度", "Shared account quota")}</p>}
                {w.group && <p>{w.group} {tr("模型组共享额度", "Shared model group quota")}</p>}
                {w.resetsAt != null && <p>{tr("重置于", "Resets at")} {displayTime(w.resetsAt, tr)}</p>}
              </div>
            );
          })}
          {!windows.length && (
            <p>
              {quotaRequest?.key === requestKey && quotaRequest.loading
                ? tr("正在读取额度…", "Loading quota…")
                : tr("剩余额度未知。原生工具尚未提供此模型的额度。", "The CLI has not provided a quota for this model.")}
            </p>
          )}
          {quota?.updatedAt && <p>{tr("更新于", "Updated")} {displayTime(quota.updatedAt, tr)}</p>}
          {quotaRequest?.key === requestKey && quotaRequest.error && (
            <p>{quotaRequest.error}</p>
          )}
        </ToolPopover>
        <ToolPopover
          {...shared}
          id="model"
          label={tr("更换模型和思考强度", "Change model and reasoning effort")}
          trailing
          alignToTrigger
          className="model-tool"
          trigger={
            <>
              {isGroup && <span className="target-name">{bot.name} · </span>}
              <span className="model-name">{modelLabel}</span>
              {effortLabel && (
                <span className="effort-name" data-maximum={maximum || undefined}>{effortLabel}</span>
              )}
            </>
          }
        >
          {groupPicker}
          <NativeModelPicker
            key={bot.id}
            provider={account?.provider}
            model={model}
            effort={effort}
            catalog={catalog}
            loading={loading}
            busy={busy}
            refresh={refresh}
            onChange={(patch) => save(patch, false)}
            onReset={() => save({ model: null, effort: null }, false)}
            resetDisabled={settings.model == null && settings.effort == null}
          />
        </ToolPopover>
      </div>
    </>
  );
}
