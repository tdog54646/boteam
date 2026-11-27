import React, { useMemo, useRef, useState } from "react";
import { usePreferences } from "./preferences";
import "./profile-activity.css";

const dayMs = 86_400_000;
const weeks = 52;
const modes = [
  ["daily", "每天", "Daily"],
  ["weekly", "每周", "Weekly"],
  ["cumulative", "累计总量", "Cumulative"],
];

function calendar(daily, today, mode, language) {
  const first = today - new Date(today * dayMs).getUTCDay() - 7 * (weeks - 1);
  const usage = new Map();
  let running = 0;
  for (const { date, tokens } of daily) {
    const day = Date.parse(date + "T00:00:00Z") / dayMs;
    if (!Number.isFinite(day) || !Number.isFinite(tokens) || tokens <= 0) continue;
    if (day < first) running += tokens;
    else usage.set(day, (usage.get(day) || 0) + tokens);
  }

  const dateFormat = new Intl.DateTimeFormat(language, { dateStyle: "medium", timeZone: "UTC" });
  const monthFormat = new Intl.DateTimeFormat(language, { month: "short", timeZone: "UTC" });
  const numberFormat = new Intl.NumberFormat(language);
  const months = [];
  const cells = [];
  let weekly = 0;
  let maximum = 0;
  for (let day = first; day <= today; day++) {
    const date = new Date(day * dayMs);
    const column = Math.floor((day - first) / 7);
    if (date.getUTCDate() === 1 || day === first) {
      // A short first month may occupy the very same column as the next one.
      if (months.length === 1 && column < 3) months.pop();
      months.push({ column, label: monthFormat.format(date) });
    }
    const tokens = usage.get(day) || 0;
    running += tokens;
    weekly += tokens;
    const weekEnd = date.getUTCDay() === 6 || day === today;
    if (mode === "daily" || weekEnd) {
      let value = tokens;
      let period = dateFormat.format(date);
      if (mode === "weekly") {
        value = weekly;
        period = dateFormat.formatRange(new Date((first + column * 7) * dayMs), date);
      } else if (mode === "cumulative") {
        value = running;
      }
      cells.push({ column, value, label: `${period} · ${numberFormat.format(value)} Tokens` });
      maximum = Math.max(maximum, value);
    }
    if (weekEnd) weekly = 0;
  }
  return { cells, months, maximum };
}

function ActivityChart({ daily, mode, title, language }) {
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / dayMs;
  const { cells, months, maximum } = useMemo(() => calendar(daily, today, mode, language), [daily, today, mode, language]);
  const bars = mode !== "daily";
  const chart = useRef(null);
  const [active, setActive] = useState(cells.length - 1);
  const [hovered, setHovered] = useState(null);
  const [focused, setFocused] = useState(null);
  const detail = cells[hovered ?? focused];

  function navigate(event, index) {
    const stride = bars ? 1 : 7;
    const moves = {
      ArrowRight: index + stride, ArrowLeft: index - stride,
      ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: cells.length - 1,
    };
    if (!Object.hasOwn(moves, event.key)) return;
    event.preventDefault();
    const target = Math.max(0, Math.min(cells.length - 1, moves[event.key]));
    chart.current.children[target].focus();
  }

  return <div className="profile-activity-plot">
    <div ref={chart} className={bars ? "profile-activity-bars" : "profile-activity-calendar"}
      role="group" aria-label={title} onMouseLeave={() => setHovered(null)}>
      {cells.map(({ value, label }, index) => {
        const ratio = maximum ? value / maximum : 0;
        const level = Math.ceil(Math.sqrt(ratio) * 4);
        return <button key={index} type="button" aria-label={label} tabIndex={active === index ? 0 : -1}
          data-level={level} style={bars ? { "--bar-height": `${ratio * 100}%` } : undefined}
          onMouseEnter={() => setHovered(index)} onFocus={() => { setActive(index); setFocused(index); }}
          onBlur={() => setFocused(null)} onKeyDown={event => navigate(event, index)} />;
      })}
    </div>
    <div className="profile-activity-months" aria-hidden="true">
      {months.map(({ column, label }) => <span key={column}
        style={{ gridColumnStart: column + 1 }}>{label}</span>)}
    </div>
    {detail && <span className="profile-activity-tooltip" aria-hidden="true"
      style={{ "--activity-position": `${(detail.column + 0.5) / weeks * 100}%` }}>{detail.label}</span>}
  </div>;
}

const empty = [];
export function ProfileActivity({ daily = empty }) {
  const { t, language } = usePreferences();
  const [mode, setMode] = useState("daily");
  const title = t("Token 活动", "Token activity");
  return <section className="profile-activity" aria-label={title}>
    <div className="profile-activity-heading">
      <h2>{title}</h2>
      <div className="profile-activity-modes" role="group" aria-label={t("统计方式", "Activity view")}>
        {modes.map(([key, zh, en]) => <button key={key} type="button" aria-pressed={mode === key}
          onClick={() => setMode(key)}>{t(zh, en)}</button>)}
      </div>
    </div>
    <ActivityChart key={mode} daily={daily} mode={mode} title={title} language={language} />
  </section>;
}
