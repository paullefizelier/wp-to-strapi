// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: "2025-01-01",
  devtools: { enabled: true },
  modules: ["@nuxt/ui"],
  runtimeConfig: {
    // Server-only secrets (not exposed to the client). Overridable via env vars NUXT_*.
    // The UI can still send these explicitly if you prefer not to persist them server-side.
    wpBaseUrl: "",
    wpUsername: "",
    wpAppPassword: "",
    strapiBaseUrl: "",
    strapiApiToken: "",
    public: {
      appName: "wp-to-strapi",
    },
  },
  typescript: {
    strict: true,
    typeCheck: false,
  },
  nitro: {
    experimental: {
      // Enable streaming response handlers for SSE.
      tasks: false,
    },
  },
});
