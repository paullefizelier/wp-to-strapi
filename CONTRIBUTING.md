# Contributing to wp-to-strapi

Thanks for considering a contribution. This is a small OSS project — issues, PRs, and design discussions are all welcome.

## Project layout

```
packages/
  core/             # migration engine (clients, orchestrator, events) — no UI/CLI/Strapi coupling
  strapi-adapter/   # native adapter (strapi.documents() + upload service) used by the plugin
apps/
  cli/              # command-line front-end
  web/              # Nuxt 3 front-end
  strapi-plugin/    # Strapi v5 plugin (admin panel integration)
```

Every layer depends only on what's below: the core knows nothing about Nitro, Strapi, or `process.argv`. Each front-end consumes `@wp-to-strapi/core` and provides its own `StrapiAdapter` implementation.

## Setup

```bash
npm install                 # installs workspaces
npm run typecheck           # verifies core + CLI
npm run dev:web             # runs the Nuxt app on :3000
npm run cli -- migrate      # runs the CLI (reads .env in apps/cli)
```

Node 20+ is required.

## Development guidelines

- **Keep the core framework-agnostic.** If you need something from `process.env` or a Nuxt runtime, put it in the consumer, not in `packages/core`.
- **Prefer events over console.log.** The Migrator emits typed events; both the CLI and the web UI subscribe.
- **Idempotency first.** Any new entity migration must write a `wpId` (or equivalent stable key) and upsert on it, so re-runs are safe.
- **Type everything.** `strict: true` is on. New code must typecheck with `noUncheckedIndexedAccess`.

## Running against a local WordPress + Strapi

The easiest setup for contributors:

1. Spin up a local WordPress (e.g. `wp-env` or LocalWP) and create some posts/pages/media.
2. Create an Application Password in WP: Users → Profile → Application Passwords.
3. Spin up a Strapi v5 project, create `Post` and `Page` content types as described in the README, including a `wpId` number field with unique constraint.
4. Generate a Full-access API token in Strapi and put it in `apps/cli/.env` (or paste it into the web UI).

## Opening a PR

- Keep PRs focused — one concern per PR.
- Add a note in the PR description if you touched the public API of `@wp-to-strapi/core`.
- Make sure `npm run typecheck` passes.
- New features land on `main` through a PR with at least one approving review.

## Reporting a vulnerability

Please email the maintainers rather than opening a public issue. We'll respond within a few days.
