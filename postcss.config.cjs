// Keep the existing desktop layout in logical pixels while scaling app typography.
// Vendor styles (including the PDF and terminal canvases) use their own metrics.
module.exports = {
  plugins: [{
    postcssPlugin: "boteam-text-size",
    Declaration(declaration) {
      if (!["font", "font-size", "line-height"].includes(declaration.prop)) return;
      const file = declaration.source?.input.file || "";
      if (!/[/\\]src[/\\]/.test(file) || file.includes("node_modules") || declaration.value.includes("--font-scale")) return;
      declaration.value = declaration.value.replace(/(\d+(?:\.\d+)?)px\b/g,
        (_, size) => `calc(${size}px * var(--font-scale, 1))`);
    },
  }],
};
