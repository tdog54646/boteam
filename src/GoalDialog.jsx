import { useLanguage } from "./preferences";
import React, { useEffect, useState } from "react";
import { Button, Modal, Notice, errorText } from "./ui";

const statusLabels = {
  active: ["进行中", "Active"],
  paused: ["已暂停", "Paused"],
  blocked: ["受阻", "Blocked"],
  usageLimited: ["已达用量限制", "Usage limit reached"],
  budgetLimited: ["已达目标预算", "Goal budget reached"],
  complete: ["已完成", "Complete"],
};

export function GoalDialog({
  bot,
  chatId,
  draftGoal,
  onDraftSave,
  invoke,
  onClose,
  onStarted,
  initialObjective = "",
}) {
  const tr = useLanguage();
  const [existing, setExisting] = useState(() => draftGoal ? { status: "paused", objective: draftGoal } : null);
  const [text, setText] = useState(initialObjective || draftGoal || "");
  const [busy, setBusy] = useState(Boolean(chatId));
  const [error, setError] = useState("");
  const [ready, setReady] = useState(!chatId);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    if (!chatId) return;
    setBusy(true);
    setError("");
    invoke("threadGoal", { chatId, botId: bot.id, action: "get" })
      .then(({ goal }) => {
        if (current) {
          setExisting(goal);
          setText(initialObjective || goal?.objective || "");
          setReady(true);
        }
      })
      .catch((e) => {
        if (current) setError(errorText(e));
      })
      .finally(() => {
        if (current) setBusy(false);
      });
    return () => {
      current = false;
    };
  }, [attempt]); // The dialog is opened for one member of one chat.
  async function save(action, status) {
    if (busy || !ready) return;
    setBusy(true);
    setError("");
    try {
      const update = {
        botId: bot.id,
        action,
        ...(action === "set" ? { objective: text.trim(), status } : {}),
      };
      let id = chatId;
      if (id) await invoke("threadGoal", { ...update, chatId: id });
      else id = await onDraftSave(update);
      onClose();
      if (status === "active") await onStarted?.(id);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={tr("目标", "Goal")}
      subtitle={bot.name + tr(" 将持续追求此目标，直至完成或停止。", " will pursue this goal until it is completed or stopped.")}
      onClose={() => {
        if (!busy || !ready) onClose();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) save("set", "active");
        }}
      >
        {existing && (
          <p className="goal-status">
            {tr("目标状态 ·", "Goal status ·")} {statusLabels[existing.status] ? tr(...statusLabels[existing.status]) : existing.status}
          </p>
        )}
        <textarea
          data-autofocus
          className="snippet-input"
          aria-label={tr("目标内容", "Objective")}
          maxLength={10000}
          rows={4}
          placeholder={tr("设置要持续追求的目标", "Set an ongoing goal")}
          value={text}
          readOnly={!ready || busy}
          onChange={(e) => setText(e.target.value)}
        />
        <Notice>{error}</Notice>
        <div className="form-actions">
          {existing && (
            <Button disabled={busy} onClick={() => save("clear")}>
              {tr("清除目标", "Clear goal")}
            </Button>
          )}
          {!ready && error && (
            <Button onClick={() => setAttempt((value) => value + 1)}>
              {tr("重新读取", "Reload")}
            </Button>
          )}
          {ready && (
            <Button
              disabled={busy || !text.trim()}
              onClick={() => save("set", "paused")}
            >
              {existing?.status === "active" ? tr("暂停目标", "Pause goal") : tr("保存为暂停", "Save paused")}
            </Button>
          )}
          <Button
            variant="primary"
            type="submit"
            disabled={!ready || !text.trim()}
            busy={busy}
          >
            {existing?.status === "active" ? tr("更新目标", "Update goal") : tr("开始目标", "Start goal")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
