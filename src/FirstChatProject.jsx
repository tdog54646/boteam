import { useLanguage } from "./preferences";
import React, { useCallback, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Folder, Plus, Search, X } from "lucide-react";
import "./first-chat-project.css";

function ProjectChoices({ anchor, dialogId, projects, projectId, close, onSelect, onCreate }) {
  const tr = useLanguage();
  const [query, setQuery] = useState("");
  const panel = useRef(null);
  const search = useRef(null);
  const results = useRef(null);
  const term = query.trim().toLocaleLowerCase();
  const choices = projects.filter(project => !term || [project.name, ...project.folders]
    .some(value => value.toLocaleLowerCase().includes(term)));

  useLayoutEffect(() => {
    const menu = panel.current;
    const trigger = anchor.current;
    function position() {
      if (!trigger.isConnected) { close(); return; }
      const rect = trigger.getBoundingClientRect();
      const edge = 8, gap = 5;
      const above = rect.top - gap - edge;
      const below = window.innerHeight - rect.bottom - gap - edge;
      const list = results.current;
      const desired = menu.offsetHeight - list.offsetHeight + Math.min(list.scrollHeight, parseFloat(getComputedStyle(list).maxHeight));
      const placeAbove = above >= desired || above >= below;
      menu.style.maxHeight = Math.max(0, placeAbove ? above : below) + "px";
      menu.style.left = Math.max(edge, Math.min(rect.left, window.innerWidth - menu.offsetWidth - edge)) + "px";
      menu.style.top = (placeAbove ? Math.max(edge, rect.top - gap - menu.offsetHeight) : rect.bottom + gap) + "px";
    }
    const outside = e => {
      if (!trigger.contains(e.target) && !menu.contains(e.target)) close();
    };
    const scroll = e => { if (e.target === window || !menu.contains(e.target)) position(); };
    position();
    search.current.focus({ preventScroll: true });
    const resize = new ResizeObserver(position);
    resize.observe(trigger);
    resize.observe(menu);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("blur", close);
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside);
    return () => {
      resize.disconnect();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("blur", close);
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside);
    };
  }, [anchor, close]);

  function restore() {
    anchor.current?.focus({ preventScroll: true });
    close();
  }
  function select(id) {
    restore();
    onSelect(id);
  }
  function keyboard(e) {
    if (e.nativeEvent.isComposing) return;
    const buttons = [...panel.current.querySelectorAll("button")];
    const index = buttons.indexOf(e.target);
    if (e.key === "Escape") {
      e.preventDefault(); e.stopPropagation(); restore();
    } else if (e.key === "Tab") {
      if ((e.shiftKey && e.target === search.current) || (!e.shiftKey && index === buttons.length - 1)) restore();
    } else if (e.key === "Enter" && e.target === search.current) {
      e.preventDefault();
      if (choices.length) select(choices[0].id);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = e.key === "ArrowDown" ? (index + 1) % buttons.length : index <= 0 ? buttons.length - 1 : index - 1;
      buttons[next]?.focus();
    } else if ((e.key === "Home" || e.key === "End") && index >= 0) {
      e.preventDefault();
      buttons[e.key === "Home" ? 0 : buttons.length - 1]?.focus();
    }
  }

  return createPortal(<div ref={panel} id={dialogId} role="dialog" aria-label={tr("选择聊天项目", "Choose chat project")} className="first-project-menu" onKeyDown={keyboard}>
    <label className="first-project-search"><Search size={14} aria-hidden="true"/>
      <input ref={search} type="search" aria-label={tr("搜索项目", "Search projects")} aria-controls={dialogId + "-options"} autoComplete="off"
        placeholder={tr("搜索项目", "Search projects")} value={query} onChange={e => setQuery(e.target.value)}/>
    </label>
    <div ref={results} className="first-project-results" id={dialogId + "-options"} role="listbox" aria-label={tr("项目", "Projects")}>
      {choices.map(project => <button key={project.id} type="button" role="option" aria-selected={project.id === projectId}
        title={project.name} onClick={() => select(project.id)}>
        <Folder/><span>{project.name}</span>{project.id === projectId && <Check/>}
      </button>)}
      {!choices.length && <div className="first-project-empty">{term ? tr("没有匹配的项目", "No matching projects") : tr("暂无项目", "No projects yet")}</div>}
    </div>
    <div className="first-project-actions">
      <button type="button" onClick={() => { restore(); onCreate(); }}><Plus/><span>{tr("新建项目", "New project")}</span></button>
      <button type="button" aria-pressed={!projectId} onClick={() => select(null)}><X/><span>{tr("不在项目中工作", "Work without a project")}</span>{!projectId && <Check/>}</button>
    </div>
  </div>, document.body);
}

export function FirstChatProject({ projects, projectId, onSelect, onCreate, disabled = false }) {
  const tr = useLanguage();
  const [open, setOpen] = useState(false);
  const anchor = useRef(null);
  const dialogId = useId();
  const current = projects.find(project => project.id === projectId);
  const close = useCallback(() => setOpen(false), []);
  useLayoutEffect(() => { if (disabled) close(); }, [disabled, close]);

  return <>
    <button ref={anchor} type="button" className="first-project-chip" disabled={disabled}
      aria-label={tr("选择聊天项目", "Choose chat project")} aria-description={current?.name || tr("不在项目中工作", "Work without a project")} title={current ? tr("选择聊天项目 · ", "Choose chat project ·") + current.name : tr("选择聊天项目", "Choose chat project")}
      aria-haspopup="dialog" aria-expanded={open && !disabled} aria-controls={open ? dialogId : undefined}
      onClick={() => setOpen(value => !value)} onKeyDown={e => {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setOpen(true); }
      }}>
      <Folder size={15} aria-hidden="true"/><span>{current?.name || tr("选择项目", "Choose project")}</span>
    </button>
    {open && !disabled && <ProjectChoices anchor={anchor} dialogId={dialogId} projects={projects} projectId={projectId}
      close={close} onSelect={onSelect} onCreate={onCreate}/>}
  </>;
}
