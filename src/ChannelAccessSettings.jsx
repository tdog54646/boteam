import React, { useState } from "react";
import { useLanguage } from "./preferences";
import { Notice, errorText } from "./ui";

function DeliverySettings({ value, save, busy }) {
  const t = useLanguage();
  const [draft, setDraft] = useState(value);
  function field(name, val) { setDraft(old => ({ ...old, [name]: val })); }
  return <form className="channel-delivery" onSubmit={e => {
    e.preventDefault(); save({ delivery: { ...draft, mentionPatterns: draft.mentionPatterns.map(s => s.trim()).filter(Boolean) } });
  }}>
    <h3>{t("投递行为", "Delivery behavior")}</h3>
    <label className="setup-field">{t("确认反应", "Acknowledgment reaction")}
      <input value={draft.ackReaction} maxLength={100} placeholder="emoji" onChange={e => field("ackReaction",e.target.value)}/></label>
    <label className="setup-field">{t("回复引用模式","Reply reference mode")}<select value={draft.replyMode}
      onChange={e => field("replyMode",e.target.value)}><option value="first">{t("仅首段","First chunk")}</option>
      <option value="all">{t("每一段","Every chunk")}</option><option value="off">{t("关闭","Off")}</option></select></label>
    <label className="setup-field">{t("消息分段长度", "Chunk limit")}<input type="number" min="1" max="2000" required
      value={draft.chunkSize} onChange={e => field("chunkSize",e.target.value === "" ? "" : Number(e.target.value))}/></label>
    <label className="setup-field">{t("额外提及正则，每行一个", "Extra mention patterns, one per line")}
      <textarea rows="3" value={draft.mentionPatterns.join("\n")} onChange={e => field("mentionPatterns",e.target.value.split("\n"))}/></label>
    <div className="setup-actions"><button className="setup-secondary" disabled={busy}>{t("保存投递设置","Save delivery settings")}</button></div>
  </form>;
}

export function ChannelAccessSettings({ config, invoke }) {
  const t = useLanguage();
  const [error, setError] = useState("");
  const [busy,setBusy] = useState(false);
  const [sender, setSender] = useState("");
  const [room, setRoom] = useState("");
  const [editingGroup, setEditingGroup] = useState(null);
  const [members, setMembers] = useState("");
  const [mention, setMention] = useState(true);
  const { id, access } = config;
  if (!access) return null;

  async function action(method, payload) {
    setError(""); setBusy(true);
    try { await invoke(method, { id, ...payload }); return true; }
    catch (e) { setError(errorText(e)); return false; }
    finally { setBusy(false); }
  }
  function save(patch) { return action("channelSetAccess", { access: { ...access, ...patch }, expectedAccess: access }); }
  function removeButton(label, handler) {
    return <button type="button" className="setup-secondary" disabled={busy} onClick={handler}>{label}</button>;
  }
  const groups = access.groups;
  const discord = id === "discord";
  function resetGroupForm() { setRoom(""); setMembers(""); setMention(true); setEditingGroup(null); }
  async function saveGroup(e) {
    e.preventDefault();
    const roomId = room.trim();
    if (groups.some(group => group.room === roomId && group.room !== editingGroup?.room)) {
      setError(t("该频道已存在。", "This channel already exists.")); return;
    }
    const original = editingGroup && groups.find(group => group.room === editingGroup.room);
    if (editingGroup && JSON.stringify(original) !== JSON.stringify(editingGroup)) {
      setError(t("此频道已被修改，请重新选择要编辑的频道。", "This channel has changed. Select it again to edit.")); return;
    }
    const rule = { room:roomId, requireMention:mention, allowFrom:members.split(/[,，\n]/).map(s => s.trim()).filter(Boolean) };
    const updated = editingGroup ? groups.map(group => group.room === editingGroup.room ? rule : group) : [...groups, rule];
    if (await save({ groups:updated })) resetGroupForm();
  }
  return <section className="channel-policy">
    <h3>{t("访问控制", "Access control")}</h3>
    <label className="setup-field">{t("私信策略", "DM policy")}
      <select value={access.dmPolicy} disabled={busy} onChange={e => save({ dmPolicy: e.target.value })}>
        <option value="pairing">{t("配对审批", "Pairing approval")}</option>
        <option value="allowlist">{t("仅允许名单", "Allowlist only")}</option>
        {!discord && <option value="open">{t("所有人", "Everyone")}</option>}
        <option value="disabled">{t("禁用", "Disabled")}</option>
      </select>
    </label>
    <h4>{t("待批准配对", "Pending pairings")}</h4>
    {!config.pending?.length && <p>{t("暂无待批准配对。", "No pending pairings.")}</p>}
    {config.pending?.map(req => <div className="setup-access-row" key={req.id}><div><strong>{req.name}</strong>
      <small>{req.sender} · {req.room}{req.code && " · " + t("配对码 ", "Code ") + req.code}</small></div>
      {removeButton(t("批准", "Approve"), () => action("channelPair", { requestId:req.id }))}</div>)}
    <h4>{t("私信允许名单", "DM allowlist")}</h4>
    {!config.allowed?.length && !access.allowFrom.length && <p>{t("暂无已允许的用户。", "No allowed users yet.")}</p>}
    {config.allowed?.map(grant => <div className="setup-access-row" key={grant.id}><div>
      <strong>{grant.name}</strong><small>{grant.sender} · {grant.room}</small></div>
      {removeButton(t("撤销","Revoke"), () => action("channelPair", { requestId:grant.id, revoke:true }))}</div>)}
    {access.allowFrom.map(user => <div className="setup-access-row" key={user}><span>{user}</span>
      {removeButton(t("移除","Remove"), () => save({ allowFrom:access.allowFrom.filter(x => x !== user) }))}</div>)}
    <form className="channel-allow-user" onSubmit={async e => {
      e.preventDefault(); if (await save({ allowFrom:[...new Set([...access.allowFrom, sender.trim()])] })) setSender("");
    }}>
      <input className="channel-policy-input" required value={sender} onChange={e => setSender(e.target.value)} aria-label={t("用户 ID","User ID")}
        placeholder={discord ? "Discord " + t("用户 ID","user ID") : t("用户 ID","User ID")}/>
      <button className="setup-secondary" disabled={busy || !sender.trim()}>{t("添加", "Add")}</button>
    </form>
    <h4>{discord ? t("服务器频道","Server channels") : t("群聊","Groups")}</h4>
    {!groups.length && <p>{t("暂无已允许的群或频道。", "No groups or channels allowed yet.")}</p>}
    {groups.map(group => <div className="setup-access-row" key={group.room}><div><strong>{group.room}</strong>
      <small>{group.requireMention ? t("需要 @ 机器人", "Bot mention required") : t("无需提及", "No mention required")}{group.allowFrom.length ? " · " + group.allowFrom.join(", ") : ""}</small></div>
      {removeButton(t("编辑","Edit"), () => { setEditingGroup(group); setRoom(group.room); setMembers(group.allowFrom.join(", ")); setMention(group.requireMention); setError(""); })}
      {removeButton(t("移除","Remove"), () => save({ groups:groups.filter(g => g.room !== group.room) }))}</div>)}
    <form className="channel-group-form" onSubmit={saveGroup}>
      <input className="channel-policy-input" required value={room} onChange={e => setRoom(e.target.value)} aria-label={t("频道 ID","Channel ID")}
        placeholder={discord ? "Discord " + t("频道 ID","channel ID") : t("群聊 ID","Group ID")}/>
      <input className="channel-policy-input" value={members} onChange={e => setMembers(e.target.value)} aria-label={t("允许的群成员", "Allowed group members")}
        placeholder={t("可选用户 ID，以逗号分隔", "Optional user IDs, comma separated")}/>
      <label><input type="checkbox" checked={mention} onChange={e => setMention(e.target.checked)}/> {t("需要 @ 机器人","Require bot mention")}</label>
      <div className="setup-actions">{editingGroup && removeButton(t("取消编辑","Cancel edit"), resetGroupForm)}
        <button className="setup-secondary" disabled={busy || !room.trim()}>{editingGroup ? t("保存频道","Save channel") : t("添加频道","Add channel")}</button></div>
    </form>
    {discord && <DeliverySettings key={JSON.stringify(access.delivery)} value={access.delivery} save={save} busy={busy}/>}
    <Notice>{error}</Notice>
  </section>;
}
