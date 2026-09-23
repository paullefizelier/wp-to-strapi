import type { NoticeCode, NoticeParamsByCode } from "@paullefizelier/wp-to-strapi-core/mapping";

/**
 * French renderings of the engine's notices.
 *
 * The engine emits a code plus its parameters; this table turns them into sentences for this
 * UI. Being typed as a full `NoticeCode` record, a code added to the engine fails the
 * typecheck here until it has French text — no silently untranslated message.
 */
const FR: { [C in NoticeCode]: (p: NoticeParamsByCode[C]) => string } = {
  "content.empty": (p) => `${p.entry} : WordPress renvoie un contenu vide — rien à importer.`,
  "content.builder": (p) =>
    `${p.entry} : construit avec ${p.builder} — la mise en page vit dans les métadonnées, ` +
    `seul le rendu REST aplati est migré. Cette page sera à refaire.`,
  "content.shortcodes": (p) =>
    `${p.entry} : ${p.count} shortcode(s) non interprété(s), conservés tels quels : ${p.tags}`,
  "content.unresolvedMedia": (p) =>
    `${p.entry} : ${p.count} URL(s) de média pointent encore vers WordPress ` +
    `(absentes de la table des médias) : ${p.examples}`,
  "content.recovered": (p) =>
    `${p.entry} : ${p.reason === "empty REST body" ? "corps REST vide" : `mise en page ${p.reason.replace(" layout", "")}`} — ` +
    `${p.chars} caractères de texte et les images récupérés depuis la page publique. ` +
    `La mise en page et les styles ne sont pas migrés.`,
  "content.embedsDropped": (p) =>
    `${p.entry} : ${p.count} intégration(s) (iframe/vidéo/audio) retirée(s) du contenu récupéré — ` +
    `à replacer à la main si elles comptent.`,
  "content.fallbackFailed": (p) =>
    `${p.entry} : impossible de lire ${p.url} pour le repli — ${p.error}`,
  "terms.missing": (p) =>
    `${p.entry} : ${p.count} terme(s) absent(s) du fichier d'état — lancez les étapes ` +
    `Catégories et Étiquettes avant les articles, sinon les relations restent vides.`,
  "media.none": () =>
    "Aucun média dans le fichier d'état : les URLs de média du contenu importé continueront " +
    "de pointer vers WordPress. Lancez l'étape Médias d'abord (ou en même temps).",
  "statuses.needCredentials": (p) =>
    `Les statuts ${p.statuses} nécessitent des identifiants WordPress — sans eux, l'API REST ` +
    `ne renvoie que le contenu publié.`,
  "mapping.unknownTransform": (p) =>
    `Transformation inconnue « ${p.transform} » sur le champ « ${p.field} » — ignorée.`,
  "retry.pending": (p) => `Reprise de ${p.count} entrée(s) en échec lors du run précédent.`,
  "retry.nothing": () => "Rien à reprendre — le fichier d'état ne contient aucun échec.",
  "http.retry": (p) =>
    `${p.side} : ${p.reason} — nouvelle tentative ${p.attempt} dans ${p.delayMs} ms.`,
  "customType.failed": (p) => `Type personnalisé « ${p.restBase} » : ${p.error}`,
  "failures.header": (p) => `${p.count} entrée(s) en échec, regroupées par cause :`,
  "failures.group": (p) =>
    `  ${p.count}× [${p.kinds}] ${p.cause} (ids ${p.ids}${p.more ? ", …" : ""})`,
  "hierarchy.linked": (p) =>
    `${p.kind === "pages" ? "Pages" : "Catégories"} : ${p.count} lien(s) de parenté rétabli(s).`,
  "redirects.written": (p) =>
    `${p.count} redirection(s) enregistrée(s)${p.file ? ` et écrite(s) dans ${p.file}` : ""}.`,
  "redirects.writeFailed": (p) =>
    `Impossible d'écrire la table de redirections dans ${p.file} : ${p.error}`,
  "routing.unknownTerm": (p) =>
    `Route « ${p.route} » : ${p.taxonomy === "tags" ? "l'étiquette" : "la catégorie"} ` +
    `« ${p.term} » n'existe pas dans WordPress (connues : ${p.available}).`,
  "routing.summary": (p) => `Routage : ${p.counts}.`,
  "wp.redirected": (p) =>
    `WordPress répond depuis ${p.to} et non ${p.from} — redirection suivie. Mettez ${p.to} ` +
    `comme URL WordPress pour l'éviter.`,
  "failures.hint": () =>
    "Relancez avec « Relancer uniquement ces entrées » pour ne reprendre que celles-là.",
};

/** French text for a notice, falling back to the engine's English when the code is unknown. */
export function noticeText(
  code: string | undefined,
  params: unknown,
  fallback: string,
): string {
  const render = code ? (FR as Record<string, ((p: unknown) => string) | undefined>)[code] : undefined;
  if (!render) return fallback;
  try {
    return render(params);
  } catch {
    return fallback;
  }
}
