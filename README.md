# wp-to-strapi

> Open-source WordPress → Strapi v5 migration toolkit — library, CLI, Nuxt UI, **and a native Strapi plugin**.

[![CI](https://github.com/your-org/wp-to-strapi/actions/workflows/ci.yml/badge.svg)](https://github.com/your-org/wp-to-strapi/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Migrate your **posts**, **pages** and **media library** from WordPress (REST API) to Strapi v5 (Document Service API). Idempotent re-runs, automatic image URL rewriting, live progress. Pick the front-end that fits your context.

## Three front-ends, one engine

| Front-end | When to pick it | Key trait |
|-----------|-----------------|-----------|
| **[Strapi plugin](./apps/strapi-plugin)** | You already have a Strapi v5 project and want the import UI inside the admin panel | No API token, respects your configured upload provider (S3, Cloudinary…) automatically |
| **[Nuxt UI](./apps/web)** | Standalone migration, Strapi instance runs elsewhere or behind a firewall | Runs anywhere, local-first, credentials stay in your browser |
| **[CLI](./apps/cli)** | CI/CD pipelines, scripted migrations, servers without a UI | Scriptable, `.env` configuration, logs to stdout |

All three consume the same core engine, emit the same typed `MigratorEvent`s, and write the same resumable state file — switch between them mid-migration if you need to.

## Features

- WordPress REST API source (`/wp-json/wp/v2/`) with pagination.
- Strapi v5 destination via the Document Service API (entries addressed by `documentId`).
- Media library migration with automatic URL rewriting in HTML content.
- **Idempotent** — writes a `wpId` on each entry so re-runs update instead of duplicating.
- **Resumable** — persisted state file survives crashes.
- Typed event bus (`MigratorEvent`) — every front-end subscribes to the same stream.

## Project layout

```
wp-to-strapi/
├── packages/
│   ├── core/             @wp-to-strapi/core            engine (clients, orchestrator, events)
│   └── strapi-adapter/   @wp-to-strapi/strapi-adapter  native adapter (strapi.documents() + upload svc)
└── apps/
    ├── cli/              @wp-to-strapi/cli             CLI front-end
    ├── web/              @wp-to-strapi/web             Nuxt 3 UI
    └── strapi-plugin/    strapi-plugin-wp-import       Strapi v5 plugin
```

## Quick start — Strapi plugin

```bash
cd your-strapi-app
npm install strapi-plugin-wp-import
```

Enable it in `config/plugins.ts` and rebuild the admin. A new "WP Import" entry appears in the side nav — configure your WordPress URL, pick what to migrate, click Start. See [`apps/strapi-plugin/README.md`](./apps/strapi-plugin/README.md) for details.

## Quick start — Nuxt UI

```bash
git clone https://github.com/your-org/wp-to-strapi
cd wp-to-strapi
npm install
npm run dev:web        # Nuxt dev server on http://localhost:3000
```

Credentials live in `localStorage` in your browser — they only ever travel to your local Nitro server.

## Quick start — CLI

```bash
cd apps/cli
cp .env.example .env
# edit .env
npm run migrate                      # full migration
npm run migrate -- --only media      # step-by-step
DRY_RUN=true npm run migrate         # no writes to Strapi
```

## Strapi content-type setup

Create two content-types (default UIDs `api::post.post` and `api::page.page` — override from any front-end if yours differ):

| Field     | Type                         | Notes                                        |
| --------- | ---------------------------- | -------------------------------------------- |
| `title`   | String                       | required                                     |
| `slug`    | UID                          | from `title`, unique                         |
| `content` | Rich text (Markdown or HTML) | receives the WP-rendered HTML                |
| `excerpt` | Text                         | optional                                     |
| `cover`   | Media (single)               | receives the WP featured image               |
| `wpId`    | Number (integer), **unique** | correlation key — makes re-imports idempotent |

CLI and Nuxt UI need a **Full-access API token** in Strapi. The plugin doesn't — it uses `strapi.documents()` in-process.

## How it works

1. **Media first.** The migrator pages through `/wp-json/wp/v2/media`, downloads each binary from `source_url`, and uploads to Strapi's upload plugin. The `wpMediaId → strapiFileId` mapping is persisted.
2. **Articles & pages.** For each entry:
   - HTML `content` is scanned and every known WP media URL is rewritten to its new Strapi URL.
   - `featured_media` is attached as the `cover` field.
   - A lookup on `wpId` decides between `create` and `update` (upsert).
3. **Events.** Every step emits a typed `MigratorEvent`. The CLI prints them; both the Nuxt UI and the Strapi plugin stream them as Server-Sent Events for live progress.

### The adapter pattern

The engine depends on an abstract `StrapiAdapter` interface. Two implementations ship in the monorepo:

- `StrapiClient` (in core) — talks to Strapi over HTTP. Used by the CLI and Nuxt front-ends.
- `NativeStrapiAdapter` (in `@wp-to-strapi/strapi-adapter`) — talks to `strapi.documents()` + the upload service directly, in-process. Used by the Strapi plugin.

Want to target a different destination (Payload, Sanity, Ghost…)? Implement `StrapiAdapter` and reuse everything else.

## Extending

- **Categories / tags.** Add a `category` content-type, migrate them before posts, keep a `wpCategoryId → strapiDocumentId` map in the state store, then relate posts.
- **Custom Post Types.** Copy the `migratePosts` path (`/wp-json/wp/v2/{cpt}`) and target the corresponding Strapi UID.
- **ACF fields.** Enable the *ACF to REST API* plugin and read `p.acf` inside `buildEntryData`.
- **External media providers.** Strapi v5 handles this natively — configure the provider in your Strapi app; the plugin and CLI/UI flows both route uploads through it.

## First-time setup

If you just cloned the repo, follow [SETUP.md](./SETUP.md) — it walks you through the npm scope replacement, install, build, and first publish in order.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Bug reports and PRs are very welcome.

## Publishing

See [PUBLISHING.md](./PUBLISHING.md) for the Changesets-based release flow and the one-time npm setup.

## License

MIT — see [LICENSE](./LICENSE).
