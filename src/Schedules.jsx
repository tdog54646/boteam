import React, { useEffect, useRef, useState } from "react";
import {
  ArrowLeft, ArrowUpRight, CalendarCheck, CalendarClock, ListFilter, Pause, Pencil, Play, Plus, Search, Trash2,
} from "lucide-react";
import { Button, Field, IconButton, Modal, Notice, Select, errorText, providerName } from "./ui";
import { MenuItem, SidebarPopup } from "./SidebarParts";
import { useLanguage } from "./preferences";
import "./schedules.css";

const weekdays = [1, 2, 3, 4, 5, 6, 0];
const shortDays = ["日", "一", "二", "三", "四", "五", "六"];
const englishDays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const states = {
  queued: ["排队中", "Queued"], running: ["运行中", "Running"], approval: ["等待确认", "Needs approval"],
  done: ["已完成", "Completed"], failed: ["失败", "Failed"], skipped: ["已跳过", "Skipped"],
  interrupted: ["已中断", "Interrupted"],
};
const active = job => job.runs.some(run => ["queued", "running", "approval"].includes(run.status));
const dateLabel = (at, t) => new Date(at).toLocaleString(t("zh-CN", "en-US"), {
  year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
});
function ruleLabel(rule, t) {
  if (rule.frequency === "once") return dateLabel(rule.at, t);
  if (rule.frequency === "hourly") return t(`每小时第 ${rule.minute} 分钟`, `Hourly at :${String(rule.minute).padStart(2, "0")}`);
  if (rule.frequency === "daily") return t(`每天 ${rule.time}`, `Daily at ${rule.time}`);
  if (rule.frequency === "monthly") return t(`每月 ${rule.day} 日 ${rule.time}`, `Day ${rule.day} of each month at ${rule.time}`);
  if (rule.frequency === "yearly") {
    const monthDay = new Date(2000, rule.month - 1, rule.day).toLocaleDateString(t("zh-CN", "en-US"), { month: "long", day: "numeric" });
    return t(`每年${monthDay} ${rule.time}`, `Every ${monthDay} at ${rule.time}`);
  }
  const names = weekdays.filter(day => rule.days.includes(day)).map(day => t(shortDays[day], englishDays[day]));
  return t(`每周${names.join("、")} ${rule.time}`, `${names.join(", ")} at ${rule.time}`);
}
const templates = [
  {
    id: "reading", icon: "📖", name: ["寻找周末读物", "Find a weekend read"],
    description: ["每周六给我发送一篇值得一读的文章。", "Send me an article worth reading every Saturday."],
    instructions: ["推荐一篇适合周末阅读的文章，附上标题、原文链接和简短推荐理由。优先选择我指定的主题。", "Recommend one article for the weekend with its title, original link, and a brief reason to read it. Prioritize the topics I specify."],
    rule: { frequency: "weekly", time: "09:00", days: [6] },
  },
  {
    id: "prices", icon: "🏷️", name: ["价格提醒", "Price alerts"],
    description: ["每天查看我关注的商品价格，并在降价时提醒我。", "Check the prices of products I follow every day and flag price drops."],
    instructions: ["检查以下商品的当前售价，与上次价格或目标价对比。请在指定的项目目录中保存价格记录，下次遇到降价时列出商品、降幅和链接。\n商品链接和目标价：", "Check the prices of these products against their last recorded prices or my targets. Keep a price history in the specified project directory and report price drops with the product, change, and link.\nProduct links and target prices:"],
    rule: { frequency: "daily", time: "09:00" },
  },
  {
    id: "concerts", icon: "🎟️", name: ["查找音乐演出", "Find live music"],
    description: ["每周帮我查找符合我喜好的新音乐演出。", "Find new shows that match my music taste each week."],
    instructions: ["查找所在城市近期新公布的音乐演出，优先推荐我喜欢的艺人和音乐类型。列出演出日期、场地和官方售票链接。\n城市与音乐偏好：", "Find recently announced concerts in my city that match my favorite artists and genres. Include dates, venues, and official ticket links.\nCity and music preferences:"],
    rule: { frequency: "weekly", time: "09:00", days: [1] },
  },
  {
    id: "weekend", icon: "🎉", name: ["帮我安排周末", "Plan my weekend"],
    description: ["每周四给我推荐本地周末活动。", "Recommend local weekend events every Thursday."],
    instructions: ["推荐三个适合本周末参加的本地活动，注明时间、地点、价格和信息来源。\n城市、兴趣与预算：", "Recommend three local events for this weekend with times, venues, prices, and sources.\nCity, interests, and budget:"],
    rule: { frequency: "weekly", time: "09:00", days: [4] },
  },
  {
    id: "meals", icon: "🥗", name: ["每周饮食计划", "Weekly meal plan"],
    description: ["规划一周的餐食，并列出食材采购清单。", "Plan a week of meals and prepare a grocery list."],
    instructions: ["按天规划下一周的餐食，列出按食材类别整理的采购清单，并结合下列人数及饮食偏好调整份量。\n人数与饮食偏好：", "Plan next week’s meals by day and group the grocery list by ingredient category. Adjust quantities to the following household size and dietary preferences.\nHousehold size and dietary preferences:"],
    rule: { frequency: "weekly", time: "10:00", days: [0] },
  },
  {
    id: "spending", icon: "💰", name: ["每周财务状况更新", "Weekly spending update"],
    description: ["回顾我最近的支出，看看有什么需要注意。", "Review my recent spending and highlight anything worth a closer look."],
    instructions: ["根据我在工作目录中指定的账单或支出记录，汇总上周各类支出，列出异常变动和需要核对的项目。\n账单文件或数据来源：", "Use the spending records I specify in the working directory to summarize last week’s expenses by category. Highlight unusual changes and entries to review.\nSpending file or data source:"],
    rule: { frequency: "weekly", time: "09:00", days: [1] },
  },
];
export const scheduleCreatePages = ["schedule:new", ...templates.map(item => "schedule:new:" + item.id)];

export function ScheduleNavigation({ state, page, select }) {
  const t = useLanguage();
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [popup, setPopup] = useState(null);
  const jobs = state.schedules || [];
  const needle = query.trim().toLocaleLowerCase();
  const filters = [["all", t("全部任务", "All tasks")], ["active", t("已启用", "Active")], ["inactive", t("已停用", "Inactive")]];
  const matches = jobs.filter(job => job.name.toLocaleLowerCase().includes(needle) &&
    (filter === "all" || job.enabled === (filter === "active")));
  function closeSearch() { setSearching(false); setQuery(""); }
  return <>
    <div className="rail-primary schedule-nav">
      <div className="workbench-heading">
        <h1>{t("定时任务", "Scheduled tasks")}</h1>
        <IconButton icon={ListFilter} label={t("筛选定时任务", "Filter scheduled tasks")} aria-haspopup="menu"
          aria-expanded={Boolean(popup)} className={filter !== "all" ? "option-active" : ""}
          onClick={e => setPopup(popup ? null : { anchor: e.currentTarget, keyboard: e.detail === 0 })}/>
        <IconButton icon={Search} label={t("搜索定时任务", "Search scheduled tasks")} aria-expanded={searching}
          onClick={() => searching ? closeSearch() : setSearching(true)}/>
      </div>
      {searching && <label className="schedule-search"><Search size={14}/>
        <input autoFocus type="search" aria-label={t("搜索定时任务", "Search scheduled tasks")}
          placeholder={t("搜索任务", "Search tasks")} value={query} onChange={e => setQuery(e.target.value)}
          onKeyDown={e => { if (e.key === "Escape") { e.preventDefault(); closeSearch(); } }}/>
      </label>}
      <button type="button" className="rail-row" onClick={() => select("schedule:new")}><Plus size={16}/>{t("新建任务", "New task")}</button>
    </div>
    <nav className="rail-history schedule-nav-list" aria-label={t("定时任务列表", "Scheduled task list")}>
      {matches.map(job => <button key={job.id} type="button" className="rail-row thread-row schedule-row"
        aria-current={page === "schedule:" + job.id ? "page" : undefined}
        title={job.name + " · " + ruleLabel(job.rule, t)} onClick={() => select("schedule:" + job.id)}>
        <span>{job.name}</span>
        {active(job) ? <i className="running-dot" role="img" aria-label={t("正在运行", "Running")}/> :
          !job.enabled && <Pause size={12} aria-label={t("已停用", "Inactive")}/>}
      </button>)}
      {!matches.length && <p className="rail-empty">{jobs.length ? t("没有匹配的任务", "No matching tasks") : t("暂无任何定时任务", "No scheduled tasks yet")}</p>}
    </nav>
    {popup && <SidebarPopup popup={popup} close={() => setPopup(null)} title={t("筛选定时任务", "Filter scheduled tasks")}>
      {filters.map(([value,label]) => <MenuItem key={value} radio checked={filter === value}
        onClick={() => { setFilter(value); setPopup(null); }}>{label}</MenuItem>)}
    </SidebarPopup>}
  </>;
}

function TemplateGallery({ select }) {
  const t = useLanguage();
  return <div className="schedule-gallery">
    <header><CalendarCheck size={44} strokeWidth={1.7} aria-hidden="true"/>
      <h2>{t("安排任务", "Schedule a task")}</h2>
      <p>{t("BoTeam 可以帮你处理持续性任务，让你不必亲自动手。", "Let BoTeam handle recurring tasks for you.")}</p>
    </header>
    <div className="schedule-templates">{templates.map(item => <button type="button" key={item.id} onClick={() => select("schedule:new:" + item.id)}>
      <span className="schedule-template-icon" aria-hidden="true">{item.icon}</span>
      <span><strong>{t(...item.name)}</strong><small>{t(...item.description)}</small></span>
    </button>)}</div>
  </div>;
}

export function SchedulesPage(props) {
  return <ScheduleScreen key={props.page} {...props}/>;
}

function ScheduleScreen({ page = "schedules", state, invoke, select, open, refresh }) {
  const t = useLanguage();
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const job = state.schedules?.find(item => page === "schedule:" + item.id);
  const preset = templates.find(item => page === "schedule:new:" + item.id);
  const creating = scheduleCreatePages.includes(page);
  const back = () => select("schedules");
  async function act(method, payload, done) {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const result = await invoke("schedule:" + method, payload);
      await refresh?.();
      if (mounted.current) done?.(result);
    } catch (err) { if (mounted.current) setError(errorText(err)); }
    finally { if (mounted.current) setBusy(false); }
  }
  if (creating || editing) {
    const initial = editing || (preset && { name: t(...preset.name), prompt: t(...preset.instructions), rule: preset.rule });
    return <div className="page-scroll schedules-scroll"><ScheduleForm initial={initial} state={state}
      busy={busy} error={error} onAddBot={() => open({ type: "bot" })} onClose={editing ? () => { setEditing(null); setError(""); } : back}
      onSave={payload => act("save", payload, id => { setEditing(null); select("schedule:" + id); })}/></div>;
  }
  if (!job) return <div className="page-scroll schedules-scroll"><TemplateGallery select={select}/></div>;
  const bot = state.bots.find(item => item.id === job.botId);
  return <div className="page-scroll schedules-scroll"><article className="schedule-detail schedule-content">
    <button type="button" className="text-btn schedule-back" onClick={back}><ArrowLeft size={15}/>{t("任务模板", "Task templates")}</button>
    <h2>{job.name}</h2>
    <Notice>{error}</Notice>
    <p className="schedule-prompt">{job.prompt}</p>
    <dl>
      <dt>{t("执行 Bot", "Bot")}</dt><dd>{bot?.name || t("已移除的 Bot", "Removed bot")}</dd>
      <dt>{t("工作项目", "Project")}</dt><dd>{job.projectId ? state.projects?.find(p => p.id === job.projectId)?.name || t("项目已移除", "Project removed") : t("Bot 默认目录", "Bot’s default directory")}</dd>
      <dt>{t("运行计划", "Schedule")}</dt><dd>{ruleLabel(job.rule, t)}</dd>
      <dt>{t("下次运行", "Next run")}</dt><dd>{job.enabled && job.nextRunAt ? dateLabel(job.nextRunAt, t) : t("已停用", "Inactive")}</dd>
    </dl>
    <div className="schedule-controls">
      <Button icon={Play} variant="primary" busy={busy} disabled={active(job)} onClick={() => act("run", { id: job.id })}>{t("立即运行", "Run now")}</Button>
      <Button icon={job.enabled ? Pause : CalendarClock} disabled={busy}
        onClick={() => act("toggle", { id: job.id, enabled: !job.enabled, revision: job.revision })}>{job.enabled ? t("暂停", "Pause") : t("启用", "Enable")}</Button>
      <Button icon={Pencil} disabled={busy} onClick={() => { setError(""); setEditing(job); }}>{t("编辑", "Edit")}</Button>
      <IconButton icon={Trash2} label={t("删除任务", "Delete task")} disabled={busy} onClick={() => { setError(""); setDeleting(true); }}/>
    </div>
    <h3>{t("最近运行", "Recent runs")}</h3>
    {job.runs.length ? <ol className="schedule-runs">{job.runs.map(run => <li key={run.id}>
      <div><span className={"schedule-run-state " + run.status}>{t(...(states[run.status] || [run.status, run.status]))}</span>
        <small>{dateLabel(run.startedAt, t)} · {run.source === "manual" ? t("手动", "Manual") : t("定时", "Scheduled")}</small>
        {run.error && <p>{run.error}</p>}
      </div>
      {run.chatId && <button type="button" className="text-btn schedule-open" onClick={() => select(run.chatId)}>{t("查看会话", "Open chat")}<ArrowUpRight size={13}/></button>}
    </li>)}</ol> : <p className="schedule-no-runs">{t("首次运行后，结果会出现在这里。", "Results will appear here after the first run.")}</p>}
    {deleting && <Modal title={t("删除定时任务？", "Delete scheduled task?")}
      subtitle={t(`删除「${job.name}」后将停止后续运行，并保留已有会话。`, `Future runs of “${job.name}” will stop. Existing chats are kept.`)}
      onClose={() => { if (!busy) setDeleting(false); }}><Notice>{error}</Notice><div className="form-actions">
        <Button disabled={busy} onClick={() => setDeleting(false)}>{t("取消", "Cancel")}</Button>
        <Button variant="danger" busy={busy} onClick={() => act("delete", { id: job.id, revision: job.revision }, back)}>{t("删除任务", "Delete task")}</Button>
      </div></Modal>}
  </article></div>;
}

function localDateTime(at) {
  const d = new Date(at);
  return new Date(at - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
function ScheduleForm({ initial, state, busy, error, onSave, onClose, onAddBot }) {
  const t = useLanguage();
  const [name, setName] = useState(initial?.name || "");
  const [prompt, setPrompt] = useState(initial?.prompt || "");
  const bots = state.bots.filter(bot => !bot.archived);
  const [chosenBot, setBotId] = useState(initial?.botId || bots[0]?.id || "");
  const botId = chosenBot || bots[0]?.id || "";
  const [projectId, setProjectId] = useState(initial?.projectId || "");
  const [frequency, setFrequency] = useState(initial?.rule?.frequency || "daily");
  const [time, setTime] = useState(initial?.rule?.time || "09:00");
  const [minute, setMinute] = useState(initial?.rule?.minute ?? 0);
  const [days, setDays] = useState(initial?.rule?.days || [1]);
  const [day, setDay] = useState(initial?.rule?.day ?? 1);
  const [month, setMonth] = useState(initial?.rule?.month ?? 1);
  const [once, setOnce] = useState(() => localDateTime(initial?.rule?.at || Date.now() + 3_600_000));
  const hasBot = bots.some(b => b.id === botId);
  const hasProject = !projectId || state.projects?.some(p => p.id === projectId);
  function submit(event) {
    event.preventDefault();
    const rule = frequency === "once" ? { frequency, at: new Date(once).getTime() } :
      frequency === "hourly" ? { frequency, minute: Number(minute) } :
      frequency === "weekly" ? { frequency, time, days } :
      frequency === "monthly" ? { frequency, time, day: Number(day) } :
      frequency === "yearly" ? { frequency, time, month: Number(month), day: Number(day) } : { frequency, time };
    onSave({ id: initial?.id, revision: initial?.revision, name, prompt, rule, projectId: projectId || null, botId });
  }
  return <article className="schedule-content"><h2>{initial?.id ? t("编辑定时任务", "Edit scheduled task") : t("新建定时任务", "New scheduled task")}</h2>
    <form className="schedule-form" onSubmit={submit}>
      <Notice>{error}</Notice>
      <Field label={t("任务名称", "Task name")}><input data-autofocus required maxLength={120} value={name} onChange={e => setName(e.target.value)}
        placeholder={t("例如，每日项目简报", "e.g. Daily project briefing")}/></Field>
      <Field label={t("任务指令", "Instructions")}><textarea rows={4} required maxLength={200000} value={prompt} onChange={e => setPrompt(e.target.value)}
        placeholder={t("告诉 Bot 需要完成什么工作…", "Describe what the bot should do…")}/></Field>
      {!bots.length && <div className="schedule-bot-needed"><p>{t("添加一个 Bot 来运行此任务。", "Add a bot to run this task.")}</p><Button icon={Plus} onClick={onAddBot}>{t("添加 Bot", "Add bot")}</Button></div>}
      <div className="schedule-fields">
        <Field label={t("执行 Bot", "Bot")}><Select value={botId} onChange={e => setBotId(e.target.value)}>
          {!hasBot && <option value={botId} disabled>{t("请选择 Bot", "Choose a bot")}</option>}
          {bots.map(b => <option key={b.id} value={b.id}>{b.name} · {providerName(state.accounts.find(a => a.id === b.accountId)?.provider)}</option>)}
        </Select></Field>
        <Field label={t("工作项目", "Project")}><Select value={projectId} onChange={e => setProjectId(e.target.value)}>
          <option value="">{t("Bot 默认目录", "Bot’s default directory")}</option>
          {!hasProject && <option value={projectId} disabled>{t("项目已移除", "Project removed")}</option>}
          {state.projects?.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select></Field>
      </div>
      <div className="schedule-fields">
        <Field label={t("频率", "Frequency")}><Select value={frequency} onChange={e => setFrequency(e.target.value)}>
          <option value="once">{t("仅一次", "Once")}</option><option value="hourly">{t("每小时", "Hourly")}</option>
          <option value="daily">{t("每天", "Daily")}</option><option value="weekly">{t("每周", "Weekly")}</option>
          <option value="monthly">{t("每月", "Monthly")}</option><option value="yearly">{t("每年", "Yearly")}</option>
        </Select></Field>
        {frequency === "once" ? <Field label={t("本机日期和时间", "Local date and time")}><input type="datetime-local" required value={once} onChange={e => setOnce(e.target.value)}/></Field> :
          frequency === "hourly" ? <Field label={t("每小时的第几分钟", "Minute of the hour")}><input type="number" min={0} max={59} required value={minute} onChange={e => setMinute(e.target.value)}/></Field> :
          <Field label={t("本机时间", "Local time")}><input type="time" required value={time} onChange={e => setTime(e.target.value)}/></Field>}
      </div>
      {(frequency === "monthly" || frequency === "yearly") && <div className="schedule-fields">
        {frequency === "yearly" && <Field label={t("月份", "Month")}><Select value={month} onChange={e => setMonth(Number(e.target.value))}>
          {Array.from({ length: 12 }, (_, index) => <option key={index} value={index + 1}>{new Date(2000, index, 1).toLocaleDateString(t("zh-CN", "en-US"), { month: "long" })}</option>)}
        </Select></Field>}
        <Field label={t("日期", "Day of month")} hint={frequency === "monthly" && Number(day) > 28 ? t("当月没有该日期时将跳过。", "Months without this day are skipped.") : undefined}>
          <input type="number" min={1} max={frequency === "yearly" ? new Date(2000, month, 0).getDate() : 31} required value={day} onChange={e => setDay(e.target.value)}/>
        </Field>
      </div>}
      {frequency === "weekly" && <fieldset className="schedule-day-field"><legend>{t("运行日期", "Run on")}</legend>
        <div className="schedule-days">{weekdays.map(d => <button key={d} type="button" aria-pressed={days.includes(d)}
          onClick={() => setDays(previous => previous.includes(d) ? previous.filter(value => value !== d) : [...previous, d])}>
          {t("周" + shortDays[d], englishDays[d])}</button>)}</div></fieldset>}
      <p className="schedule-footnote">{t("按本机时间运行。请保持 BoTeam 打开，重新打开时会补跑最近一次到期的任务。", "Runs in local time while BoTeam is open. On reopening, the latest missed run is picked up.")}</p>
      <div className="form-actions"><Button onClick={onClose} disabled={busy}>{t("取消", "Cancel")}</Button>
        <Button type="submit" variant="primary" busy={busy} disabled={!name.trim() || !prompt.trim() || !hasBot || !hasProject || (frequency === "weekly" && !days.length)}>
          {initial?.id ? t("保存", "Save") : t("创建任务", "Create task")}</Button></div>
    </form>
  </article>;
}
