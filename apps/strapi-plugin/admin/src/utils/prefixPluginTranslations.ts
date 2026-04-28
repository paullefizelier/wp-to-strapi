/**
 * Strapi's convention: every translation key emitted by a plugin should be
 * namespaced with `${pluginId}.` so it doesn't clash with the core.
 */
export function prefixPluginTranslations(
  trad: Record<string, string>,
  pluginId: string,
): Record<string, string> {
  if (!pluginId) {
    throw new TypeError("pluginId can't be empty");
  }
  return Object.entries(trad).reduce<Record<string, string>>(
    (acc, [key, value]) => {
      acc[`${pluginId}.${key}`] = value;
      return acc;
    },
    {},
  );
}
