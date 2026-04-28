# Publishing to npm

Three packages ship to npm, linked together via [Changesets](https://github.com/changesets/changesets):

| Package                                        | npm name                                        | Audience                              |
| ---------------------------------------------- | ----------------------------------------------- | ------------------------------------- |
| `packages/core`                                | `@YOUR-NPM-USERNAME/wp-to-strapi-core`          | Anyone building on the engine         |
| `packages/strapi-adapter`                      | `@YOUR-NPM-USERNAME/wp-to-strapi-adapter`       | Strapi plugin authors (peer on v5)    |
| `apps/strapi-plugin`                           | `strapi-plugin-wp-import` *(unscoped)*          | Strapi users — install from marketplace |

The CLI (`@YOUR-NPM-USERNAME/wp-to-strapi-cli`) is publishable too but opt-in — drop the `private: true` when you want it on npm. The Nuxt app (`@YOUR-NPM-USERNAME/wp-to-strapi-web`) stays `private: true` forever; it's deployed, not distributed.

## One-time setup

### 1. Replace the scope placeholder

Every `@YOUR-NPM-USERNAME/...` reference needs your real npm username (or org). One command does it all:

```bash
# macOS
grep -rl 'YOUR-NPM-USERNAME' . --exclude-dir=node_modules --exclude-dir=.git | xargs sed -i '' 's/YOUR-NPM-USERNAME/your-actual-username/g'

# Linux
grep -rl 'YOUR-NPM-USERNAME' . --exclude-dir=node_modules --exclude-dir=.git | xargs sed -i 's/YOUR-NPM-USERNAME/your-actual-username/g'
```

Verify nothing slipped through: `grep -r YOUR-NPM-USERNAME . --exclude-dir=node_modules --exclude-dir=.git` should return nothing.

### 2. Reserve the npm name

The Strapi plugin is published under an unscoped name, so it has to be globally unique on npm. Check availability first:

```bash
npm view strapi-plugin-wp-import
# "npm error 404" means the name is available
```

If someone already owns it, rename in `apps/strapi-plugin/package.json` and in the `linked` list of `.changeset/config.json`.

### 3. Create an npm automation token

npm → Account → Access tokens → **Generate new token** → *Automation* (classic). Copy the token.

On GitHub, go to the repo → Settings → Secrets and variables → Actions → **New repository secret**:
- Name: `NPM_TOKEN`
- Value: the token from npm

### 4. Enable 2FA for publishing

Recommended on npm. Set it to "auth only" (not "auth and writes"), otherwise CI can't publish.

## Release workflow

### With GitHub Actions (recommended)

1. You merge PRs to `main` that include a changeset (`npm run changeset` to add one).
2. The `release.yml` workflow sees unreleased changesets and opens a "chore: release" PR that bumps versions and regenerates the changelog.
3. You review and merge that PR.
4. The same workflow runs again, detects that everything is already versioned, and calls `npm run release` — which builds and publishes every changed package to npm in the correct dependency order.

### Manual first release

If you want to publish the first `0.1.0` by hand before wiring CI:

```bash
npm install
npm run build                    # builds core + adapter + cli
cd apps/strapi-plugin && npm run build && cd ../..   # builds the plugin

# Publish in dependency order:
npm publish -w @YOUR-NPM-USERNAME/wp-to-strapi-core
npm publish -w @YOUR-NPM-USERNAME/wp-to-strapi-adapter
npm publish -w strapi-plugin-wp-import
```

Once published, delete `.changeset/initial-release.md` so it doesn't re-fire in CI.

## Adding a changeset

Any PR that ships a change should include one. From the repo root:

```bash
npm run changeset
```

The CLI walks you through:
- which packages changed
- semver bump (patch / minor / major)
- a one-line summary for the changelog

This writes a markdown file in `.changeset/`. Commit it with your PR.

Because the three packages are **linked** in `.changeset/config.json`, they always bump together — this keeps `strapi-plugin-wp-import@X.Y.Z` always depending on matching `wp-to-strapi-core@X.Y.Z` and `wp-to-strapi-adapter@X.Y.Z` versions, no resolution surprises.

## Troubleshooting

**`402 Payment Required` on publish.** Scoped packages default to private. Both scoped packages already have `publishConfig.access: "public"` — if you see this error, someone removed it.

**Plugin ends up without `core`/`adapter` in the tarball.** That's fine — they're regular `dependencies`, npm will install them when a user installs the plugin. Only bundle them if you really want a single package (and update the plugin's `package.json` to drop the deps).

**Nuxt app shows up in the publish plan.** It shouldn't — `private: true` in its `package.json` and it's also in the `ignore` array of the changeset config. Both guards must stay in place.

**`strapi-plugin verify` warnings.** The Strapi plugin SDK has a verifier that checks the package shape. Run it locally (`cd apps/strapi-plugin && npm run verify`) before your first publish. Install the plugin in a fresh Strapi app (`npm install ../path/to/strapi-plugin-wp-import`) to smoke-test before pushing to npm.
