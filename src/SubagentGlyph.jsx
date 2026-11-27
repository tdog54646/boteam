import React from "react";
import { usePreferences } from "./preferences";
import "./subagent-glyph.css";

// Codex pairs each light glyph with a separately drawn dark glyph.
const glyphs = import.meta.glob("../assets/subagent-glyphs/*.svg", {
  eager: true, query: "?url", import: "default",
});
const paletteSize = Object.keys(glyphs).length / 2;

const variantColors = {
  0: "light-dark(#c96a12, #ffb455)",
  1: "light-dark(#c83776, #f886b7)",
  2: "light-dark(#2168c4, #7cb6ff)",
  3: "light-dark(#cc3b3d, #ff6c6f)",
  4: "light-dark(#127b8d, #75d9e9)",
  5: "light-dark(#6f5d96, #cdbdea)",
  6: "light-dark(#248768, #91e8c7)",
  7: "light-dark(#438a29, #a9e597)",
  8: "light-dark(#9e7400, #ffe236)",
  9: "light-dark(#7847d6, #b99ef8)",
  10: "light-dark(#9e7400, #ffe236)",
  11: "light-dark(#c96a12, #ffb455)",
  12: "light-dark(#cc3b3d, #ff6c6f)",
  13: "light-dark(#c83776, #f886b7)",
  14: "light-dark(#7847d6, #b99ef8)",
  15: "light-dark(#2168c4, #7cb6ff)",
  16: "light-dark(#248768, #91e8c7)",
  17: "light-dark(#127b8d, #75d9e9)",
  18: "light-dark(#6f5d96, #cdbdea)",
  19: "light-dark(#c96a12, #ffb455)",
  20: "light-dark(#cc3b3d, #ff6c6f)",
  21: "light-dark(#c83776, #f886b7)",
  22: "light-dark(#7847d6, #b99ef8)",
  23: "light-dark(#2168c4, #7cb6ff)",
  24: "light-dark(#438a29, #a9e597)",
  25: "light-dark(#248768, #91e8c7)",
  26: "light-dark(#127b8d, #75d9e9)",
  27: "light-dark(#6f5d96, #cdbdea)",
};

export function subagentVariant(seed = "") {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (31 * hash + seed.charCodeAt(index)) % 0x7fffffff;
  }
  return hash % paletteSize;
}

export function subagentAccentColor(seed = "") {
  return variantColors[subagentVariant(seed)] || "var(--accent)";
}

export function SubagentGlyph({ seed, size = 14 }) {
  const { appearance } = usePreferences();
  const variant = subagentVariant(seed);
  return <picture className="subagent-glyph" data-variant={variant} aria-hidden="true">
    <img src={glyphs[`../assets/subagent-glyphs/${variant}-${appearance}.svg`]} width={size} height={size} alt="" draggable={false} />
  </picture>;
}

export default SubagentGlyph;
