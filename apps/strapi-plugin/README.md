# strapi-plugin-wp-import

Import WordPress content (posts, pages, media) into Strapi v5, straight from the admin panel. Uses `strapi.documents()` and the Strapi upload service — no API token needed, and your configured upload provider (S3, Cloudinary, local…) is used automatically.

## Install

```bash
npm install strapi-plugin-wp-import
```

Enable it in `config/plugins.ts`:

```ts
export default {
  "wp-import": {
    enabled: true,
    config: {
      // Optional overrides:
      postUid: "api::article.article",
      pageUid: "api::page.page",
      stateFile: "./.wp-import-state.json",
    },
  },
};
```

Rebuild the admin: `npm run build && npm run develop`.

## Content-type requirements

Your `post` / `page` content-types must expose these fields for the mapping to work out of the box:

| Field     | Type                         | Notes                             |
| --------- | ---------------------------- | --------------------------------- |
| `title`   | String                       |                                   |
| `slug`    | UID                          | unique                            |
| `content` | Rich text (Markdown or HTML) |                                   |
| `excerpt` | Text                         | optional                          |
| `cover`   | Media (single)               | receives WP featured image        |
| `wpId`    | Number (integer), **unique** | correlation key — upsert pivot    |

Override the UIDs from the admin UI or the `config` key above.

## How it works

The plugin menu link opens a dashboard where you:

1. Paste your WordPress URL + application password (persisted in Strapi's core store).
2. Pick which kinds to migrate (media, posts, pages).
3. Click **Start migration**.

Progress streams live via SSE on `/wp-import/events`. The migration engine itself is shared with the CLI and Nuxt front-ends — see [`@wp-to-strapi/core`](../../packages/core).

## Routes

All routes are mounted under `/wp-import` and gated by the admin auth strategy.

| Method | Path        | Purpose                                   |
| ------ | ----------- | ----------------------------------------- |
| GET    | `/settings` | Read stored settings                      |
| PUT    | `/settings` | Update settings                           |
| POST   | `/test-wp`  | Probe the WordPress REST API              |
| POST   | `/start`    | Start a migration run                     |
| GET    | `/status`   | Current run status (if any)               |
| GET    | `/events`   | SSE stream of `MigratorEvent`s            |

## Development

```bash
npm run watch:link      # yalc-links into a host Strapi project
npm run build           # production build (dist/)
npm run typecheck       # admin + server
```
