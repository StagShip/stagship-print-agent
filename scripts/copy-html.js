#!/usr/bin/env node
/** Copy HTML assets from src/renderer/ → dist/renderer/ post tsc compile. */
const fs = require("fs");
const path = require("path");

const src = path.join(__dirname, "..", "src", "renderer");
const dst = path.join(__dirname, "..", "dist", "renderer");
fs.mkdirSync(dst, { recursive: true });

let count = 0;
for (const file of fs.readdirSync(src)) {
  if (!file.endsWith(".html") && !file.endsWith(".css")) continue;
  fs.copyFileSync(path.join(src, file), path.join(dst, file));
  count++;
}
console.log(`Copied ${count} renderer asset${count === 1 ? "" : "s"} to dist/renderer/`);
