import type { NoticeCode, NoticeParamsByCode } from "@paullefizelier/wp-to-strapi-core/mapping";

/**
 * French renderings of the engine's notices.
 *
 * The engine emits a code plus its parameters; this table turns them into sentences for this
 * UI. Being typed as a full `NoticeCode` record, a code added to the engine fails the
 * typecheck here until it has French text — no silently untranslated message.
 */
/** Where to fix a mapping, as the Mapping step names its tabs. */
function mappingLabel(key: string): string {
  if (key.startsWith("route:")) return `de la route « ${key.slice(6)} »`;
  if (key.startsWith("custom:")) return `du type « ${key.slice(7)} »`;
  if (key.startsWith("taxonomy:")) return `de la taxonomie « ${key.slice(9)} »`;
  const tabs: Record<string, string> = {
    post: "« Articles »", page: "« Pages »", category: "« Catégories »", tag: "« Étiquettes »",
    author: "des auteurs", comment: "des commentaires", menu: "des menus",
  };
  return tabs[key] ?? `« ${key} »`;
}

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
  "media.scoped": (p) =>
    `Médias : ${p.used} fichier(s) sur ${p.total} sont utilisés par les contenus importés — ` +
    `seuls ceux-là sont migrés.`,
  "preflight.noCorrelation": (p) =>
    `${p.uid} (${mappingLabel(p.mapping)}) : aucun champ pour retrouver les entrées déjà ` +
    `importées — ni « ${p.field} », ni « wpId », ni « slug ». Le plus simple : dans Strapi, ` +
    `ajoutez un champ Nombre (entier) nommé « wpId », puis dans le mapping ${mappingLabel(p.mapping)} ` +
    `une ligne id → wpId. Champs de ce content-type : ${p.available || "?"}.`,
  "preflight.correlationNotMapped": (p) =>
    `${p.uid} : le champ « ${p.field} » existe, mais le mapping ${mappingLabel(p.mapping)} ne le ` +
    `remplit pas. Ajoutez la ligne ${p.field === "wpId" ? "id" : p.field} → ${p.field}, sinon ` +
    `chaque relance créerait des doublons.`,
  "preflight.correlationFallback": (p) =>
    `${p.uid} : les entrées déjà importées seront retrouvées par « ${p.field} ».`,
  "preflight.unknownFields": (p) =>
    `${p.uid} n'a pas de champ ${p.fields} (écrit par le mapping ${mappingLabel(p.mapping)}). ` +
    `Champs de ce content-type : ${p.available || "?"}. Renommez ces lignes dans le mapping ` +
    `(bouton « Lire les champs » pour les choisir), ou ajoutez les champs dans Strapi.`,
  "preflight.unknownAiFields": (p) =>
    `${p.uid} n'a pas de champ ${p.fields}, qu'une règle de l'assistant IA remplit (mapping ` +
    `${mappingLabel(p.mapping)}). Champs de ce content-type : ${p.available || "?"}. Corrigez le ` +
    `champ de la règle, ou réservez-la aux content-types qui l'ont (« Règles pour » dans la carte IA).`,
  "media.keptAsFile": (p) =>
    `${p.file} : Strapi n'a pas pu le traiter comme image — importé comme simple fichier (sans ` +
    `tailles générées). Vérifiez-le dans la médiathèque.`,
  "preflight.systemDate": (p) =>
    `${p.uid} : « ${p.field} » (mapping ${mappingLabel(p.mapping)}) est rempli par Strapi à chaque ` +
    `écriture et ne peut pas être envoyé. Mettez plutôt la date WordPress dans un champ date à vous.`,
  "preflight.noDate": (p) =>
    `${p.uid} (mapping ${mappingLabel(p.mapping)}) : aucun champ date n'est rempli, les entrées auront ` +
    `la date d'aujourd'hui (Strapi fixe lui-même createdAt/publishedAt). ` +
    (p.fields
      ? `Pour garder la date WordPress : ajoutez la ligne date_gmt → ${p.fields} avec la transformation « date ».`
      : `Pour garder la date WordPress : ajoutez un champ « Date » (type Date, format date et heure) au ` +
        `content-type, puis la ligne date_gmt → ce champ avec la transformation « date ».`),
  "ai.failed": (p) =>
    `${p.entry} : l'assistant IA a échoué (${p.error}) — entrée importée sans ses champs IA.`,
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
