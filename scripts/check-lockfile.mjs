#!/usr/bin/env node
// Fails when package-lock.json lacks the per-platform builds of a native package.
//
// npm drops other platforms' optional dependencies when the lockfile is regenerated over an
// existing node_modules (npm/cli#4828). The lockfile then installs on the machine that wrote
// it and nowhere else: `npm ci` on a Mac fails with "Cannot find native binding".
// Fix when this trips: regenerate from nothing —
//   rm -rf node_modules */*/node_modules package-lock.json && npm install
import { readFileSync } from "node:fs";

const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
const present = new Set(Object.keys(lock.packages).map((k) => k.split("node_modules/").pop()));
const PLATFORM = /darwin|win32|linux/;

const missing = [];
for (const [path, pkg] of Object.entries(lock.packages)) {
  for (const dep of Object.keys(pkg.optionalDependencies ?? {})) {
    if (PLATFORM.test(dep) && !present.has(dep)) missing.push(`${path || "(root)"} → ${dep}`);
  }
}

if (missing.length > 0) {
  console.error(`package-lock.json is missing ${missing.length} platform build(s):\n  ${missing.slice(0, 20).join("\n  ")}`);
  console.error("Regenerate it from nothing: rm -rf node_modules */*/node_modules package-lock.json && npm install");
  process.exit(1);
}
console.log("package-lock.json carries every platform build.");
