import React, { useEffect, useRef, useState } from "react";

export const SIDEBAR_WIDTH_KEY = "boteam:sidebar-width";
export const PANEL_WIDTH_KEY = "boteam:panel-width";

export const SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_MAX_WIDTH = 480;
export const PANEL_MIN_WIDTH = 280;
export const PANEL_MAX_WIDTH = 1100;

export function readStoredPaneWidth(key, min, max) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const value = Number(raw);
    if (!Number.isFinite(value)) return null;
    return Math.round(Math.min(max, Math.max(min, value)));
  } catch {
    return null;
  }
}

export function writeStoredPaneWidth(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, String(Math.round(value)));
  } catch {}
}

export function PaneResizer({
  side,
  label,
  value,
  min,
  max,
  getBounds,
  onResize,
  onReset,
}) {
  const [dragging, setDragging] = useState(false);
  const cleanupRef = useRef(null);
  const handleRef = useRef(null);

  useEffect(() => {
    return () => {
      cleanupRef.current?.();
    };
  }, []);

  function resolveBounds() {
    if (typeof getBounds === "function") {
      const dynamic = getBounds();
      if (dynamic && Number.isFinite(dynamic.min) && Number.isFinite(dynamic.max)) {
        return {
          min: dynamic.min,
          max: Math.max(dynamic.min, dynamic.max),
        };
      }
    }
    return { min, max: Math.max(min, max) };
  }

  function currentRenderedWidth() {
    const el = handleRef.current;
    if (!el) return value;
    const target = side === "left" ? el.previousElementSibling : el.nextElementSibling;
    const rect = target?.getBoundingClientRect();
    return rect && rect.width > 0 ? Math.round(rect.width) : value;
  }

  function handlePointerDown(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    cleanupRef.current?.();

    const startX = event.clientX;
    const startWidth = currentRenderedWidth() ?? (side === "left" ? 256 : 440);
    let latestWidth = startWidth;
    let moved = false;

    setDragging(true);
    document.body.classList.add("is-resizing-pane");

    function handleMove(moveEvent) {
      const delta = moveEvent.clientX - startX;
      if (!moved && Math.abs(delta) < 1) return;
      moved = true;
      const rawNext = side === "left" ? startWidth + delta : startWidth - delta;
      const bounds = resolveBounds();
      latestWidth = Math.round(Math.min(bounds.max, Math.max(bounds.min, rawNext)));
      onResize(latestWidth, false);
    }

    function finish() {
      cleanup();
      if (moved) {
        onResize(latestWidth, true);
      }
    }

    function cleanup() {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("blur", finish);
      document.body.classList.remove("is-resizing-pane");
      setDragging(false);
      cleanupRef.current = null;
    }

    cleanupRef.current = cleanup;
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    window.addEventListener("blur", finish);
  }

  function handleKeyDown(event) {
    if (event.key === "Enter") {
      event.preventDefault();
      onReset?.();
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const step = event.shiftKey ? 48 : 20;
    const base = currentRenderedWidth() ?? (side === "left" ? 256 : 440);
    const dir = event.key === "ArrowRight" ? 1 : -1;
    const rawNext = side === "left" ? base + dir * step : base - dir * step;
    const bounds = resolveBounds();
    const clamped = Math.round(Math.min(bounds.max, Math.max(bounds.min, rawNext)));
    onResize(clamped, true);
  }

  const bounds = resolveBounds();
  const ariaNow = value != null ? Math.min(bounds.max, Math.max(bounds.min, value)) : undefined;

  return (
    <div
      ref={handleRef}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={bounds.min}
      aria-valuemax={bounds.max}
      aria-valuenow={ariaNow}
      tabIndex={0}
      title={`${label}（双击恢复默认宽度）`}
      className={`pane-resizer pane-resizer-${side} ${dragging ? "is-dragging" : ""}`}
      onPointerDown={handlePointerDown}
      onDoubleClick={(event) => {
        event.preventDefault();
        onReset?.();
      }}
      onKeyDown={handleKeyDown}
    />
  );
}
