/**
 * Nuxt UI v2 reads its theme from app.config, not from the module options in nuxt.config —
 * where these keys were silently ignored (and failed typecheck).
 */
export default defineAppConfig({
  ui: {
    primary: "indigo",
    gray: "slate",
  },
});
