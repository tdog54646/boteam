import React, { useEffect, useState } from "react";
import { Button, Modal, Notice, errorText } from "./ui";

const statusLabels = {
  active: "进行中",
  paused: "已暂停",
  blocked: "受阻",
  usageLimited: "已达用量限制",
  budgetLimited: "已达目标预算",
  complete: "已完成",
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
      title="目标"
      subtitle={bot.name + " 将持续追求此目标，直至完成或停止。"}
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
            目标状态 · {statusLabels[existing.status] || existing.status}
          </p>
        )}
        <textarea
          data-autofocus
          className="snippet-input"
          aria-label="目标内容"
          maxLength={10000}
          rows={4}
          placeholder="设置要持续追求的目标"
          value={text}
          readOnly={!ready || busy}
          onChange={(e) => setText(e.target.value)}
        />
        <Notice>{error}</Notice>
        <div className="form-actions">
          {existing && (
            <Button disabled={busy} onClick={() => save("clear")}>
              清除目标
            </Button>
          )}
          {!ready && error && (
            <Button onClick={() => setAttempt((value) => value + 1)}>
              重新读取
            </Button>
          )}
          {ready && (
            <Button
              disabled={busy || !text.trim()}
              onClick={() => save("set", "paused")}
            >
              {existing?.status === "active" ? "暂停目标" : "保存为暂停"}
            </Button>
          )}
          <Button
            variant="primary"
            type="submit"
            disabled={!ready || !text.trim()}
            busy={busy}
          >
            {existing?.status === "active" ? "更新目标" : "开始目标"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
