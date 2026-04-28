import type { Core } from "@strapi/strapi";

const destroy = ({ strapi }: { strapi: Core.Strapi }) => {
  const store = strapi.plugin("wp-import").service("runStore") as { stopAll?: () => void } | undefined;
  store?.stopAll?.();
};

export default destroy;
