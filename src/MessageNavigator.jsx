import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import "./message-navigator.css";

const fanout = [1, 0.7, 0.4, 0.2];

function excerpt(text, limit) {
  const characters = [...text.trim().replace(/\s+/gu, " ").slice(0, limit * 2 + 2)];
  return characters.length <= limit ? characters.join("") : characters.slice(0, limit - 1).join("").trimEnd() + "…";
}

function messageTurns(messages, tasks) {
  const turns = new Map();
  const parents = new Map(tasks.map(task => [task.id, task.messageId]));
  let latest;
  for (const message of messages) {
    if (message.author === "user") {
      latest = {
        id: message.id,
        prompt: excerpt(message.text || "", 120) || "图片或附件消息",
        reply: null,
      };
      turns.set(latest.id, latest);
    } else if (message.author === "bot" && message.text?.trim()) {
      const parent = parents.get(message.taskId);
      const turn = parent ? turns.get(parent) : latest;
      if (turn) turn.reply = message;
    }
  }
  return [...turns.values()];
}

function turnAt(turns, line, origin) {
  let low = 0;
  let high = turns.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const node = document.getElementById(`message-${turns[middle].id}`);
    if (node && node.getBoundingClientRect().top - origin <= line) low = middle + 1;
    else high = middle;
  }
  return Math.max(0, low - 1);
}

function revealMarker(list, marker) {
  const bounds = list.getBoundingClientRect();
  const row = marker.getBoundingClientRect();
  if (row.top < bounds.top) list.scrollTop += row.top - bounds.top;
  else if (row.bottom > bounds.bottom) list.scrollTop += row.bottom - bounds.bottom;
}

export function MessageNavigator({ messages, tasks, scrollRef, onNavigate }) {
  const turns = useMemo(() => messageTurns(messages, tasks), [messages, tasks]);
  return turns.length > 1 && <TurnRail turns={turns} scrollRef={scrollRef} onNavigate={onNavigate} />;
}

function TurnRail({ turns, scrollRef, onNavigate }) {
  const nav = useRef(null);
  const list = useRef(null);
  const card = useRef(null);
  const previewId = useId();
  const timer = useRef(null);
  const pointed = useRef(-1);
  const gesture = useRef(null);
  const suppressClick = useRef(false);
  const flash = useRef(null);
  const [{ active, first, last, visible }, setPosition] = useState({ active: 0, first: 0, last: 0, visible: false });
  const [target, setTarget] = useState(-1);
  const [preview, setPreview] = useState(-1);
  const [answer, setAnswer] = useState("");
  const [focusId, setFocusId] = useState(null);
  const [dragging, setDragging] = useState(false);
  const focusIndex = focusId == null ? -1 : turns.findIndex(turn => turn.id === focusId);
  const shown = turns[preview];
  const reply = shown?.reply;

  useLayoutEffect(() => {
    const nodes = reply && document.getElementById(`message-${reply.id}`)?.querySelectorAll(".markdown");
    const text = nodes?.length ? nodes[nodes.length - 1].innerText : "";
    setAnswer(excerpt(text || reply?.text || "", 320));
  }, [reply]);

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const rail = nav.current;
    let frame;
    function update() {
      frame = undefined;
      const bounds = scroller.getBoundingClientRect();
      const visible = scroller.firstElementChild.getBoundingClientRect().left - bounds.left >= 48;
      if (!visible) {
        if (!rail.hidden) {
          const held = gesture.current;
          gesture.current = null;
          const marker = held && list.current.children[held.index];
          if (marker?.hasPointerCapture(held.id)) marker.releasePointerCapture(held.id);
          suppressClick.current = Boolean(held);
          setDragging(false);
          show(-1);
        }
        setPosition(previous => previous.visible ? { ...previous, visible } : previous);
        return;
      }
      const origin = bounds.top;
      const height = scroller.clientHeight;
      const first = turnAt(turns, 0, origin);
      const last = turnAt(turns, height - 0.5, origin);
      const atBottom = scroller.scrollHeight - height - scroller.scrollTop <= 2;
      const active = atBottom ? turns.length - 1 : turnAt(turns, height * 0.25, origin);
      setPosition(previous => previous.visible && previous.active === active && previous.first === first && previous.last === last
        ? previous : { active, first, last, visible });
    }
    function schedule() {
      if (frame === undefined) frame = requestAnimationFrame(update);
    }
    const observer = new ResizeObserver(schedule);
    observer.observe(scroller);
    observer.observe(scroller.firstElementChild);
    scroller.addEventListener("scroll", schedule, { passive: true });
    update();
    return () => {
      observer.disconnect();
      scroller.removeEventListener("scroll", schedule);
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [scrollRef, turns]);

  useLayoutEffect(() => {
    if (!visible || focusIndex >= 0 || gesture.current) return;
    const marker = list.current.children[active];
    if (marker) revealMarker(list.current, marker);
  }, [active, focusIndex, visible]);

  function positionPreview() {
    const marker = list.current.children[preview];
    if (!marker || !card.current) return;
    const bounds = nav.current.getBoundingClientRect();
    const row = marker.getBoundingClientRect();
    if (row.bottom <= bounds.top || row.top >= bounds.bottom) {
      show(-1);
      return;
    }
    const half = card.current.getBoundingClientRect().height / 2;
    const center = Math.max(half + 8, Math.min(row.top + row.height / 2, window.innerHeight - half - 8));
    card.current.style.top = `${Math.round(center - bounds.top)}px`;
  }

  useLayoutEffect(() => {
    if (preview < 0 || !card.current) return;
    const observer = new ResizeObserver(positionPreview);
    observer.observe(nav.current);
    observer.observe(list.current);
    observer.observe(card.current);
    positionPreview();
    return () => observer.disconnect();
  }, [preview, answer]);

  useEffect(() => () => {
    clearTimeout(timer.current);
    flash.current?.();
  }, []);

  function show(index, delay = 0) {
    clearTimeout(timer.current);
    pointed.current = index;
    setTarget(index);
    setPreview(delay ? -1 : index);
    if (delay) timer.current = setTimeout(() => setPreview(index), delay);
  }

  function jump(index) {
    const scroller = scrollRef.current;
    const message = document.getElementById(`message-${turns[index].id}`);
    if (!message) return;
    const top = scroller.scrollTop + message.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    scroller.scrollTo({ top: top - 12, behavior: "instant" });
    onNavigate(scroller);
    flash.current?.();
    clearTimeout(timer.current);
    setPreview(-1);
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const clear = () => message.classList.remove("message-nav-static-flash");
      message.classList.add("message-nav-static-flash");
      const timeout = setTimeout(clear, 500);
      flash.current = () => {
        clearTimeout(timeout);
        clear();
      };
    } else {
      const tint = "color-mix(in srgb, #339cff 12%, transparent)";
      const animation = message.animate([
        { backgroundColor: tint, borderRadius: "8px" },
        { backgroundColor: tint, borderRadius: "8px", offset: 0.28, easing: "ease-out" },
        { backgroundColor: "transparent", borderRadius: "8px" },
      ], { duration: 900 });
      flash.current = () => animation.cancel();
    }
  }

  function markerIndex(node) {
    const marker = node?.closest("button[data-turn]");
    return marker?.parentElement === list.current ? Number(marker.dataset.turn) : -1;
  }

  function pointerDown(event) {
    if (!event.isPrimary || event.button !== 0) return;
    const index = markerIndex(event.target);
    if (index < 0) return;
    event.preventDefault();
    const button = list.current.children[index];
    button.setPointerCapture(event.pointerId);
    gesture.current = { id: event.pointerId, index, target: -1, dragged: false };
    suppressClick.current = false;
    clearTimeout(timer.current);
    pointed.current = index;
    setTarget(index);
    setPreview(-1);
  }

  function pointerMove(event) {
    if (!event.isPrimary) return;
    const held = gesture.current;
    if (!held) {
      const index = markerIndex(event.target);
      if (event.pointerType !== "touch" && index !== pointed.current) show(index, index < 0 ? 0 : 150);
      return;
    }
    if (held.id !== event.pointerId) return;
    event.preventDefault();
    const index = markerIndex(document.elementFromPoint(event.clientX, event.clientY));
    if (index === held.index && !held.dragged) return;
    held.dragged = true;
    if (index < 0 || index === held.target) return;
    held.target = index;
    setDragging(true);
    jump(index);
    show(index);
  }

  function pointerEnd(event) {
    const held = gesture.current;
    if (held?.id !== event.pointerId) return;
    suppressClick.current = held.dragged || event.type !== "pointerup";
    gesture.current = null;
    setDragging(false);
    show(-1);
  }

  function keyDown(event) {
    const index = markerIndex(event.target);
    if (index < 0) return;
    if (event.key === "Escape") {
      show(-1);
      return;
    }
    const offsets = { ArrowUp: index - 1, ArrowDown: index + 1, Home: 0, End: turns.length - 1 };
    if (!Object.hasOwn(offsets, event.key)) return;
    event.preventDefault();
    const next = Math.max(0, Math.min(offsets[event.key], turns.length - 1));
    const marker = list.current.children[next];
    marker.focus({ preventScroll: true });
    setFocusId(turns[next].id);
    revealMarker(list.current, marker);
    show(next);
  }

  return (
    <nav className="message-nav" aria-label="消息导航" ref={nav} hidden={!visible} data-dragging={dragging}>
      <div
        className="message-nav-list"
        data-previewing={target >= 0}
        ref={list}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerLeave={() => { if (!gesture.current) show(-1); }}
        onPointerUp={pointerEnd}
        onPointerCancel={pointerEnd}
        onLostPointerCapture={pointerEnd}
        onKeyDown={keyDown}
        onScroll={positionPreview}
        onBlur={event => {
          if (!list.current.contains(event.relatedTarget)) {
            setFocusId(null);
            if (!gesture.current) show(-1);
          }
        }}
      >
        {turns.map((turn, index) => (
          <button
            type="button"
            className="message-nav-marker"
            key={turn.id}
            data-turn={index}
            data-in-view={index >= first && index <= last}
            data-target={target === index}
            aria-label={turn.prompt}
            aria-current={active === index ? "location" : undefined}
            aria-describedby={preview === index ? previewId : undefined}
            tabIndex={index === (focusIndex < 0 ? active : focusIndex) ? 0 : -1}
            style={{ "--marker-progress": target < 0 ? 0 : fanout[Math.abs(index - target)] || 0 }}
            onFocus={event => {
              if (event.currentTarget.matches(":focus-visible")) {
                setFocusId(turn.id);
                show(index);
              }
            }}
            onClick={event => {
              if (event.detail === 0 || !suppressClick.current) jump(index);
              suppressClick.current = false;
            }}
          >
            <span className="message-nav-tick" aria-hidden="true" />
          </button>
        ))}
      </div>
      {shown && (
        <div className="message-nav-preview" id={previewId} role="tooltip" ref={card}>
          <strong>{shown.prompt}</strong>
          {answer && <p>{answer}</p>}
        </div>
      )}
    </nav>
  );
}
