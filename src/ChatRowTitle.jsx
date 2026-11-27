import React, { useLayoutEffect, useRef } from "react";

export function ChatRowTitle({ children }) {
  const viewport = useRef(null);
  useLayoutEffect(() => {
    const clip = viewport.current;
    const text = clip.firstElementChild;
    const observer = new ResizeObserver(() => {
      const distance = text.getBoundingClientRect().width - clip.getBoundingClientRect().width;
      clip.toggleAttribute("data-overflow", distance > 1);
      if (distance <= 1) return;
      const fontSize = parseFloat(getComputedStyle(text).fontSize);
      clip.style.setProperty("--title-offset", `-${distance}px`);
      clip.style.setProperty("--title-duration", `${distance / (2 * fontSize)}s`);
    });
    observer.observe(clip);
    observer.observe(text);
    return () => observer.disconnect();
  }, []);

  return <span className="chat-row-title" ref={viewport}><span className="chat-title-text">{children}</span></span>;
}
