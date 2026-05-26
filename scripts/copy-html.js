#!/usr/bin/env node
/** Copy non-TS renderer assets (HTML, CSS, images) from src/renderer/ → dist/renderer/ post tsc compile. */
const fs = require("fs");
const path = require("path");

const ASSET_EXTS = [".html", ".css", ".png", ".jpg", ".jpeg", ".svg", ".webp", ".gif", ".ico"];

const src = path.join(__dirname, "..", "src", "renderer");
const dst = path.join(__dirname, "..", "dist", "renderer");
fs.mkdirSync(dst, { recursive: true });

let count = 0;
for (const file of fs.readdirSync(src)) {
  const ext = path.extname(file).toLowerCase();
  if (!ASSET_EXTS.includes(ext)) continue;
  fs.copyFileSync(path.join(src, file), path.join(dst, file));
  count++;
}
console.log(`Copied ${count} renderer asset${count === 1 ? "" : "s"} to dist/renderer/`);
