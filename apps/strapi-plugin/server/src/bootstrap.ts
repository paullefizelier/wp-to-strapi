import type { Core } from "@strapi/strapi";

const bootstrap = async (_params: { strapi: Core.Strapi }) => {
  // Intentionally empty. Runs are triggered via admin API routes.
};

export default bootstrap;
