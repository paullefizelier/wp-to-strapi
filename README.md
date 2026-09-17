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
- Media library migration with automatic URL rewriting in HTML content — size variants
  (`photo-1024x768.jpg`), `-scaled` originals and image-CDN rewrites (Jetpack/Photon) all
  resolve back to the right attachment, and `srcset` is rebuilt from Strapi's own formats.
- **Migration report** — every page built with a page builder, every unexpanded shortcode and
  every media URL still pointing at WordPress is flagged as a warning during the run.
- **Idempotent** — writes a `wpId` on each entry so re-runs update instead of duplicating.
- **Resumable** — persisted state file survives crashes.
- **Resilient** — rate limiting, 5xx and dropped sockets are retried with exponential backoff
  (honouring `Retry-After`); anything the server refuses deliberately is not.
- **Previewable** — see the exact payloads before writing a single entry.
- Typed event bus (`MigratorEvent`) — every front-end subscribes to the same stream.
- **Fully configurable field mapping** — any WordPress path onto any Strapi field, with
  transforms, plus constants applied to every import.

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

1. **Media and taxonomies first.** The migrator pages through `/wp-json/wp/v2/media` (with WP's internal
   `inherit` status — the media endpoint rejects `publish`), downloads each binary from
   `source_url`, and uploads to Strapi's upload plugin. The `wpMediaId → strapiFileId` mapping
   is persisted, along with the responsive formats Strapi generated.
2. **Articles, pages & custom types.** For each entry:
   - HTML `content` is scanned and every known WP media URL is rewritten to its new Strapi URL —
     `src`, `href`, `srcset`, CSS `url(...)` and bare occurrences in text.
   - `featured_media` is attached as the `cover` field.
   - Categories and tags are attached by `documentId` when those steps ran.
   - The content is audited, and anything the REST API could not hand over is reported.
   - A lookup on `wpId` decides between `create` and `update` (upsert).
3. **Events.** Every step emits a typed `MigratorEvent`. The CLI prints them; both the Nuxt UI and the Strapi plugin stream them as Server-Sent Events for live progress.

## Field mapping

Every field written to Strapi is configuration, not code. A mapping is a list of rows; each
row names a Strapi field and where its value comes from — a path into the WordPress entity, or
a constant applied to every entry.

```jsonc
{
  // Applied to every kind. Rows in a kind below override these.
  "common": [
    { "target": "locale", "value": "fr" },
    { "target": "importSource", "value": "wordpress" }
  ],
  "post": [
    { "target": "titre", "source": "title.rendered", "transforms": ["decodeEntities", "trim"] },
    { "target": "corps", "source": "$content", "transforms": ["rewriteMedia"] },
    { "target": "resume", "source": "content.rendered", "transforms": ["stripHtml", "truncate:280"] },
    { "target": "seoTitle", "source": "meta._yoast_wpseo_title" },
    { "target": "sousTitre", "source": "acf.subtitle" },
    { "target": "couverture", "source": "featured_media", "transforms": ["mediaId"], "omitEmpty": true },
    { "target": "rubriques", "source": "categories", "transforms": ["terms:categories"] },
    { "target": "wpId", "source": "id" }
  ]
}
```

Kinds: `common`, `post`, `page`, `category`, `tag`, and `custom` keyed by REST base. **A kind you
configure replaces the built-in mapping entirely** — what you see is what gets written. Kinds
you leave out keep the built-in behaviour, so an empty mapping changes nothing.

**Sources** are dot paths into the REST payload (`title.rendered`, `acf.subtitle`,
`meta._yoast_wpseo_title`, `categories.0`), plus four the engine computes:

| Virtual source | Value |
|----------------|-------|
| `$content` | the rendered body, after the page-builder fallback |
| `$publishedAt` | the GMT publish date, or `null` for anything not published |
| `$link` | the entry's public WordPress URL |
| `$status` | `publish`, `draft`, `future`… |

**Transforms** run left to right, and take an argument after a colon:

| | |
|---|---|
| Text | `decodeEntities` `stripHtml` `trim` `lower` `upper` `slugify` `truncate:280` `join:, ` |
| References | `rewriteMedia` `mediaId` `mediaUrl` `terms:categories` `terms:tags` |
| Values | `date` `number` `boolean` `string` `first` `default:fallback` `map:actualites=pro,*=public` |

**Select / enumeration fields** take a constant like any other target:
`{ "target": "audience", "value": "professionnels" }` on the `post` rows sets it on every
imported article, or put it in `common` to set it everywhere. The value must be one of the
enumeration's declared values — discovery lists them next to the field name, and the UI offers
them in the value box. Constants typed in a UI arrive as strings, so a number or boolean field
needs the matching transform: `{ "target": "priorite", "value": "3", "transforms": ["number"] }`.

`map:` is what turns WordPress values into Strapi enumeration values —
`{ "target": "audience", "source": "acf.kind", "transforms": ["map:actualites=professionnels,*=grand-public"] }`,
with `*` as the fallback.

`omitEmpty: true` drops the field instead of writing an empty value. A mapping is validated
before the run starts: an unknown transform, a row with neither a source nor a value, or a
mapping that never writes the **correlation field** aborts it rather than importing something
wrong. That last one matters — the correlation field (`wpId` by default, `strapi.correlationField`
to rename it) is what makes a re-run update instead of duplicating, so dropping it would
silently turn every re-import into a second copy of the site.

### Preview before you import

A mapping is only trustworthy if you can see its output before pointing it at three thousand
posts. Preview runs the real pipeline — page-builder fallback, media rewriting, relations,
transforms — on a couple of entries and hands back the exact payloads, writing nothing.

```bash
npm run cli -- preview --kind posts --limit 2
```

```
── posts #1 (welcome) → api::post.post
{
  "locale": "fr",
  "titre": "Welcome",
  "audience": "grand-public",
  "wpId": 1
}
  ⚠ No media migrated yet — media URLs and cover fields stay unresolved in this preview.
```

Both UIs have the same thing behind an **Aperçu / Preview** button next to the mapping editor.

### Picking fields from both sides

Once the WordPress and Strapi connections are set, both UIs read the real field lists: the WP
side by sampling an entry (with `context=edit` when credentials are set, which is what exposes
`meta` and ACF), the Strapi side from the content-type schema. The plugin runs in-process and
always gets the true schema; over HTTP, Strapi v5 only exposes schemas to the admin API, so the
CLI/Nuxt path falls back to inferring the shape from an existing entry and says so.

## What actually comes across

The engine reads `content.rendered` from `/wp-json/wp/v2/`. That single fact decides most of
what follows — anything WordPress keeps outside the rendered post content is invisible to it.

| Source site | Result |
|-------------|--------|
| **Classic editor** | Clean migration. |
| **Gutenberg** | Content migrates well, but the HTML keeps `wp-block-*` classes and relies on WP's block stylesheet and `theme.json` variables. Budget for a stylesheet on the Strapi front-end, or parse the blocks into a dynamic zone. |
| **FSE (full-site editing)** | Page and post *content* migrates, through the same public-page fallback when the REST body comes back empty. Templates, template parts, navigation, global styles and patterns (`wp_template`, `wp_template_part`, `wp_navigation`, `wp_global_styles`) do **not** — header, footer and site layout are rebuilt on the front-end side. |
| **Elementor / Divi / WPBakery** | The layout lives in post meta (`_elementor_data` and friends) and is rendered by the builder's own frontend hooks, so the REST API returns an empty or flattened body. The migrator falls back to the **public page** and keeps its text and images (see below). The layout itself is not migrated. |

### The public-page fallback

When `content.rendered` is empty or carries builder markup, the migrator fetches the page's
public URL and strips it down to **text and images**: headings, paragraphs, lists, links,
tables and `<img>`. Builder wrappers, classes, inline styles, scripts, navigation, comments and
site chrome are all dropped, and URLs are absolutised so the media rewriter can map them onto
their Strapi uploads. Embeds (iframe, video, audio) are dropped and counted in the run log.

It only replaces the REST body when it recovers *more* text, so Gutenberg and classic content
are never touched. Turn it off with `HTML_FALLBACK=false` (CLI) or the toggle in the UI.

### Optional content types

| What | How to turn it on |
|------|-------------------|
| **Categories / tags** | Set `STRAPI_CATEGORY_UID` / `STRAPI_TAG_UID` (or the UID fields in the UI). Terms migrate before posts and are related by `documentId` on the `categories` / `tags` fields. Left empty, they are skipped entirely. |
| **Drafts, pending, scheduled, private** | `WP_STATUSES=publish,draft,pending,future,private`. Needs WordPress credentials; non-published entries land as Strapi drafts (`publishedAt: null`). |
| **Custom post types** | `WP_CUSTOM_TYPES=portfolio:api::project.project,event:api::event.event\|evenements` — `restBase:uid`, with an optional `\|pluralPath`. |

Still not migrated: authors, menus, ACF fields, comments, SEO metadata and redirects. See
[Extending](#extending) for where to hook each of them in.

Media URLs that survive the rewrite — files hosted on another domain, or attachments missing
from the library — are listed as warnings so they can be dealt with *before* the WordPress
install is switched off.

### The adapter pattern

The engine depends on an abstract `StrapiAdapter` interface. Two implementations ship in the monorepo:

- `StrapiClient` (in core) — talks to Strapi over HTTP. Used by the CLI and Nuxt front-ends.
- `NativeStrapiAdapter` (in `@wp-to-strapi/strapi-adapter`) — talks to `strapi.documents()` + the upload service directly, in-process. Used by the Strapi plugin.

Want to target a different destination (Payload, Sanity, Ghost…)? Implement `StrapiAdapter` and reuse everything else.

## Extending

- **ACF fields.** Enable the *ACF to REST API* plugin, then map `acf.<field>` onto a Strapi field — no code needed.
- **External media providers.** Strapi v5 handles this natively — configure the provider in your Strapi app; the plugin and CLI/UI flows both route uploads through it.

## First-time setup

If you just cloned the repo, follow [SETUP.md](./SETUP.md) — it walks you through the npm scope replacement, install, build, and first publish in order.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Bug reports and PRs are very welcome.

## Publishing

See [PUBLISHING.md](./PUBLISHING.md) for the Changesets-based release flow and the one-time npm setup.

## License

MIT — see [LICENSE](./LICENSE).
