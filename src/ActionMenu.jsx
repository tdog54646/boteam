import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronRight } from "lucide-react";
import "./chat-actions.css";

const edge = 5;
const clamp = (value, size, limit) => Math.max(edge, Math.min(value, limit - size - edge));
function focusItem(menu, key) {
  const rows = [...menu.querySelectorAll('button:enabled')];
  const index = rows.indexOf(document.activeElement);
  const next = key === "Home" ? 0 : key === "End" ? rows.length - 1 :
    key === "ArrowDown" ? (index + 1) % rows.length : (index + rows.length - 1) % rows.length;
  rows[next]?.focus();
}

export function ActionMenu({ label, groups, anchor, variant, onAction, onClose }) {
  const main = useRef(null);
  const child = useRef(null);
  const owner = useRef(null);
  const keyboardChild = useRef(false);
  const [branch, setBranch] = useState(null);
  const header = variant === "header";
  const subItems = groups.flat().find(item => item.id === branch)?.children;
  function openBranch(item, element, keyboard = false) {
    owner.current = element;
    keyboardChild.current = keyboard;
    setBranch(item.id);
    if (keyboard) child.current?.querySelector("button")?.focus();
  }
  function closeMenu(restoreFocus) {
    if (restoreFocus) anchor.anchor?.focus({ preventScroll: true });
    onClose();
  }
  useLayoutEffect(() => {
    const node = main.current;
    function place() {
      const trigger = anchor.anchor?.getBoundingClientRect();
      const x = header && trigger ? trigger.right - node.offsetWidth : anchor.x ?? trigger?.left ?? edge;
      const y = header && trigger ? trigger.bottom + 5 : anchor.y ?? trigger?.bottom ?? edge;
      node.style.left = clamp(x, node.offsetWidth, window.innerWidth) + "px";
      node.style.top = clamp(y, node.offsetHeight, window.innerHeight) + "px";
      setBranch(null);
    }
    place();
    node.querySelector("button")?.focus({ preventScroll: true });
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchor, header]);

  useLayoutEffect(() => {
    const node = child.current;
    if (!node || !owner.current) return;
    const row = owner.current.getBoundingClientRect();
    const parent = main.current.getBoundingClientRect();
    const right = parent.right + node.offsetWidth + edge <= window.innerWidth;
    node.style.left = clamp(right ? parent.right + 1 : parent.left - node.offsetWidth - 1,
      node.offsetWidth, window.innerWidth) + "px";
    node.style.top = clamp(row.top - 4, node.offsetHeight, window.innerHeight) + "px";
    if (keyboardChild.current) node.querySelector("button")?.focus({ preventScroll: true });
  }, [branch, subItems?.length]);

  useEffect(() => {
    const outside = event => {
      if (!main.current?.contains(event.target) && !child.current?.contains(event.target)
        && !anchor.anchor?.contains(event.target)) onClose();
    };
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("blur", onClose);
    };
  }, [anchor, onClose]);

  function keyboard(event, submenu = false) {
    const { key } = event;
    if (key === "Tab") {
      closeMenu(true);
      return;
    }
    if (!["Home", "End", "ArrowDown", "ArrowUp", "Escape", "ArrowLeft", "ArrowRight"].includes(key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (submenu && (key === "Escape" || key === "ArrowLeft")) {
      setBranch(null);
      owner.current?.focus({ preventScroll: true });
    } else if (key === "Escape") closeMenu(true);
    else if (key === "ArrowRight" && !submenu) {
      const item = groups.flat().find(item => item.id === document.activeElement?.dataset.action);
      if (item?.children) openBranch(item, document.activeElement, true);
    } else if (["Home", "End", "ArrowDown", "ArrowUp"].includes(key)) {
      if (!submenu) setBranch(null);
      focusItem(submenu ? child.current : main.current, key);
    }
  }

  function row(item, submenu = false) {
    const Icon = item.icon;
    return <button type="button" role="menuitem" key={item.payload?.sectionId || item.payload?.projectId || item.payload?.target || item.id}
      tabIndex={-1} disabled={item.disabled} data-action={item.id}
      className={`${branch === item.id ? "active " : ""}${header && item.danger ? "danger" : ""}`}
      aria-haspopup={item.children ? "menu" : undefined} aria-expanded={item.children ? branch === item.id : undefined}
      onPointerEnter={event => {
        if (event.pointerType !== "mouse" || item.disabled) return;
        if (!submenu && item.children) openBranch(item, event.currentTarget);
        else if (!submenu) setBranch(null);
        event.currentTarget.focus({ preventScroll: true });
      }}
      onClick={event => {
        if (item.children) { openBranch(item, event.currentTarget, event.detail === 0); return; }
        const rect = event.currentTarget.getBoundingClientRect();
        closeMenu(true);
        onAction(item, rect);
      }}>
      {Icon ? <Icon size={15} strokeWidth={1.7} /> : item.selected ? <Check size={14} /> : <i aria-hidden="true" />}
      <span>{item.text}</span>
      {item.key && <kbd aria-hidden="true">{item.key}</kbd>}
      {item.children && <ChevronRight size={14} className="cam-chevron" />}
    </button>;
  }
  return createPortal(<>
    <div ref={main} className={`chat-action-menu cam-${variant}`} role="menu"
      aria-label={label} onKeyDown={event => keyboard(event)}
      onScroll={() => setBranch(null)} onContextMenu={event => event.preventDefault()}>
      {groups.map((group, index) => <React.Fragment key={group[0].id}>
        {index > 0 && <div role="separator" />}
        {group.map(item => row(item))}
      </React.Fragment>)}
    </div>
    {subItems && <div ref={child} role="menu" className={`chat-action-menu cam-child cam-${variant}`}
      aria-label={groups.flat().find(item => item.id === branch)?.text}
      onKeyDown={event => keyboard(event, true)} onContextMenu={event => event.preventDefault()}>
      {subItems.map(item => row(item, true))}
    </div>}
  </>, document.body);
}
