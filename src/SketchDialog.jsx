import React, { useLayoutEffect, useRef, useState } from "react";
import { Button, Modal, Notice } from "./ui";

export function SketchDialog({ busy, error, onClose, onAdd }) {
  const canvas = useRef(null);
  const activePointer = useRef(null);
  const [drawn, setDrawn] = useState(false);

  function clear() {
    const node = canvas.current;
    const ctx = node.getContext("2d");
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, node.width, node.height);
    setDrawn(false);
  }
  useLayoutEffect(clear, []);

  function point(event) {
    const rect = canvas.current.getBoundingClientRect();
    return [
      ((event.clientX - rect.left) * canvas.current.width) / rect.width,
      ((event.clientY - rect.top) * canvas.current.height) / rect.height,
    ];
  }
  function start(event) {
    if (busy || event.button !== 0 || activePointer.current !== null) return;
    const node = canvas.current;
    activePointer.current = event.pointerId;
    node.setPointerCapture(event.pointerId);
    const ctx = node.getContext("2d");
    const [x, y] = point(event);
    ctx.lineWidth = 3.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.fillStyle = ctx.strokeStyle = "#202329";
    ctx.beginPath();
    ctx.arc(x, y, ctx.lineWidth / 2, 0, 2 * Math.PI);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x, y);
    setDrawn(true);
  }
  function draw(event) {
    if (activePointer.current !== event.pointerId) return;
    const ctx = canvas.current.getContext("2d");
    const [x, y] = point(event);
    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x, y);
  }
  return (
    <Modal title="绘制草图" onClose={onClose}>
      <canvas
        width={1024}
        height={640}
        ref={canvas}
        className="sketch-surface"
        aria-label="草图画布"
        onPointerDown={start}
        onPointerMove={draw}
        onLostPointerCapture={() => {
          activePointer.current = null;
        }}
      />
      <Notice>{error}</Notice>
      <div className="form-actions">
        <Button disabled={!drawn || busy} onClick={clear}>
          清空画布
        </Button>
        <Button
          variant="primary"
          busy={busy}
          disabled={!drawn}
          onClick={() => onAdd(canvas.current)}
        >
          添加到消息
        </Button>
      </div>
    </Modal>
  );
}
