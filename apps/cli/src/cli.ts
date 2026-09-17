#!/usr/bin/env node
import "dotenv/config";
import { readFileSync } from "node:fs";
import {
  buildConfig,
  Migrator,
  type CustomTypeConfig,
  type Kind,
  type MigrateOptions,
  type MappingSet,
  type MigratorEvent,
} from "@paullefizelier/wp-to-strapi-core";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function splitList(value: string | undefined): string[] | undefined {
  const items = (value ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

/**
 * WP_CUSTOM_TYPES="portfolio:api::project.project,event:api::event.event|evenements"
 *
 * `restBase:uid`, one per comma, with an optional `|pluralPath` when Strapi's REST path is
 * not the naive pluralisation of the UID. Split on the first colon only — UIDs contain `::`.
 */
function parseCustomTypes(value: string | undefined): CustomTypeConfig[] {
  return (splitList(value) ?? []).map((entry) => {
    const colon = entry.indexOf(":");
    const restBase = colon > 0 ? entry.slice(0, colon).trim() : "";
    const [uid = "", pluralPath] = entry
      .slice(colon + 1)
      .split("|")
      .map((part) => part.trim());
    if (!restBase || !uid) {
      throw new Error(
        `Invalid WP_CUSTOM_TYPES entry: "${entry}" (expected restBase:uid[|pluralPath])`,
      );
    }
    return pluralPath ? { restBase, uid, pluralPath } : { restBase, uid };
  });
}

/** MAPPING_FILE=./mapping.json — the same JSON shape both UIs edit. */
function loadMapping(path: string | undefined): MappingSet | undefined {
  if (!path) return undefined;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`Cannot read MAPPING_FILE "${path}": ${(err as Error).message}`);
  }
  try {
    return JSON.parse(raw) as MappingSet;
  } catch (err) {
    throw new Error(`MAPPING_FILE "${path}" is not valid JSON: ${(err as Error).message}`);
  }
}

function loadConfigFromEnv() {
  return buildConfig({
    wp: {
      baseUrl: required("WP_BASE_URL"),
      username: process.env.WP_USERNAME,
      appPassword: process.env.WP_APP_PASSWORD,
    },
    strapi: {
      baseUrl: required("STRAPI_BASE_URL"),
      token: required("STRAPI_API_TOKEN"),
      postUid: process.env.STRAPI_POST_UID,
      pageUid: process.env.STRAPI_PAGE_UID,
      categoryUid: process.env.STRAPI_CATEGORY_UID,
      tagUid: process.env.STRAPI_TAG_UID,
      categoryPluralPath: process.env.STRAPI_CATEGORY_PLURAL,
      tagPluralPath: process.env.STRAPI_TAG_PLURAL,
    },
    concurrency: process.env.CONCURRENCY ? Number(process.env.CONCURRENCY) : undefined,
    retries: process.env.RETRIES ? Number(process.env.RETRIES) : undefined,
    pageSize: process.env.PAGE_SIZE ? Number(process.env.PAGE_SIZE) : undefined,
    stateFile: process.env.STATE_FILE,
    dryRun: (process.env.DRY_RUN || "false").toLowerCase() === "true",
    htmlFallback: (process.env.HTML_FALLBACK || "true").toLowerCase() !== "false",
    statuses: splitList(process.env.WP_STATUSES) ?? undefined,
    customTypes: parseCustomTypes(process.env.WP_CUSTOM_TYPES),
    mapping: loadMapping(process.env.MAPPING_FILE),
  });
}

const KINDS: Kind[] = ["media", "categories", "tags", "posts", "pages", "custom"];

interface PreviewArgs {
  kind: "posts" | "pages" | "categories" | "tags" | "custom";
  restBase?: string;
  limit: number;
}

function parsePreviewArgs(argv: string[]): PreviewArgs {
  const args: PreviewArgs = { kind: "posts", limit: 3 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--kind" && next) {
      if (!["posts", "pages", "categories", "tags", "custom"].includes(next)) {
        throw new Error(`Unknown --kind value: ${next}`);
      }
      args.kind = next as PreviewArgs["kind"];
      i += 1;
    } else if (arg === "--rest-base" && next) {
      args.restBase = next;
      i += 1;
    } else if (arg === "--limit" && next) {
      args.limit = Number(next);
      i += 1;
    }
  }
  return args;
}

function parseArgs(argv: string[]): MigrateOptions {
  const only: Kind[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--only") {
      const next = argv[i + 1];
      if (!next) throw new Error("--only requires a value");
      for (const v of next.split(",")) {
        if (KINDS.includes(v as Kind)) only.push(v as Kind);
        else throw new Error(`Unknown --only value: ${v} (expected one of ${KINDS.join(", ")})`);
      }
      i += 1;
    }
  }
  return only.length > 0 ? { only } : {};
}

function wireLogging(m: Migrator): void {
  m.on("event", (e: MigratorEvent) => {
    switch (e.type) {
      case "section-start":
        console.log(`\n=== Migrating ${e.kind} ===`);
        break;
      case "section-end":
        console.log(`${e.kind}: ${e.total} item(s) seen.`);
        break;
      case "item-ok":
        console.log(`  ✓ ${e.kind} #${e.wpId} ${e.detail}`);
        break;
      case "item-skip":
        console.log(`  – ${e.kind} #${e.wpId} skipped (${e.reason})`);
        break;
      case "item-error":
        console.warn(`  ✗ ${e.kind} #${e.wpId}: ${e.message}`);
        break;
      case "log":
        if (e.level === "error") console.error(`  ! ${e.message}`);
        else if (e.level === "warn") console.warn(`  ⚠ ${e.message}`);
        else console.log(`  ${e.message}`);
        break;
      case "run-end":
        console.log(`\n=== Summary ===`);
        for (const [kind, n] of Object.entries(e.summary)) console.log(`  ${kind}: ${n}`);
        break;
    }
  });
}

async function main(): Promise<void> {
  const [, , command = "migrate", ...rest] = process.argv;

  if (command === "preview") {
    const { kind, restBase, limit } = parsePreviewArgs(rest);
    const migrator = new Migrator(loadConfigFromEnv());
    const items = await migrator.preview({ kind, restBase, limit });
    for (const item of items) {
      console.log(`\n── ${item.kind} #${item.wpId} (${item.slug}) → ${item.uid}`);
      console.log(JSON.stringify(item.data, null, 2));
      for (const w of item.warnings) console.warn(`  ⚠ ${w}`);
    }
    if (items.length === 0) console.log("Nothing to preview.");
    return;
  }

  if (command !== "migrate") {
    console.error(
      `Unknown command: ${command}.\n` +
        `Usage:\n` +
        `  wp-to-strapi migrate [--only media,categories,tags,posts,pages,custom]\n` +
        `  wp-to-strapi preview [--kind posts|pages|categories|tags|custom] [--rest-base <base>] [--limit 3]`,
    );
    process.exit(1);
  }

  const cfg = loadConfigFromEnv();
  const migrator = new Migrator(cfg);
  wireLogging(migrator);
  await migrator.run(parseArgs(rest));
}

main().catch((err: unknown) => {
  console.error(`Migration failed: ${String(err)}`);
  process.exit(1);
});
