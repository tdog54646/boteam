import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { RotateCw, X } from "lucide-react";
import { PlatformIcon, statusLabel } from "./ChannelPlatform";
import { ChannelAccessSettings } from "./ChannelAccessSettings";
import { permissionInfo, permissionLabel } from "./ComposerActionMenu";
import { useLanguage } from "./preferences";
import { IconButton, Notice, Spinner, errorText, providerName } from "./ui";
import "./channel-setup.css";

const guides = {
  wecom: {
    link: ["打开后台", "Open admin console"],
    steps: [
      ['管理后台 → 左下角“管理工具”', 'Open Management tools in the lower left of the admin console.'],
      ['点击“智能机器人” → “创建机器人” → “手动创建”', 'Choose Intelligent bots → Create bot → Create manually.'],
      ['底部点击“API 模式” → 选择“长连接” → 保存', 'Select API mode → Persistent connection, then save.'],
      ["在下方填写 Bot ID 和 Secret", "Enter the Bot ID and Secret below."],
    ],
  },
  qq: {
    link: ["开放平台", "Open developer portal"],
    steps: [
      ["在 QQ 开放平台创建机器人", "Create a bot in the QQ developer portal."],
      ["在机器人设置页面找到 App ID 和 App Secret", "Find the App ID and App Secret in the bot settings."],
      ["在下方填写 App ID 和 App Secret", "Enter the App ID and App Secret below."],
    ],
  },
  feishu: {
    link: ["创建应用 →", "Create app →"],
    steps: [
      ["在开放平台创建应用", "Create an app in the developer console."],
      ['在应用详情里点击“添加能力” → 添加“机器人”', 'In app details, choose Add capability → Bot.'],
      ['进入“权限管理” → “批量导入”，粘贴权限 JSON 并申请', 'In Permissions, choose Batch import, paste the permissions JSON and apply.'],
      ["选择长连接并订阅 im.message.receive_v1，发布应用", "Choose persistent connection, subscribe to im.message.receive_v1, and publish the app."],
      ['在“凭证与基础信息”中复制 App ID 和 App Secret', 'Copy the App ID and App Secret from Credentials & basic info.'],
    ],
  },
  dingtalk: {
    link: ["创建应用", "Create app"],
    steps: [
      ["在钉钉开放平台创建应用", "Create an app in the DingTalk developer console."],
      ['添加“机器人”能力，启用 Stream 模式', 'Add the bot capability and enable Stream mode.'],
      ["复制 Client ID (AppKey) 和 Client Secret (AppSecret)", "Copy the Client ID (AppKey) and Client Secret (AppSecret)."],
    ],
  },
  telegram: {
    link: ["打开 @BotFather", "Open @BotFather"],
    steps: [
      ["打开 Telegram，搜索 @BotFather 并开始对话", "Open Telegram and start a chat with @BotFather."],
      ["发送 /newbot，设置机器人名称和用户名", "Send /newbot and choose a name and username for the bot."],
      ["BotFather 会返回一个 Bot Token（格式：123456:ABC-DEF...）", "BotFather returns a bot token, such as 123456:ABC-DEF..."],
      ["复制 Bot Token 并粘贴到下方", "Copy the bot token and paste it below."],
    ],
  },
  discord: {
    link: ["打开开发者后台", "Open Developer Portal"],
    steps: [
      ["在 Discord Developer Portal 创建应用", "Create an application in the Discord Developer Portal."],
      ["添加 Bot，复制 Bot Token，并启用 Message Content Intent", "Add a bot, copy the bot token and enable Message Content Intent."],
      ["邀请 Bot 加入服务器，授予查看频道、发送消息、读取历史和添加反应的权限", "Invite the bot to your server with View Channels, Send Messages, Read Message History and Add Reactions permissions."],
      ["在下方填写 Bot Token，连接后可审批私信配对", "Enter the bot token below. After connecting, approve direct message pairings here."],
    ],
  },
};

// Scopes used by BoTeam's text-message listener and reply API.
const feishuPermissions = JSON.stringify({ scopes: { tenant: [
  "im:message.p2p_msg:readonly", "im:message.group_at_msg:readonly", "im:message:send_as_bot",
], user: [] } }, null, 2);

function CredentialForm({ platform, config, invoke, action, busy, onSaved, onCancel }) {
  const t = useLanguage();
  const { id } = platform;
  const guide = guides[id];
  const [fields, setFields] = useState(() => ({ ...config?.fields }));
  const [copied, setCopied] = useState(false);
  const [guideError, setGuideError] = useState("");
  const labels = {
    id: { wecom: "Bot ID", dingtalk: "Client ID (AppKey)" }[id] || "App ID",
    secret: { wecom: "Secret", dingtalk: "Client Secret (AppSecret)" }[id] || "App Secret",
    token: "Bot Token",
  };

  async function openGuide() {
    try { await invoke("channelOpenGuide", { id, region: fields.region || "feishu" }); setGuideError(""); }
    catch (err) { setGuideError(errorText(err)); }
  }
  async function copyPermissions() {
    try { await navigator.clipboard.writeText(feishuPermissions); setCopied(true); setGuideError(""); }
    catch (err) { setGuideError(errorText(err)); }
  }
  return <>
    <div className="channel-guide">
      <h3>{t("设置步骤", "Setup steps")}</h3>
      <ol>{guide.steps.map((step, i) => <li key={i}>{t(...step)}{i === 0 &&
        <button type="button" className="channel-guide-link" onClick={openGuide}>{t(...guide.link)}</button>}
        {id === "feishu" && i === 2 && <button type="button" className="text-btn channel-permission-copy" onClick={copyPermissions}>
          {copied ? t("权限已复制", "Permissions copied") : t("复制权限", "Copy permissions")}</button>}</li>)}</ol>
      <Notice>{guideError}</Notice>
    </div>
    <form className="channel-credentials" onSubmit={async e => {
      e.preventDefault();
      if (await action("channelSave", { fields })) onSaved();
    }}>
      {platform.fields.map(key => {
        if (key === "region") return <label className="setup-field" key={key}>
          <span>{t("平台", "Platform")}</span>
          <select value={fields.region || "feishu"} onChange={e => setFields({ ...fields, region: e.target.value })}>
            <option value="feishu">Feishu</option><option value="lark">Lark</option>
          </select></label>;
        const storedSecret = config?.configured && key !== "id";
        return <label className="setup-field" key={key}><span>{labels[key]} <b aria-hidden="true">*</b></span>
          <input aria-label={labels[key]} autoComplete="off" spellCheck={false} type={key === "id" ? "text" : "password"}
            value={fields[key] || ""} required={!storedSecret} maxLength={4000}
            placeholder={storedSecret ? t("已保存，留空以保留", "Saved · leave blank to keep") : "Enter " + labels[key]}
            onChange={e => setFields({ ...fields, [key]: e.target.value })}/></label>;
      })}
      <div className="setup-actions">
        {onCancel && <button className="btn secondary" type="button" onClick={onCancel}>{t("取消", "Cancel")}</button>}
        <button className="btn primary" type="submit" disabled={busy}>{busy && <Spinner size={14}/>}
          {t("连接", "Connect")}</button>
      </div>
    </form>
  </>;
}

function QrSetup({ platform, config, invoke, saved = false }) {
  const t = useLanguage();
  const { id } = platform;
  const [setupId] = useState(() => crypto.randomUUID());
  const [error, setError] = useState("");
  const [requesting, setRequesting] = useState(false);
  const [pin, setPin] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const mounted = useRef(false);
  const generation = useRef(0);
  const setup = saved ? config : (config?.setup?.setupId === setupId ? config.setup : null);

  const begin = useCallback(async refresh => {
    const sequence = ++generation.current;
    const current = () => mounted.current && sequence === generation.current;
    setRequesting(true); setError(""); setPin("");
    try {
      if (saved) await invoke("channelRefresh", { id });
      else await invoke("channelBeginSetup", { id, setupId, refresh });
    } catch (e) { if (current()) setError(errorText(e)); }
    finally { if (current()) setRequesting(false); }
  }, [id, invoke, saved, setupId]);
  useEffect(() => {
    mounted.current = true;
    if (!saved) begin(false);
    const cancel = () => {
      if (!saved) invoke("channelCancelSetup", { id, setupId }).catch(() => {});
    };
    window.addEventListener("pagehide", cancel);
    return () => {
      mounted.current = false;
      generation.current++;
      window.removeEventListener("pagehide", cancel);
      cancel();
    };
  }, [id, setupId, saved, invoke, begin]);
  async function sendPin(event) {
    event.preventDefault();
    setSubmitting(true); setError("");
    try {
      await invoke("channelPair", { id, ...(saved ? {} : { setupId }), pin });
      if (mounted.current) setPin("");
    } catch (e) { if (mounted.current) setError(errorText(e)); }
    finally { if (mounted.current) setSubmitting(false); }
  }
  const expired = setup?.status === "expired";
  const failed = ["error", "expired"].includes(setup?.status) || !!error;
  const waiting = t("等待扫码...", "Waiting for scan…");
  const loading = id === "wechat" ? t("加载二维码中...", "Loading QR code…") : t("WhatsApp 启动中...", "Starting WhatsApp…");
  const scanned = t("已扫码，请在手机上确认...", "Scanned. Confirm on your phone…");
  const hint = id === "wechat" ? t("打开微信扫描下方二维码", "Open WeChat and scan the QR code below")
    : t("打开 WhatsApp → 已连接的设备 → 连接设备 → 扫码", "In WhatsApp, open Linked devices → Link a device, then scan");
  return <div className="setup-qr">
    <p className="setup-qr-hint">{hint}</p>
    {setup?.qr && !failed
      ? <img className="setup-qr-image" src={setup.qr} alt={t("频道配对二维码", "Channel pairing QR code")}/>
      : <div className="setup-qr-placeholder">{failed ? <Notice>{error || setup?.detail || (expired ? t("二维码已过期", "QR code expired") : t("获取二维码失败", "Could not load QR code"))}</Notice> : <Spinner size={24}/>}</div>}
    <div className="setup-qr-status">
      <span role="status">{failed ? t("可以重新获取二维码", "Request a new QR code") : setup?.status === "scanned" ? scanned :
        setup?.status === "pin" ? t("请填写手机上的验证码", "Enter the verification code shown on your phone") : setup?.qr ? waiting : loading}</span>
      <IconButton icon={RotateCw} label={t("刷新二维码", "Refresh QR code")} disabled={requesting}
        onClick={() => begin(true)}/>
    </div>
    {setup?.status === "pin" && <form className="setup-qr-pin" onSubmit={sendPin}><label>{t("手机验证码", "Phone verification code")}
      <input required pattern="[0-9]{4,12}" inputMode="numeric" autoComplete="one-time-code" value={pin}
        onChange={e => setPin(e.target.value)}/></label>
      <button type="submit" className="btn primary" disabled={submitting}>{t("确认", "Confirm")}</button></form>}
  </div>;
}

function ChannelPermission({ config, state, bot, invoke, action, busy }) {
  const t = useLanguage();
  const account = state.accounts.find(a => a.id === bot?.accountId);
  const provider = account?.provider;
  const { id, permission, permissionRevision } = config;
  const [catalog, setCatalog] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setCatalog(null); setError("");
    if (bot) invoke("channelPermissionOptions", { id, botId:bot.id, refresh:attempt > 0 })
      .then(result => { if (active && result.revision === permissionRevision) setCatalog(result); })
      .catch(e => { if (active) setError(errorText(e)); });
    return () => { active = false; };
  }, [id, bot?.id, permissionRevision, account?.bindingRevision, attempt, invoke]);
  const baseModes = state.permissionModes?.[provider] || ["default"];
  const modes = catalog?.modes || baseModes.filter(mode => mode !== "auto-review" && mode !== "workspace-auto");
  const inherited = permission == null;
  return <div className="channel-operation-permission">
    <label className="setup-field"><span>{t("操作权限", "Action permissions")}</span>
      <select disabled={!bot || busy} value={bot ? permission ?? "" : ""} onChange={event => {
        if (bot) action("channelSetPermission", { botId:bot.id, permission:event.target.value, expectedRevision:permissionRevision });
      }}>
        {!bot ? <option value="">{t("请先选择 Bot", "Choose a bot first")}</option> : <>
          {inherited && <option value="" disabled>{t("沿用会话权限", "Use the chat’s permissions")}</option>}
          {!inherited && !modes.includes(permission) && <option disabled value={permission}>{permissionLabel(permission, provider, t)}</option>}
          {modes.map(mode => <option value={mode} key={mode}>{permissionLabel(mode, provider, t)}</option>)}
        </>}
      </select></label>
    {bot && <small>{inherited ? t("频道消息沿用该会话的权限。", "Incoming messages use the chat’s permissions.")
      : t("适用于频道收到的消息。", "Applies to incoming channel messages. ") + permissionInfo(permission, provider, t).detail}</small>}
    {(error || catalog?.unavailable) && <small>{error || t("暂时无法读取 CLI 的可选权限。", "Could not read optional CLI permissions. ")}{" "}
      <button type="button" className="text-btn" onClick={() => setAttempt(value => value + 1)}>{t("重试", "Retry")}</button></small>}
  </div>;
}

function ConfiguredChannel({ platform, config, state, invoke, action, busy, onManageBots, onClose, edit }) {
  const t = useLanguage();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const bots = state.bots.filter(bot => !bot.archived);
  const activeBot = bots.find(bot => bot.id === config.botId);
  const qrNeeded = platform.qr && config.enabled && ["pairing","pin","scanned","expired"].includes(config.status);
  return <div className="setup-configured">
    {qrNeeded && <QrSetup platform={platform} config={config} invoke={invoke} saved={config.status !== "expired"}/>}
    <div className="setup-connection-row">
      <div><small>{t("连接状态", "Connection status")}</small><strong>
        {statusLabel(config.status, t)}{config.account ? " · " + config.account : ""}</strong></div>
      {config.enabled
        ? <button type="button" disabled={busy} className="btn secondary" onClick={() => action("channelDisconnect")}>{t("断开连接", "Disconnect")}</button>
        : <button type="button" disabled={busy} className="btn primary" onClick={() => action("channelSave", { fields: {} })}>{t("连接", "Connect")}</button>}
    </div>
    <section className="channel-binding-section">
      <label className="setup-field"><span>{t("接收消息的 Bot", "Bot for incoming messages")}</span>
        <select value={activeBot?.id || ""} disabled={busy} onChange={e => action("channelSetBot", {
          botId: e.target.value, expectedBotId:config.botId, expectedRevision:config.permissionRevision,
        })}>
          <option value="">{t("未绑定 Bot", "No bot assigned")}</option>
          {bots.map(bot => <option key={bot.id} value={bot.id}>{bot.name} · {providerName(state.accounts.find(a => a.id === bot.accountId)?.provider)}</option>)}
        </select></label>
      {!bots.length && <button type="button" className="channel-guide-link" onClick={() => { onClose(); onManageBots(); }}>{t("添加 Bot", "Add bot")}</button>}
      <ChannelPermission key={activeBot?.id || ""} config={config} state={state} bot={activeBot} invoke={invoke} action={action} busy={busy}/>
    </section>
    <ChannelAccessSettings config={config} invoke={invoke}/>
    <div className="setup-actions">
      {!confirmRemove ? <>
        {!platform.qr && <button type="button" className="btn secondary" onClick={edit}>{t("编辑凭据", "Edit credentials")}</button>}
        <button type="button" className="text-btn danger-text" onClick={() => setConfirmRemove(true)}>{t("移除配置", "Remove configuration")}</button>
      </> : <>
        <p>{t("移除此频道的凭据和发送者授权？", "Remove this channel’s credentials and sender access?")}</p>
        <button type="button" className="btn secondary" onClick={() => setConfirmRemove(false)}>{t("取消", "Cancel")}</button>
        <button type="button" disabled={busy} className="btn danger" onClick={async () => { if (await action("channelRemove")) onClose(); }}>{t("移除", "Remove")}</button>
      </>}
    </div>
  </div>;
}

function Dialog({ platform, config, state, invoke, refreshSnapshot, onClose, onManageBots }) {
  const t = useLanguage();
  const ref = useRef(null);
  const mounted = useRef(false);
  const titleId = useId(), subtitleId = useId();
  const [edit, setEdit] = useState(false);
  const [saving, setBusy] = useState(false);
  const [waitingForRevision, setWaitingForRevision] = useState(null);
  const busy = saving || (waitingForRevision != null && config?.permissionRevision === waitingForRevision);
  const [error, setError] = useState("");
  const configured = config?.configured ?? !!config?.botId;
  useLayoutEffect(() => {
    const node = ref.current;
    mounted.current = true;
    const opener = document.activeElement;
    node.showModal();
    node.focus({ preventScroll: true });
    return () => {
      mounted.current = false;
      node.close();
      if (opener?.isConnected && typeof opener.focus === "function") opener.focus({ preventScroll: true });
    };
  }, []);
  async function action(method, payload = {}) {
    setBusy(true); setError("");
    try {
      const saved = await invoke(method, { id: platform.id, ...payload });
      if (mounted.current && saved?.permissionRevision && config?.permissionRevision !== saved.permissionRevision) {
        setWaitingForRevision(config.permissionRevision);
        await refreshSnapshot?.();
      }
      return mounted.current;
    } catch (e) {
      if (mounted.current) { setWaitingForRevision(null); setError(errorText(e)); }
      return false;
    }
    finally { if (mounted.current) setBusy(false); }
  }
  function handleTab(event) {
    if (event.key !== "Tab") return;
    const controls = [...ref.current.querySelectorAll('button:enabled,input:enabled,select:enabled,textarea:enabled,[href]')]
      .filter(el => el.getClientRects().length);
    if (!controls.length) return;
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  let subtitle = t(...platform.description);
  if (platform.id === "wechat") subtitle = t("扫码登录微信机器人", "Scan to sign in to a WeChat bot");
  if (platform.id === "whatsapp") subtitle = t("通过 Baileys 连接 WhatsApp（扫码登录）", "Connect WhatsApp through Baileys with a QR code");
  return <dialog ref={ref} className={`modal channel-setup-dialog${configured && !edit ? " wide" : ""}`} tabIndex={-1}
    aria-labelledby={titleId} aria-describedby={subtitleId}
    onCancel={e => { e.preventDefault(); onClose(); }} onKeyDown={handleTab}
    onClick={e => {
      if (e.target !== ref.current) return;
      const bounds = ref.current.getBoundingClientRect();
      if (e.clientX < bounds.left || e.clientX > bounds.right || e.clientY < bounds.top || e.clientY > bounds.bottom) onClose();
    }}>
    <header className="modal-header channel-setup-heading"><PlatformIcon id={platform.id}/><div>
      <h2 id={titleId}>{platform.name}</h2><p id={subtitleId}>{subtitle}</p></div>
      <IconButton icon={X} label={t("关闭", "Close")} onClick={onClose}/></header>
    <div className="channel-setup-body">
      <Notice>{error || config?.detail}</Notice>
      {configured && !edit ? <ConfiguredChannel {...{ platform, config, state, invoke, action, busy, onManageBots, onClose }}
        edit={() => { setError(""); setEdit(true); }}/>
        : platform.qr ? <QrSetup {...{ platform, config, invoke }}/>
        : <CredentialForm {...{ platform, config, invoke, action, busy }} onSaved={() => setEdit(false)} onCancel={edit ? () => setEdit(false) : null}/>}
    </div>
  </dialog>;
}

export function ChannelSetupDialog(props) {
  return <Dialog key={props.platform.id} {...props}/>;
}
