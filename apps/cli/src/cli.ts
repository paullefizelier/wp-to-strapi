#!/usr/bin/env node
import "dotenv/config";
import { buildConfig, Migrator, type Kind, type MigrateOptions, type MigratorEvent } from "@paullefizelier/wp-to-strapi-core";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
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
    },
    concurrency: process.env.CONCURRENCY ? Number(process.env.CONCURRENCY) : undefined,
    pageSize: process.env.PAGE_SIZE ? Number(process.env.PAGE_SIZE) : undefined,
    stateFile: process.env.STATE_FILE,
    dryRun: (process.env.DRY_RUN || "false").toLowerCase() === "true",
  });
}

function parseArgs(argv: string[]): MigrateOptions {
  const only: Kind[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--only") {
      const next = argv[i + 1];
      if (!next) throw new Error("--only requires a value");
      for (const v of next.split(",")) {
        if (v === "media" || v === "posts" || v === "pages") only.push(v);
        else throw new Error(`Unknown --only value: ${v}`);
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
        console.log(`  media: ${e.summary.media}`);
        console.log(`  posts: ${e.summary.posts}`);
        console.log(`  pages: ${e.summary.pages}`);
        break;
    }
  });
}

async function main(): Promise<void> {
  const [, , command = "migrate", ...rest] = process.argv;
  if (command !== "migrate") {
    console.error(`Unknown command: ${command}. Usage: wp-to-strapi migrate [--only media,posts,pages]`);
    process.exit(1);
  }
  const opts = parseArgs(rest);
  const cfg = loadConfigFromEnv();
  const migrator = new Migrator(cfg);
  wireLogging(migrator);
  await migrator.run(opts);
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
