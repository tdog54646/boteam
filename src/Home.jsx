import React, { useRef, useState } from "react";
import { Bot, ChevronDown, WalletCards, Plus, UsersRound } from "lucide-react";
import { Button, accountLabel } from "./ui";
import { Composer } from "./Composer";

export function Home({ state, invoke, open, onChat }) {
  const bots = state.bots.filter((b) => !b.archived);
  const [selection, setSelection] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState({});
  const creating = useRef(new Map());
  const bot = bots.find((b) => b.id === selection) || bots[0];
  const account = state.accounts.find((a) => a.id === bot?.accountId);
  async function ensureChat() {
    if (pending[bot.id]) return pending[bot.id];
    if (!creating.current.has(bot.id)) {
      const task = invoke("createChat", { kind: "direct", members: [bot.id] })
        .then((id) => {
          setPending((all) => ({ ...all, [bot.id]: id }));
          return id;
        })
        .finally(() => creating.current.delete(bot.id));
      creating.current.set(bot.id, task);
    }
    return creating.current.get(bot.id);
  }
  return (
    <div className="home">
      <div className="home-stack">
        <h1>
          {bot
            ? "有什么需要帮忙？"
            : state.accounts.length
              ? "创建你的第一个 Bot"
              : "连接你的 AI 账号"}
        </h1>
        {bot ? (
          <Composer
            key={bot.id}
            state={state}
            members={[bot]}
            homeBot={bot}
            invoke={invoke}
            chat={
              pending[bot.id] ? { id: pending[bot.id], kind: "direct" } : null
            }
            ensureHomeChat={ensureChat}
            onSent={onChat}
            onBusyChange={setBusy}
          />
        ) : (
          <>
            <p className="home-description">
              {state.accounts.length
                ? "选择订阅账号并为 Bot 命名，即可开始聊天。"
                : "导入本机已登录的订阅账号，创建可以私聊和加入群聊的 Bot。"}
            </p>
            <Button
              variant="primary"
              icon={Plus}
              onClick={() =>
                open({ type: state.accounts.length ? "bot" : "import" })
              }
            >
              {state.accounts.length ? "创建 Bot" : "导入本机账号"}
            </Button>
          </>
        )}
        {bot && (
          <div className="home-context">
            <label className="bot-picker" title="选择接收 Bot">
              <Bot size={15} />
              <span>{bot.name}</span>
              <ChevronDown size={12} />
              <select
                aria-label="选择接收 Bot"
                value={bot.id}
                disabled={busy}
                onChange={(e) => setSelection(e.target.value)}
              >
                {bots.map((b) => (
                  <option value={b.id} key={b.id}>
                    {b.name} ·{" "}
                    {accountLabel(
                      state.accounts.find((a) => a.id === b.accountId),
                    )}
                  </option>
                ))}
              </select>
            </label>
            <span className="home-account">
              <WalletCards size={14} />
              {accountLabel(account)}
            </span>
            <button onClick={() => open({ type: "chat", kind: "group" })}>
              <UsersRound size={14} />
              新建群聊
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
