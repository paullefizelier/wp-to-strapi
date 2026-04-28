import { prefixPluginTranslations } from "./utils/prefixPluginTranslations";
import PluginIcon from "./components/PluginIcon";
import pluginId from "./pluginId";
import pluginPkg from "../../package.json";

const name = pluginPkg.strapi?.displayName ?? pluginId;

// Loose typing — the Strapi admin App type varies between minor versions.
type StrapiApp = {
  addMenuLink: (link: {
    to: string;
    icon: unknown;
    intlLabel: { id: string; defaultMessage: string };
    Component: () => Promise<{ default: React.ComponentType }>;
  }) => void;
  registerPlugin: (p: { id: string; initializer?: React.ComponentType; isReady: boolean; name: string }) => void;
  registerTrads?: (
    trads: { data: Record<string, string>; locale: string }[],
  ) => Promise<{ data: Record<string, string>; locale: string }[]>;
};

export default {
  register(app: StrapiApp) {
    app.addMenuLink({
      to: `/plugins/${pluginId}`,
      icon: PluginIcon,
      intlLabel: {
        id: `${pluginId}.plugin.name`,
        defaultMessage: name,
      },
      Component: async () => {
        const { App } = await import("./pages/App");
        return { default: App };
      },
    });

    app.registerPlugin({
      id: pluginId,
      name,
      isReady: true,
    });
  },

  async registerTrads({ locales }: { locales: string[] }) {
    const imports = locales.map(async (locale) => {
      try {
        const data = (await import(`./translations/${locale}.json`)) as { default: Record<string, string> };
        return { data: prefixPluginTranslations(data.default, pluginId), locale };
      } catch {
        return { data: {}, locale };
      }
    });
    return Promise.all(imports);
  },
};
