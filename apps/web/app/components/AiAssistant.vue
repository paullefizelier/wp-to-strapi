<script setup lang="ts">
import type { AiRule, GeminiModel, PreviewItem } from "@paullefizelier/wp-to-strapi-core";
import type { TargetField, TargetSchema } from "@paullefizelier/wp-to-strapi-core/mapping";
import { noticeText } from "~/utils/notices";

const { config } = useMigrationConfig();

/** Google's current fast model at the time of writing; "Vérifier la clé" lists the real ones. */
const SUGGESTED_MODEL = "gemini-3.8-flash";

const enabled = computed({
  get: () => Boolean(config.value.ai),
  set: (on: boolean) => {
    config.value.ai = on
      ? { provider: "gemini", model: SUGGESTED_MODEL, rules: {}, ...(config.value.ai ?? {}) }
      : undefined;
  },
});

function errorText(err: unknown): string {
  const e = err as { statusMessage?: string; data?: { statusMessage?: string }; message?: string };
  return e.data?.statusMessage ?? e.statusMessage ?? e.message ?? String(err);
}

// ----- Key and model -----

const models = ref<GeminiModel[]>([]);
const checking = ref(false);
const keyStatus = ref<{ ok: boolean; message: string } | null>(null);

async function checkKey() {
  if (!config.value.ai) return;
  checking.value = true;
  keyStatus.value = null;
  try {
    const res = await $fetch<{ models: GeminiModel[]; fromEnv: boolean }>("/api/ai/models", {
      method: "POST",
      body: { apiKey: config.value.ai.apiKey || undefined },
    });
    models.value = res.models;
    keyStatus.value = {
      ok: true,
      message: `${res.models.length} modèles disponibles${res.fromEnv ? " (clé GEMINI_API_KEY du serveur)" : ""}.`,
    };
    const ids = res.models.map((m) => m.id);
    if (!ids.includes(config.value.ai.model)) {
      config.value.ai.model = ids.find((id) => id === SUGGESTED_MODEL) ?? ids.find((id) => /flash/.test(id) && !/lite|preview|exp/.test(id)) ?? ids[0] ?? config.value.ai.model;
    }
  } catch (err) {
    keyStatus.value = { ok: false, message: errorText(err) };
  } finally {
    checking.value = false;
  }
}

const modelItems = computed(() => {
  const list = models.value.map((m) => ({ label: `${m.displayName} — ${m.id}`, value: m.id }));
  const current = config.value.ai?.model;
  return current && !list.some((m) => m.value === current) ? [{ label: current, value: current }, ...list] : list;
});

// ----- Scope: which entries a rule applies to -----

const scopes = computed(() => [
  { label: "Tous les contenus", value: "*" },
  { label: "Articles", value: "post" },
  { label: "Pages", value: "page" },
  ...config.value.routing.routes.map((r) => ({ label: `Route ${r.name}`, value: `route:${r.name}` })),
  ...config.value.customTypes.map((t) => ({ label: `Type ${t.restBase}`, value: `custom:${t.restBase}` })),
]);
const scope = ref("*");

const rules = computed<AiRule[]>(() => config.value.ai?.rules[scope.value] ?? []);

function setRules(next: AiRule[]) {
  if (!config.value.ai) return;
  const all = { ...config.value.ai.rules };
  if (next.length) all[scope.value] = next;
  else delete all[scope.value];
  config.value.ai.rules = all;
}

function update(index: number, patch: Partial<AiRule>) {
  setRules(rules.value.map((r, i) => (i === index ? { ...r, ...patch } : r)));
}

const ruleCount = computed(() =>
  Object.values(config.value.ai?.rules ?? {}).reduce((n, list) => n + list.length, 0),
);

// ----- Target fields, from the Strapi schema of the scope's content-type -----

const scopeUid = computed(() => {
  const s = scope.value;
  if (s.startsWith("route:")) return config.value.routing.routes.find((r) => `route:${r.name}` === s)?.uid;
  if (s.startsWith("custom:")) return config.value.customTypes.find((t) => `custom:${t.restBase}` === s)?.uid;
  return s === "page" ? config.value.strapi.pageUid : config.value.strapi.postUid;
});

const schemas = ref<Record<string, TargetSchema | null>>({});

watch(
  [scopeUid, enabled],
  async ([uid, on]) => {
    if (!on || !uid || uid in schemas.value || !config.value.strapi.token) return;
    try {
      schemas.value = {
        ...schemas.value,
        [uid]: await $fetch<TargetSchema>("/api/fields/strapi", {
          method: "POST",
          body: { baseUrl: config.value.strapi.baseUrl, token: config.value.strapi.token, uid },
        }),
      };
    } catch {
      schemas.value = { ...schemas.value, [uid]: null };
    }
  },
  { immediate: true },
);

/** Every field a rule can target, component sub-fields as dot paths. */
const targetFields = computed(() => {
  const fields = scopeUid.value ? (schemas.value[scopeUid.value]?.fields ?? []) : [];
  const out: Array<{ path: string; field: TargetField }> = [];
  for (const f of fields) {
    if (["id", "documentId", "createdAt", "updatedAt", "publishedAt", "locale"].includes(f.name)) continue;
    out.push({ path: f.name, field: f });
    if (f.type === "component" && !f.repeatable) {
      for (const sub of f.fields ?? []) out.push({ path: `${f.name}.${sub.name}`, field: sub });
    }
  }
  return out;
});
const targetItems = computed(() => targetFields.value.map((t) => t.path));

/** What kind of answer a Strapi field wants. */
function ruleTypeFor(field?: TargetField): AiRule["type"] {
  switch (field?.type) {
    case "richtext":
      return "html";
    case "enumeration":
      return "enum";
    case "integer":
    case "biginteger":
    case "float":
    case "decimal":
      return "number";
    case "boolean":
      return "boolean";
    case "blocks":
    case "json":
    case "component":
    case "dynamiczone":
      return "json";
    default:
      return "string";
  }
}

function pickTarget(index: number, path: string) {
  const field = targetFields.value.find((t) => t.path === path)?.field;
  update(index, {
    target: path,
    type: ruleTypeFor(field),
    ...(field?.type === "enumeration" ? { options: field.options ?? [] } : {}),
  });
}

const TYPE_ITEMS = [
  { label: "Texte", value: "string" },
  { label: "HTML", value: "html" },
  { label: "Nombre", value: "number" },
  { label: "Oui / non", value: "boolean" },
  { label: "Liste de valeurs", value: "enum" },
  { label: "Liste de textes", value: "string[]" },
  { label: "JSON (composant, blocs)", value: "json" },
];

const PRESETS: Array<{ label: string; icon: string; rule: AiRule }> = [
  {
    label: "Meta description SEO",
    icon: "i-lucide-search",
    rule: { target: "seo.metaDescription", instruction: "Meta description SEO de 150 à 155 caractères, qui donne envie de cliquer, sans guillemets.", type: "string" },
  },
  {
    label: "Chapô / résumé",
    icon: "i-lucide-text-quote",
    rule: { target: "excerpt", instruction: "Résumé de l'article en 2 phrases maximum, factuel.", type: "string" },
  },
  {
    label: "Extraire une date",
    icon: "i-lucide-calendar",
    rule: { target: "eventDate", instruction: "Date de l'événement mentionné dans le contenu, au format AAAA-MM-JJ.", type: "string" },
  },
  {
    label: "Choisir une valeur de liste",
    icon: "i-lucide-list",
    rule: { target: "audience", instruction: "Public principalement visé par ce contenu.", type: "enum", options: [] },
  },
  {
    label: "Nettoyer le contenu (page builder)",
    icon: "i-lucide-wand-sparkles",
    rule: {
      target: "content",
      instruction: "Réécris le contenu en HTML propre et sémantique : garde tout le texte et les images, retire la mise en page du page builder.",
      type: "html",
      overwrite: true,
    },
  },
];

/** A preset takes the real field's type and allowed values when the content-type has it. */
function addRule(rule: AiRule = { target: "", instruction: "", type: "string" }) {
  const field = targetFields.value.find((t) => t.path === rule.target)?.field;
  const fromSchema: Partial<AiRule> = field
    ? {
        type: rule.type === "html" && field.type === "richtext" ? "html" : ruleTypeFor(field),
        ...(field.type === "enumeration" ? { options: field.options ?? [] } : {}),
      }
    : {};
  setRules([...rules.value, { ...rule, ...fromSchema }]);
}

// ----- Try it on one entry -----

const testing = ref(false);
const testItem = ref<PreviewItem | null>(null);
const testError = ref<string | null>(null);

async function test() {
  testing.value = true;
  testItem.value = null;
  testError.value = null;
  const s = scope.value;
  const route = s.startsWith("route:") ? config.value.routing.routes.find((r) => `route:${r.name}` === s) : undefined;
  const kind = s.startsWith("custom:") ? "custom" : s === "page" || route?.from === "pages" ? "pages" : "posts";
  try {
    const res = await $fetch<{ items: PreviewItem[] }>("/api/preview", {
      method: "POST",
      body: {
        ...config.value,
        strapi: { ...config.value.strapi, token: config.value.strapi.token || "preview" },
        kind,
        restBase: s.startsWith("custom:") ? s.slice("custom:".length) : undefined,
        // A route only takes some entries: look further to find one.
        limit: route ? 6 : 1,
      },
    });
    testItem.value = (route ? res.items.find((i) => i.route === route.name) : res.items[0]) ?? null;
    if (!testItem.value) testError.value = "Aucune entrée trouvée pour ce périmètre.";
  } catch (err) {
    testError.value = errorText(err);
  } finally {
    testing.value = false;
  }
}

const testNotices = computed(() => (testItem.value?.notices ?? []).filter((n) => n.code === "ai.failed"));
</script>

<template>
  <UCard>
    <template #header>
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 class="font-semibold text-highlighted inline-flex items-center gap-2">
            <UIcon name="i-lucide-sparkles" class="size-5 text-primary" />
            Assistant IA
            <UBadge color="neutral" variant="outline" size="sm">Gemini</UBadge>
            <UBadge v-if="enabled && ruleCount" color="primary" variant="subtle" size="sm">
              {{ ruleCount }} règle(s)
            </UBadge>
          </h2>
          <p class="text-sm text-muted mt-0.5">
            Remplit des champs Strapi à partir du contenu WordPress : résumé, SEO, date extraite,
            valeur de liste, contenu nettoyé… Une règle = un champ + une consigne en français.
          </p>
        </div>
        <USwitch v-model="enabled" label="Activer" />
      </div>
    </template>

    <div v-if="enabled && config.ai" class="space-y-6">
      <div class="grid md:grid-cols-2 gap-4">
        <UFormField label="Clé API Gemini" description="Google AI Studio → Get API key. Vide : la variable GEMINI_API_KEY du serveur.">
          <div class="flex gap-2">
            <UInput
              v-model="config.ai.apiKey"
              type="password"
              placeholder="AIza…"
              icon="i-lucide-key-round"
              class="flex-1"
              autocomplete="off"
            />
            <UButton :loading="checking" color="neutral" variant="subtle" icon="i-lucide-plug-zap" @click="checkKey">
              Vérifier
            </UButton>
          </div>
        </UFormField>
        <UFormField label="Modèle" description="Un modèle « flash » suffit pour ces tâches et coûte peu.">
          <USelectMenu
            v-model="config.ai.model"
            :items="modelItems"
            value-key="value"
            create-item
            placeholder="Vérifiez la clé pour lister les modèles"
            class="w-full"
            @create="(v: string) => { if (config.ai) config.ai.model = v }"
          />
        </UFormField>
      </div>
      <UAlert
        v-if="keyStatus"
        :color="keyStatus.ok ? 'success' : 'error'"
        variant="subtle"
        :icon="keyStatus.ok ? 'i-lucide-check' : 'i-lucide-triangle-alert'"
        :title="keyStatus.ok ? 'Clé valide' : 'Clé refusée'"
        :description="keyStatus.message"
      />

      <UFormField label="Consignes générales" description="Appliquées à chaque appel : langue, ton, règles maison.">
        <UTextarea
          v-model="config.ai.instructions"
          :rows="2"
          autoresize
          placeholder="Écris en français, ton institutionnel, vouvoiement. Ne mentionne jamais de prix."
          class="w-full"
        />
      </UFormField>

      <div class="space-y-3">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="flex items-center gap-2">
            <span class="text-sm font-medium text-highlighted">Règles pour</span>
            <USelect v-model="scope" :items="scopes" size="sm" class="w-52" />
          </div>
          <div class="flex flex-wrap gap-2">
            <UDropdownMenu
              :items="PRESETS.map((p) => ({ label: p.label, icon: p.icon, onSelect: () => addRule(p.rule) }))"
            >
              <UButton size="sm" color="neutral" variant="subtle" icon="i-lucide-library" trailing-icon="i-lucide-chevron-down">
                Modèles de règles
              </UButton>
            </UDropdownMenu>
            <UButton size="sm" icon="i-lucide-plus" @click="addRule()">Ajouter une règle</UButton>
          </div>
        </div>

        <p v-if="scope !== '*' && config.ai.rules['*']?.length" class="text-xs text-muted">
          S'ajoutent aux {{ config.ai.rules["*"].length }} règle(s) de « Tous les contenus ».
        </p>

        <div v-if="rules.length === 0" class="rounded-lg border border-dashed border-default py-8 text-center text-sm text-muted">
          Aucune règle pour ce périmètre. Partez d'un modèle ou ajoutez-en une.
        </div>

        <div v-for="(rule, i) in rules" :key="i" class="rounded-lg border border-default p-3 space-y-3">
          <div class="grid md:grid-cols-[1fr_12rem_auto] gap-3 items-end">
            <UFormField label="Champ Strapi">
              <USelectMenu
                :model-value="rule.target"
                :items="targetItems"
                create-item
                placeholder="seo.metaDescription"
                class="w-full"
                @update:model-value="(v: string) => pickTarget(i, v)"
                @create="(v: string) => pickTarget(i, v)"
              />
            </UFormField>
            <UFormField label="Type de réponse">
              <USelect
                :model-value="rule.type ?? 'string'"
                :items="TYPE_ITEMS"
                class="w-full"
                @update:model-value="(v: string) => update(i, { type: v as AiRule['type'] })"
              />
            </UFormField>
            <UButton
              color="error"
              variant="ghost"
              icon="i-lucide-trash-2"
              aria-label="Supprimer la règle"
              @click="setRules(rules.filter((_, j) => j !== i))"
            />
          </div>
          <UFormField v-if="rule.type === 'enum'" label="Valeurs possibles">
            <UInputTags
              :model-value="rule.options ?? []"
              placeholder="Ajoutez les valeurs acceptées par Strapi"
              class="w-full"
              @update:model-value="(v: string[]) => update(i, { options: v })"
            />
          </UFormField>
          <UFormField label="Consigne">
            <UTextarea
              :model-value="rule.instruction"
              :rows="2"
              autoresize
              placeholder="Ce que l'IA doit mettre dans ce champ, et comment."
              class="w-full"
              @update:model-value="(v: string) => update(i, { instruction: v })"
            />
          </UFormField>
          <USwitch
            :model-value="rule.overwrite === true"
            size="sm"
            label="Remplacer la valeur du mapping"
            description="Sinon, l'IA ne remplit ce champ que s'il est vide après le mapping."
            @update:model-value="(v: boolean) => update(i, { overwrite: v })"
          />
        </div>
      </div>

      <div class="rounded-lg bg-elevated p-4 space-y-3">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <p class="text-sm text-muted">
            1 appel par entrée, réponses mémorisées dans le fichier d'état : une entrée déjà traitée
            n'est pas refacturée tant que son contenu et les règles ne changent pas.
          </p>
          <UButton :loading="testing" icon="i-lucide-flask-conical" :disabled="!rules.length && !config.ai.rules['*']?.length" @click="test">
            Tester sur une entrée
          </UButton>
        </div>
        <UAlert v-if="testError" color="error" variant="subtle" icon="i-lucide-triangle-alert" :description="testError" />
        <template v-if="testItem">
          <UAlert
            v-for="(n, k) in testNotices"
            :key="k"
            color="error"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            :description="noticeText(n.code, n.params, n.message)"
          />
          <p class="text-sm">
            <span class="text-muted">Entrée testée :</span>
            <span class="font-medium text-highlighted"> {{ testItem.slug }}</span>
            <span class="text-dimmed"> (#{{ testItem.wpId }})</span>
          </p>
          <p v-if="!testItem.aiFields?.length && !testNotices.length" class="text-sm text-muted">
            L'IA n'a rien rempli : les champs visés étaient déjà remplis par le mapping, ou le
            contenu ne contient pas l'information.
          </p>
          <div v-else class="rounded-md border border-default divide-y divide-default bg-default">
            <div v-for="field in testItem.aiFields" :key="field" class="px-3 py-2 space-y-1">
              <span class="font-mono text-xs font-semibold text-highlighted inline-flex items-center gap-1.5">
                <UIcon name="i-lucide-sparkles" class="size-3.5 text-primary" />{{ field }}
              </span>
              <FillValue :value="field.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], testItem.data)" />
            </div>
          </div>
          <p class="text-xs text-dimmed">La fiche complète est visible en ouvrant une entrée à l'étape Sélection.</p>
        </template>
      </div>
    </div>
  </UCard>
</template>
