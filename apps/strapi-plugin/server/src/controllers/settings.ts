import type { Core } from "@strapi/strapi";

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async get() {
    return strapi.plugin("wp-import").service("settings").get();
  },

  async update(ctx: { request: { body?: Record<string, unknown> } }) {
    const body = ctx.request.body ?? {};
    return strapi.plugin("wp-import").service("settings").set(body);
  },
});
