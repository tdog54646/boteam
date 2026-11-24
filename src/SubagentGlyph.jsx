import React from "react";
import "./subagent-glyph.css";

// Codex pairs each light glyph with a separately drawn dark glyph.
const glyphs = import.meta.glob("../assets/subagent-glyphs/*.svg", {
  eager: true, query: "?url", import: "default",
});
const paletteSize = Object.keys(glyphs).length / 2;

export function SubagentGlyph({ seed, size = 14 }) {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (31 * hash + seed.charCodeAt(index)) % 0x7fffffff;
  }
  const variant = hash % paletteSize;
  return <picture className="subagent-glyph" data-variant={variant} aria-hidden="true">
    <source media="(prefers-color-scheme: dark)" srcSet={glyphs[`../assets/subagent-glyphs/${variant}-dark.svg`]} />
    <img src={glyphs[`../assets/subagent-glyphs/${variant}-light.svg`]} width={size} height={size} alt="" draggable={false} />
  </picture>;
}

export default SubagentGlyph;
