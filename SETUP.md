# Setup checklist

End-to-end walkthrough from a fresh clone to a fully working dev environment, ready to publish. Pick your package manager (pnpm or npm — both work).

## 0. Pré-requis

- [ ] Node 20+ (`node -v`)
- [ ] pnpm ≥ 9 (`pnpm -v`) **ou** npm ≥ 10
- [ ] Compte npm créé et connecté localement (`pnpm login` / `npm login`)
- [ ] Compte GitHub avec un repo créé pour ce projet

## 1. Remplacer le placeholder de scope (à faire **avant** d'installer)

Le repo utilise `YOUR-NPM-USERNAME` partout comme sentinelle. Tant qu'il n'est pas remplacé, `pnpm install` ne sait pas que `@YOUR-NPM-USERNAME/wp-to-strapi-core` vit dans `packages/core` et tente de le télécharger depuis npm → **404**.

Depuis la racine du repo, choisis ton scope npm puis exécute :

```bash
# macOS
grep -rl 'YOUR-NPM-USERNAME' . \
  --exclude-dir=node_modules --exclude-dir=.git \
  --exclude-dir=dist --exclude-dir=.nuxt --exclude-dir=.output \
  | xargs sed -i '' 's/YOUR-NPM-USERNAME/paul-lefizelier/g'

# Linux
grep -rl 'YOUR-NPM-USERNAME' . \
  --exclude-dir=node_modules --exclude-dir=.git \
  --exclude-dir=dist --exclude-dir=.nuxt --exclude-dir=.output \
  | xargs sed -i 's/YOUR-NPM-USERNAME/paul-lefizelier/g'
```

Vérifie qu'il n'en reste plus :

```bash
grep -r YOUR-NPM-USERNAME . --exclude-dir=node_modules --exclude-dir=.git
# (no output)
```

Si tu vois encore des occurrences dans `node_modules/.cache/` ou similaire, c'est OK — elles partent au prochain install propre.

## 2. Réserver les noms npm

```bash
npm view @paul-lefizelier/wp-to-strapi-core      # E404 = libre
npm view @paul-lefizelier/wp-to-strapi-adapter   # E404 = libre
npm view strapi-plugin-wp-import                  # critique (unscoped)
```

Le plugin est unscoped pour matcher la convention Strapi, donc il faut que le nom soit globalement libre. Si quelqu'un l'a déjà :

1. Renomme dans `apps/strapi-plugin/package.json`
2. Mets à jour `.changeset/config.json` (clé `linked`)
3. Mets à jour les références dans `PUBLISHING.md` et `README.md`

## 3. Installer

```bash
# Toujours depuis la racine, jamais depuis apps/web
pnpm install
# ou
npm install
```

Le `pnpm-workspace.yaml` à la racine indique à pnpm où sont les packages. Sans lui, pnpm traite chaque `package.json` comme indépendant et plante au moindre cross-workspace dep.

## 4. Vérifier que tout typecheck / build

```bash
pnpm typecheck   # core + adapter + cli
pnpm build       # idem
```

Le Nuxt n'a pas de typecheck dans cette commande (il a son propre `nuxt typecheck` qui tourne après `nuxt prepare`).

## 5. Démarrer le Nuxt en dev

```bash
pnpm dev:web
```

→ http://localhost:3000

## 6. Tester le Strapi plugin localement (optionnel mais recommandé avant publish)

```bash
# Build le plugin
pnpm -F strapi-plugin-wp-import build
pnpm -F strapi-plugin-wp-import verify

# Dans un répertoire séparé, monter un Strapi de test
npx create-strapi-app@latest test-strapi --quickstart --no-run
cd test-strapi

# Installer le plugin via lien local (le SDK Strapi a un helper)
cd ../wp-to-strapi/apps/strapi-plugin
pnpm watch:link              # met à jour test-strapi à chaque rebuild
```

Active le plugin dans `test-strapi/config/plugins.ts` :

```ts
export default {
  "wp-import": { enabled: true },
};
```

Puis `npm run develop` dans `test-strapi`. L'item "WP Import" apparaît dans la nav admin.

## 7. Premier publish sur npm (manuel, une seule fois)

```bash
pnpm install
pnpm build
pnpm -F strapi-plugin-wp-import build

# Login si pas déjà fait
npm whoami || npm login

# Publier dans l'ordre des dépendances
npm publish -w @paul-lefizelier/wp-to-strapi-core
npm publish -w @paul-lefizelier/wp-to-strapi-adapter
npm publish -w strapi-plugin-wp-import

# Nettoyer le changeset initial qui sert à tagger v0.1.0
rm .changeset/initial-release.md
git add -A && git commit -m "chore: first release v0.1.0"
```

## 8. Activer la release automatique pour la suite

1. Sur npmjs.com → Access Tokens → **Generate New Token** → choisir *Automation* (classic)
2. Copier le token
3. Sur GitHub → ton repo → Settings → Secrets and variables → Actions → **New repository secret**
   - Name: `NPM_TOKEN`
   - Value: le token
4. Pousser ton repo : `git push origin main`

À partir de là, le workflow `release.yml` prend le relais :

- Pour chaque change qui doit shipper, dans la PR : `pnpm changeset` → tu décris le changement et tu choisis le bump
- Au merge sur `main`, l'action ouvre une "chore: release" PR avec les bumps de versions et le CHANGELOG
- Tu merges cette PR → l'action publie sur npm

## 9. Vérifier que le plugin est bien sur la marketplace Strapi

Une fois `strapi-plugin-wp-import` publié, il apparaît automatiquement dans :

- Recherche npm : https://www.npmjs.com/package/strapi-plugin-wp-import
- Marketplace in-app de Strapi (admin panel → Marketplace), à condition d'avoir le tag `strapi-plugin` dans les keywords du `package.json` (déjà inclus)

Pour avoir une fiche officielle Strapi Market avec badge, il faut ouvrir un PR sur le [strapi-marketplace repo](https://github.com/strapi/strapi-marketplace) — optionnel mais bon pour la visibilité.

## Troubleshooting

| Symptôme | Cause | Fix |
|----------|-------|-----|
| `ERR_PNPM_FETCH_404 @YOUR-NPM-USERNAME/...` | Placeholder pas remplacé | Refaire le `sed` de l'étape 1 |
| `ERR_PNPM_NO_MATCHING_VERSION` sur un package interne | `pnpm-workspace.yaml` absent ou mal configuré | Vérifier qu'il existe à la racine |
| `npm error 402 Payment Required` au publish | Scoped package en privé par défaut | Vérifier `publishConfig.access: "public"` dans le `package.json` concerné |
| `npm error 403 Forbidden` au publish | Mauvais token ou 2FA "auth and writes" | Régénérer un token *Automation*, mettre 2FA en *auth only* |
| Le Nuxt importe les types mais le runtime crashe | `dist/` du core pas généré | `pnpm -F @paul-lefizelier/wp-to-strapi-core build` |
| Strapi plugin invisible dans l'admin | Pas activé dans `config/plugins.ts` | Ajouter `'wp-import': { enabled: true }` puis `npm run build` côté Strapi |
