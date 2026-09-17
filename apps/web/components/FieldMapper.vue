<script setup lang="ts">
import {
  defaultEntryMapping,
  defaultTermMapping,
  validateMapping,
  TRANSFORMS,
  type FieldMapping,
  type SourceField,
  type TargetSchema,
} from "@paullefizelier/wp-to-strapi-core/mapping";
import { useMigrationConfig } from "~/composables/useMigrationConfig";

const { config } = useMigrationConfig();
const toast = useToast();

type MappingKey = "common" | "post" | "page" | "category" | "tag" | `custom:${string}`;

const tabs = computed<Array<{ key: MappingKey; label: string }>>(() => [
  { key: "common", label: "Communs (tous)" },
  { key: "post", label: "Articles" },
  { key: "page", label: "Pages" },
  ...(config.value.strapi.categoryUid ? [{ key: "category" as const, label: "Catégories" }] : []),
  ...(config.value.strapi.tagUid ? [{ key: "tag" as const, label: "Étiquettes" }] : []),
  ...config.value.customTypes.map((t) => ({
    key: `custom:${t.restBase}` as MappingKey,
    label: t.restBase,
  })),
]);

const active = ref<MappingKey>("common");
watch(tabs, (list) => {
  if (!list.some((t) => t.key === active.value)) active.value = "common";
});

/** Where each tab reads its fields from, on both sides. */
const endpoints = computed(() => {
  const key = active.value;
  if (key.startsWith("custom:")) {
    const restBase = key.slice("custom:".length);
    const type = config.value.customTypes.find((t) => t.restBase === restBase);
    return { restBase, uid: type?.uid ?? "", pluralPath: type?.pluralPath };
  }
  const map: Record<string, { restBase: string; uid: string; pluralPath?: string }> = {
    common: { restBase: "posts", uid: config.value.strapi.postUid, pluralPath: config.value.strapi.postPluralPath },
    post: { restBase: "posts", uid: config.value.strapi.postUid, pluralPath: config.value.strapi.postPluralPath },
    page: { restBase: "pages", uid: config.value.strapi.pageUid, pluralPath: config.value.strapi.pagePluralPath },
    category: { restBase: "categories", uid: config.value.strapi.categoryUid ?? "", pluralPath: config.value.strapi.categoryPluralPath },
    tag: { restBase: "tags", uid: config.value.strapi.tagUid ?? "", pluralPath: config.value.strapi.tagPluralPath },
  };
  return map[key] ?? map.common!;
});

const isTerm = computed(() => active.value === "category" || active.value === "tag");

/** Rows for the active tab. `common` starts empty; the others start from the built-in mapping. */
const rows = computed<FieldMapping[]>({
  get() {
    const key = active.value;
    const m = config.value.mapping ?? {};
    if (key.startsWith("custom:")) {
      const restBase = key.slice("custom:".length);
      return m.custom?.[restBase] ?? m.post ?? defaultEntryMapping();
    }
    if (key === "common") return m.common ?? [];
    return (m as Record<string, FieldMapping[] | undefined>)[key]
      ?? (isTerm.value ? defaultTermMapping() : defaultEntryMapping());
  },
  set(next) {
    const key = active.value;
    const m = { ...(config.value.mapping ?? {}) };
    if (key.startsWith("custom:")) {
      m.custom = { ...(m.custom ?? {}), [key.slice("custom:".length)]: next };
    } else {
      (m as Record<string, FieldMapping[]>)[key] = next;
    }
    config.value.mapping = m;
  },
});

const issues = computed(() => validateMapping(rows.value));

/** Enumeration fields discovered on the Strapi side, so a constant can be picked, not typed. */
const enumOptions = computed<Record<string, string[]>>(() =>
  Object.fromEntries(
    (targetSchema.value?.fields ?? [])
      .filter((f) => (f.options ?? []).length > 0)
      .map((f) => [f.name, f.options as string[]]),
  ),
);
const transformNames = Object.keys(TRANSFORMS);

interface PreviewItem {
  kind: string;
  wpId: number;
  slug: string;
  uid: string;
  data: Record<string, unknown>;
  warnings: string[];
}

const preview = ref<PreviewItem[] | null>(null);
const previewing = ref(false);
const previewError = ref<string | null>(null);

/** Run the real pipeline on a couple of entries and show the payloads, writing nothing. */
async function runPreview() {
  previewing.value = true;
  previewError.value = null;
  preview.value = null;
  const key = active.value;
  const kind = key.startsWith("custom:")
    ? "custom"
    : key === "page"
      ? "pages"
      : key === "category"
        ? "categories"
        : key === "tag"
          ? "tags"
          : "posts";
  try {
    const res = await $fetch<{ items: PreviewItem[] }>("/api/preview", {
      method: "POST",
      body: {
        ...config.value,
        // The preview needs a token to typecheck the config, never to write.
        strapi: { ...config.value.strapi, token: config.value.strapi.token || "preview" },
        kind,
        restBase: key.startsWith("custom:") ? key.slice("custom:".length) : undefined,
        limit: 2,
      },
    });
    preview.value = res.items;
  } catch (err) {
    previewError.value = (err as { statusMessage?: string }).statusMessage ?? String(err);
  } finally {
    previewing.value = false;
  }
}

const sourceFields = ref<SourceField[]>([]);
const targetSchema = ref<TargetSchema | null>(null);
const discovering = ref(false);

/** Read both sides so the pickers list real field names instead of guesses. */
async function discover() {
  discovering.value = true;
  sourceFields.value = [];
  targetSchema.value = null;
  const { restBase, uid, pluralPath } = endpoints.value;
  const results = await Promise.allSettled([
    $fetch<{ fields: SourceField[] }>("/api/fields/wp", {
      method: "POST",
      body: { ...config.value.wp, restBase },
    }),
    uid && config.value.strapi.token
      ? $fetch<TargetSchema>("/api/fields/strapi", {
          method: "POST",
          body: { baseUrl: config.value.strapi.baseUrl, token: config.value.strapi.token, uid, pluralPath },
        })
      : Promise.resolve(null),
  ]);
  discovering.value = false;

  const [wp, strapi] = results;
  if (wp.status === "fulfilled") sourceFields.value = wp.value.fields;
  else toast.add({ title: "Champs WordPress illisibles", description: String(wp.reason), color: "red" });
  if (strapi.status === "fulfilled" && strapi.value) targetSchema.value = strapi.value;
  else if (strapi.status === "rejected") {
    toast.add({ title: "Champs Strapi illisibles", description: String(strapi.reason), color: "amber" });
  } else if (!uid || !config.value.strapi.token) {
    toast.add({
      title: "Côté Strapi non interrogé",
      description: "Renseignez l'URL, le token et l'UID pour lister les champs de destination.",
      color: "amber",
    });
  }
}

function addRow() {
  rows.value = [...rows.value, { target: "", source: "" }];
}
function removeRow(index: number) {
  rows.value = rows.value.filter((_, i) => i !== index);
}
function patchRow(index: number, patch: Partial<FieldMapping>) {
  rows.value = rows.value.map((row, i) => (i === index ? { ...row, ...patch } : row));
}
function setMode(index: number, mode: "source" | "value") {
  const row = rows.value[index];
  if (!row) return;
  rows.value = rows.value.map((r, i) =>
    i === index
      ? mode === "source"
        ? { target: r.target, source: "", transforms: r.transforms, omitEmpty: r.omitEmpty }
        : { target: r.target, value: "", transforms: r.transforms, omitEmpty: r.omitEmpty }
      : r,
  );
}
function resetToDefault() {
  rows.value = active.value === "common" ? [] : isTerm.value ? defaultTermMapping() : defaultEntryMapping();
}
function transformsText(row: FieldMapping) {
  return (row.transforms ?? []).join(", ");
}
function setTransforms(index: number, text: string) {
  const transforms = text.split(",").map((t) => t.trim()).filter(Boolean);
  patchRow(index, { transforms: transforms.length > 0 ? transforms : undefined });
}
</script>

<template>
  <UCard>
    <template #header>
      <div class="flex items-center justify-between gap-4">
        <div>
          <h2 class="text-lg font-semibold">Mapping des champs</h2>
          <p class="text-sm text-gray-500 dark:text-gray-400">
            Chaque ligne écrit un champ Strapi, depuis un champ WordPress ou une valeur fixe.
          </p>
        </div>
        <div class="flex items-center gap-2">
          <UButton
            :loading="previewing"
            :disabled="!config.wp.baseUrl || issues.length > 0"
            size="sm"
            color="gray"
            icon="i-heroicons-eye"
            @click="runPreview"
          >
            Aperçu
          </UButton>
          <UButton
            :loading="discovering"
            :disabled="!config.wp.baseUrl || !config.strapi.baseUrl"
            size="sm"
            color="gray"
            icon="i-heroicons-arrow-path"
            @click="discover"
          >
            Lire les champs disponibles
          </UButton>
        </div>
      </div>
    </template>

    <div class="space-y-4">
      <div class="flex flex-wrap gap-2">
        <UButton
          v-for="tab in tabs"
          :key="tab.key"
          :color="active === tab.key ? 'primary' : 'gray'"
          :variant="active === tab.key ? 'solid' : 'ghost'"
          size="xs"
          @click="active = tab.key"
        >
          {{ tab.label }}
        </UButton>
      </div>

      <UAlert
        v-if="active === 'common'"
        icon="i-heroicons-information-circle"
        color="blue"
        variant="subtle"
        title="Champs communs"
        description="Appliqués à tous les imports — articles, pages, taxonomies, types personnalisés. Un champ redéfini dans un onglet spécifique l'emporte ici."
      />

      <UAlert
        v-if="targetSchema && targetSchema.source !== 'schema'"
        icon="i-heroicons-exclamation-triangle"
        color="amber"
        variant="subtle"
        title="Champs Strapi partiels"
        :description="targetSchema.note"
      />

      <!-- datalists feed every row's inputs -->
      <datalist id="wp-sources">
        <option v-for="f in sourceFields" :key="f.path" :value="f.path">{{ f.sample }}</option>
      </datalist>
      <datalist id="strapi-targets">
        <option v-for="f in targetSchema?.fields ?? []" :key="f.name" :value="f.name">
          {{ f.type }}{{ f.required ? " (requis)" : "" }}{{ f.options?.length ? ` — ${f.options.join(" | ")}` : "" }}
        </option>
      </datalist>
      <datalist v-for="(values, field) in enumOptions" :id="`enum-${field}`" :key="field">
        <option v-for="v in values" :key="v" :value="v" />
      </datalist>
      <datalist id="transform-names">
        <option v-for="name in transformNames" :key="name" :value="name" />
      </datalist>

      <div class="space-y-2">
        <div class="hidden md:grid grid-cols-12 gap-2 text-xs font-medium text-gray-500 px-1">
          <div class="col-span-3">Champ Strapi</div>
          <div class="col-span-2">Origine</div>
          <div class="col-span-3">Source / valeur</div>
          <div class="col-span-3">Transformations</div>
          <div class="col-span-1" />
        </div>

        <div
          v-for="(row, i) in rows"
          :key="i"
          class="grid grid-cols-1 md:grid-cols-12 gap-2 items-center"
        >
          <UInput
            class="md:col-span-3"
            :model-value="row.target"
            placeholder="titre"
            list="strapi-targets"
            @update:model-value="(v: string) => patchRow(i, { target: v })"
          />
          <USelect
            class="md:col-span-2"
            :model-value="row.source !== undefined ? 'source' : 'value'"
            :options="[
              { value: 'source', label: 'Champ WP' },
              { value: 'value', label: 'Valeur fixe' },
            ]"
            @update:model-value="(v: 'source' | 'value') => setMode(i, v)"
          />
          <UInput
            v-if="row.source !== undefined"
            class="md:col-span-3"
            :model-value="row.source"
            placeholder="title.rendered"
            list="wp-sources"
            @update:model-value="(v: string) => patchRow(i, { source: v })"
          />
          <UInput
            v-else
            class="md:col-span-3"
            :model-value="String(row.value ?? '')"
            :placeholder="enumOptions[row.target]?.[0] ?? 'fr'"
            :list="enumOptions[row.target] ? `enum-${row.target}` : undefined"
            @update:model-value="(v: string) => patchRow(i, { value: v })"
          />
          <UInput
            class="md:col-span-3"
            :model-value="transformsText(row)"
            placeholder="decodeEntities, trim"
            list="transform-names"
            @update:model-value="(v: string) => setTransforms(i, v)"
          />
          <div class="md:col-span-1 flex items-center gap-1 justify-end">
            <UTooltip text="Ne pas écrire le champ si la valeur est vide">
              <UCheckbox
                :model-value="row.omitEmpty === true"
                @update:model-value="(v: boolean) => patchRow(i, { omitEmpty: v || undefined })"
              />
            </UTooltip>
            <UButton
              color="red"
              variant="ghost"
              size="xs"
              icon="i-heroicons-trash"
              @click="removeRow(i)"
            />
          </div>
        </div>

        <p v-if="rows.length === 0" class="text-sm text-gray-500 py-2">
          Aucun champ commun. Ajoutez-en un pour l'appliquer à tous les imports.
        </p>
      </div>

      <div class="flex items-center gap-2">
        <UButton size="xs" icon="i-heroicons-plus" @click="addRow">Ajouter un champ</UButton>
        <UButton size="xs" color="gray" variant="ghost" @click="resetToDefault">
          {{ active === "common" ? "Tout retirer" : "Revenir au mapping par défaut" }}
        </UButton>
      </div>

      <div v-if="previewError || preview" class="space-y-2">
        <UAlert
          v-if="previewError"
          color="red"
          variant="subtle"
          icon="i-heroicons-exclamation-triangle"
          title="Aperçu impossible"
          :description="previewError"
        />
        <template v-else-if="preview">
          <p class="text-sm font-medium">
            Ce qui serait écrit dans Strapi (rien n'est envoyé) :
          </p>
          <div v-for="item in preview" :key="item.wpId" class="space-y-1">
            <p class="text-xs text-gray-500 font-mono">
              #{{ item.wpId }} · {{ item.slug }} → {{ item.uid }}
            </p>
            <pre class="text-xs bg-gray-50 dark:bg-gray-900 rounded p-3 overflow-x-auto">{{ JSON.stringify(item.data, null, 2) }}</pre>
            <p
              v-for="(w, wi) in item.warnings"
              :key="wi"
              class="text-xs text-amber-600 dark:text-amber-400"
            >
              ⚠ {{ w }}
            </p>
          </div>
          <p v-if="preview.length === 0" class="text-sm text-gray-500">
            Rien à prévisualiser pour ce type de contenu.
          </p>
        </template>
      </div>

      <UAlert
        v-if="issues.length > 0"
        color="red"
        variant="subtle"
        icon="i-heroicons-exclamation-triangle"
        title="Mapping invalide"
        :description="issues.map((i) => `${i.target || '(sans nom)'} : ${i.message}`).join(' · ')"
      />
    </div>
  </UCard>
</template>
