/**
 * Import the built entry points the way Node actually does.
 *
 * Vitest and Vite paper over CommonJS interop, so a broken `import { x } from "cjs-pkg"`
 * passes every unit test and then throws the first time the CLI starts. This catches it.
 */
import assert from "node:assert/strict";

const main = await import("../dist/index.js");
const browser = await import("../dist/mapping-entry.js");

assert.equal(typeof main.Migrator, "function", "main entry must export Migrator");
assert.equal(typeof main.buildConfig, "function", "main entry must export buildConfig");
assert.equal(main.decodeEntities("Caf&#233;"), "Café", "entity decoding must work at runtime");
assert.equal(typeof browser.applyMapping, "function", "mapping entry must export applyMapping");
assert.ok(browser.defaultEntryMapping().length > 0, "mapping entry must expose the defaults");

// The mapping entry is imported by browser code: it must stay free of Node built-ins.
const source = await import("node:fs/promises").then((fs) =>
  fs.readFile(new URL("../dist/mapping-entry.js", import.meta.url), "utf8"),
);
assert.ok(!/from "node:/.test(source), "mapping entry must not import node: built-ins");

console.log("esm smoke ok");
