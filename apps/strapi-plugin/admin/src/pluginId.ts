import pkg from "../../package.json";

const pluginId: string = pkg.strapi?.name ?? pkg.name.replace(/^strapi-plugin-/, "");
export default pluginId;
