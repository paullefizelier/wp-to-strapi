import type { Core } from "@strapi/strapi";

const register = (_params: { strapi: Core.Strapi }) => {
  // Nothing needed at register time — all logic is in services and runs on demand.
};

export default register;
