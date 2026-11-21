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

const number = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 });
const displayTime = (date) => {
  const time = new Date(date);
  return date != null && Number.isFinite(+time)
    ? time.toLocaleString("zh-CN", {
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
  const percentage = contextPercent(usage);
  return (
    <>
      <div className="usage-line">
        <span>已使用</span>
        <strong>{percentage == null ? "占比未知" : `${number.format(percentage)}%`}</strong>
      </div>
      <p>
        {Number.isFinite(usage.used) ? number.format(usage.used) : "未知"}
        {" / "}
        {Number.isFinite(usage.limit) ? number.format(usage.limit) : "未知"} tokens
      </p>
      {usage.updatedAt && <p>更新于 {displayTime(usage.updatedAt)}</p>}
    </>
  );
}

function remaining(window) {
  return Number.isFinite(window?.remainingPercent)
    ? window.remainingPercent
    : null;
}
function windowLabel(minutes) {
  if (minutes === 10080) return "每周";
  if (minutes === 300) return "5 小时";
  return minutes % 60 ? `${minutes} 分钟` : `${minutes / 60} 小时`;
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
  const account = state.accounts.find((a) => a.id === bot?.accountId);
  const { catalog, loading, refresh } = useModelCatalog(account, invoke, { refreshOnEntry: true });
  const [pending, setPending] = useState(null);
  const saving = useRef(false);
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
    account?.provider,
  );
  const permission = settings.permission || "default";
  const providerModes = state.permissionModes?.[account?.provider] || [
    "default",
  ];
  const [detail, setDetail] = useState(null);
  const actions = actionCatalog.data;
  const codex = account?.provider === "codex";
  const modes = providerModes.filter((mode) => {
    if (permission === mode) return true;
    if (mode === "auto-review") return actions?.autoReview;
    if (mode === "workspace-auto" && account?.provider === "antigravity")
      return actions?.workspaceAuto;
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
      <span>群成员</span>
      <Select
        aria-label="查看群成员设置与用量"
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
    if (busy || saving.current) return;
    saving.current = true;
    const previous = pending;
    if (!closeAfter) {
      const patch =
        previous?.botId === bot.id ? { ...previous.patch, ...values } : values;
      setPending({ botId: bot.id, patch });
    }
    setBusy(true);
    setError("");
    try {
      await saveSettings(bot.id, values);
      if (closeAfter) setPopup(null);
    } catch (e) {
      if (!closeAfter) setPending(previous);
      setError(errorText(e));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <ToolPopover
        {...shared}
        id="add"
        label="添加文件或内容"
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
        label="更改权限"
        placement="permission"
        className={`permission-tool mode-${permission}`}
        trigger={permissionLabel(permission, account?.provider)}
      >
        <ApprovalMenu
          modes={menuModes}
          provider={account?.provider}
          value={permission}
          busy={busy}
          memberPicker={groupPicker}
          onChoose={(mode) => save({ permission: mode })}
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
          <Modal title="操作批准" onClose={() => setDetail(null)}>
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
          id="context"
          label="上下文使用情况"
          inspect
          trailing
          className="ring-tool"
          trigger={<Ring values={[contextPercent(usage)]} />}
        >
          <h3>上下文使用情况</h3>
          {groupPicker}
          <p title={modelId}>当前模型 · {modelLabel}</p>
          {usage ? (
            <ContextReading usage={usage} />
          ) : (
            <p>{modelId ? "等待当前模型的原生用量。" : loading ? "正在读取原生模型…" : "当前原生模型尚未确认。"}</p>
          )}
          {!usage && lastUsage && (
            <details className="previous-context" key={bot.id}>
              <summary>上次原生读数</summary>
              <p title={lastUsage.model}>{modelLabelFor(catalog, lastUsage.model) || "原生工具未报告模型"}</p>
              <ContextReading usage={lastUsage} />
            </details>
          )}
        </ToolPopover>
        <ToolPopover
          {...shared}
          id="quota"
          label="模型剩余额度"
          inspect
          trailing
          className="ring-tool quota-tool"
          trigger={<Ring values={ringValues.length ? ringValues : [null]} />}
        >
          <h3>模型剩余额度</h3>
          {groupPicker}
          <p className="quota-scope">
            {modelLabel} · {accountLabel(account)}
          </p>
          {quota?.scope === "account" && <p>账号共享额度</p>}
          {windows.map((w, index) => {
            const value = remaining(w);
            return (
              <div className="quota-window" key={`${w.minutes}-${index}`}>
                <div className="usage-line">
                  <span>{windowLabel(w.minutes)}</span>
                  <strong>
                    {value == null
                      ? "剩余未知"
                      : `剩余 ${number.format(value)}%`}
                  </strong>
                </div>
                {w.shared && <p>账号共享额度</p>}
                {w.group && <p>{w.group} 模型组共享额度</p>}
                {w.resetsAt != null && <p>重置于 {displayTime(w.resetsAt)}</p>}
              </div>
            );
          })}
          {!windows.length && (
            <p>
              {quotaRequest?.key === requestKey && quotaRequest.loading
                ? "正在读取额度…"
                : "剩余额度未知。原生工具尚未提供此模型的额度。"}
            </p>
          )}
          {quota?.updatedAt && <p>更新于 {displayTime(quota.updatedAt)}</p>}
          {quotaRequest?.key === requestKey && quotaRequest.error && (
            <p>{quotaRequest.error}</p>
          )}
        </ToolPopover>
        <ToolPopover
          {...shared}
          id="model"
          label="更换模型和思考强度"
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
