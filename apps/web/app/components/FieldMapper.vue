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
import type { TabsItem } from "@nuxt/ui";
import { useMigrationConfig } from "~/composables/useMigrationConfig";

const { config } = useMigrationConfig();
const toast = useToast();

type MappingKey = "common" | "post" | "page" | "category" | "tag" | `custom:${string}`;

interface PreviewItem {
  kind: string;
  wpId: number;
  slug: string;
  uid: string;
  data: Record<string, unknown>;
  warnings: string[];
}

const active = ref<MappingKey>("common");

const tabs = computed<TabsItem[]>(() => [
  { value: "common", label: "Communs", icon: "i-lucide-layers" },
  { value: "post", label: "Articles", icon: "i-lucide-newspaper" },
  { value: "page", label: "Pages", icon: "i-lucide-file-text" },
  ...(config.value.strapi.categoryUid
    ? [{ value: "category", label: "Catégories", icon: "i-lucide-folder-tree" }]
    : []),
  ...(config.value.strapi.tagUid
    ? [{ value: "tag", label: "Étiquettes", icon: "i-lucide-tags" }]
    : []),
  ...config.value.customTypes.map((t: { restBase: string }) => ({
    value: `custom:${t.restBase}`,
    label: t.restBase,
    icon: "i-lucide-shapes",
  })),
]);

watch(tabs, (list) => {
  if (!list.some((t) => t.value === active.value)) active.value = "common";
});

const isTerm = computed(() => active.value === "category" || active.value === "tag");

/** Which REST base and Strapi UID the active tab reads its fields from. */
const endpoints = computed(() => {
  const key = active.value;
  if (key.startsWith("custom:")) {
    const restBase = key.slice("custom:".length);
    const type = config.value.customTypes.find((t: { restBase: string }) => t.restBase === restBase);
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

/** Rows for the active tab. `common` starts empty; the rest start from the built-in mapping. */
const rows = computed<FieldMapping[]>({
  get() {
    const key = active.value;
    const m = config.value.mapping ?? {};
    if (key.startsWith("custom:")) {
      const restBase = key.slice("custom:".length);
      return m.custom?.[restBase] ?? m.post ?? defaultEntryMapping();
    }
    if (key === "common") return m.common ?? [];
    return (
      (m as Record<string, FieldMapping[] | undefined>)[key]
      ?? (isTerm.value ? defaultTermMapping() : defaultEntryMapping())
    );
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

/**
 * Targets the content-type does not have. Strapi rejects an unknown attribute outright, so
 * catching it here beats discovering it on entry one of three thousand.
 */
const unknownTargets = computed(() => {
  if (targetSchema.value?.source !== "schema") return [];
  const known = new Set((targetSchema.value.fields ?? []).map((f) => f.name));
  return rows.value
    .map((r) => r.target)
    .filter(Boolean)
    .filter((t) => !known.has(t.split(".")[0] ?? t));
});
const transformNames = Object.keys(TRANSFORMS);

const sourceFields = ref<SourceField[]>([]);
const targetSchema = ref<TargetSchema | null>(null);
const discovering = ref(false);

/** Free-typed names stay selectable alongside the discovered ones. */
const sourcePaths = computed(() => {
  const discovered = sourceFields.value.map((f) => f.path);
  const used = rows.value.map((r) => r.source).filter((s): s is string => Boolean(s));
  return [...new Set([...discovered, ...used])];
});
/**
 * Target paths, including inside components: a rich-text component is written as
 * `contenu.body` (single) or `blocs.0.body` (repeatable), which is what Strapi expects.
 */
const targetNames = computed(() => {
  const discovered = (targetSchema.value?.fields ?? []).flatMap((f) => {
    if (!f.fields?.length) return [f.name];
    const prefix = f.type === "dynamiczone" || f.repeatable ? `${f.name}.0` : f.name;
    return [f.name, ...f.fields.map((sub) => `${prefix}.${sub.name}`)];
  });
  const used = rows.value.map((r) => r.target).filter(Boolean);
  return [...new Set([...discovered, ...used])];
});

/** Component and dynamic-zone fields, which need a shape rather than a bare value. */
const structuredFields = computed(() =>
  (targetSchema.value?.fields ?? []).filter(
    (f) => f.type === "component" || f.type === "dynamiczone",
  ),
);

/** The field inside a component that should receive the WordPress body. */
function bodyFieldOf(field: { fields?: Array<{ name: string; type?: string }> }) {
  const subs = field.fields ?? [];
  return (
    subs.find((f) => f.type === "richtext" || f.type === "blocks")?.name ??
    subs.find((f) => f.name === "body" || f.name === "content" || f.name === "texte")?.name ??
    subs[0]?.name ??
    "body"
  );
}

/** One click to map the WordPress body into a component, in the shape Strapi expects. */
function mapContentInto(field: (typeof structuredFields.value)[number]) {
  const body = bodyFieldOf(field);
  const row: FieldMapping =
    field.type === "dynamiczone"
      ? {
          target: field.name,
          source: "$content",
          transforms: [
            "rewriteMedia",
            `component:${field.components?.[0] ?? "content.rich-text"}:${body}`,
            "wrap",
          ],
        }
      : {
          target: field.repeatable ? `${field.name}.0.${body}` : `${field.name}.${body}`,
          source: "$content",
          transforms: ["rewriteMedia"],
        };
  rows.value = [...rows.value.filter((r) => r.target !== row.target), row];
  const tab = tabs.value.find((t) => t.value === active.value)?.label ?? active.value;
  toast.add({
    title: `Contenu mappé vers ${row.target}`,
    description: `Ajouté à l'onglet ${tab}.`,
    icon: "i-lucide-check",
    color: "success",
  });
}

/** Enumeration fields, so a constant can be picked from the allowed values, not typed. */
const enumOptions = computed<Record<string, string[]>>(() =>
  Object.fromEntries(
    (targetSchema.value?.fields ?? [])
      .filter((f) => (f.options ?? []).length > 0)
      .map((f) => [f.name, f.options as string[]]),
  ),
);

function sampleFor(path: string | undefined) {
  if (!path) return undefined;
  return sourceFields.value.find((f) => f.path === path)?.sample;
}

async function discover() {
  discovering.value = true;
  sourceFields.value = [];
  targetSchema.value = null;
  const { restBase, uid, pluralPath } = endpoints.value;
  const [wp, strapi] = await Promise.allSettled([
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

  if (wp.status === "fulfilled") {
    sourceFields.value = wp.value.fields;
    toast.add({
      title: `${wp.value.fields.length} champs WordPress lus`,
      icon: "i-lucide-check",
      color: "success",
    });
  } else {
    toast.add({
      title: "Champs WordPress illisibles",
      description: String(wp.reason),
      icon: "i-lucide-triangle-alert",
      color: "error",
    });
  }

  if (strapi.status === "fulfilled" && strapi.value) targetSchema.value = strapi.value;
  else if (strapi.status === "rejected") {
    toast.add({
      title: "Champs Strapi illisibles",
      description: String(strapi.reason),
      icon: "i-lucide-triangle-alert",
      color: "warning",
    });
  } else if (!endpoints.value.uid || !config.value.strapi.token) {
    toast.add({
      title: "Côté Strapi non interrogé",
      description: "Renseignez l'URL, le token et l'UID pour lister les champs de destination.",
      icon: "i-lucide-info",
      color: "warning",
    });
  }
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
</script>

<template>
  <UCard>
    <template #header>
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 class="font-semibold text-highlighted">Mapping des champs</h2>
          <p class="text-sm text-muted mt-0.5">
            Chaque ligne écrit un champ Strapi, depuis un champ WordPress ou une valeur fixe.
          </p>
        </div>
        <div class="flex items-center gap-2">
          <UButton
            color="neutral"
            variant="subtle"
            icon="i-lucide-eye"
            :loading="previewing"
            :disabled="!config.wp.baseUrl || issues.length > 0"
            @click="runPreview"
          >
            Aperçu
          </UButton>
          <UButton
            color="neutral"
            variant="subtle"
            icon="i-lucide-refresh-cw"
            :loading="discovering"
            :disabled="!config.wp.baseUrl"
            @click="discover"
          >
            Lire les champs
          </UButton>
        </div>
      </div>
    </template>

    <div class="space-y-4">
      <UTabs
        v-model="active"
        :items="tabs"
        variant="link"
        size="sm"
        :content="false"
        class="w-full"
      />

      <UAlert
        v-if="active === 'common'"
        icon="i-lucide-info"
        color="info"
        variant="subtle"
        title="Champs communs"
        description="Appliqués à tous les imports. Un champ redéfini dans un onglet spécifique l'emporte ici."
      />

      <div v-if="structuredFields.length > 0" class="rounded-md border border-default p-3 space-y-2">
        <p class="text-sm font-medium text-highlighted">
          Champs structurés détectés
        </p>
        <p class="text-xs text-muted">
          Ces champs attendent un composant, pas une valeur simple. Le bouton écrit la bonne
          forme — un chemin comme <code>contenu.body</code>, ou une zone dynamique.
        </p>
        <div
          v-for="f in structuredFields"
          :key="f.name"
          class="flex flex-wrap items-center justify-between gap-2"
        >
          <div class="text-xs">
            <span class="font-mono text-toned">{{ f.name }}</span>
            <UBadge color="neutral" variant="subtle" size="sm" class="ml-2">
              {{ f.type === "dynamiczone" ? "zone dynamique" : f.repeatable ? "composant répétable" : "composant" }}
            </UBadge>
            <span class="text-dimmed ml-2">
              {{ f.component ?? (f.components ?? []).join(", ") }}
            </span>
          </div>
          <UButton size="xs" color="neutral" variant="subtle" icon="i-lucide-wand-sparkles" @click="mapContentInto(f)">
            Y mapper le contenu
          </UButton>
        </div>
      </div>

      <UAlert
        v-if="targetSchema && targetSchema.source !== 'schema'"
        icon="i-lucide-triangle-alert"
        color="warning"
        variant="subtle"
        title="Champs Strapi partiels"
        :description="targetSchema.note"
      />

      <div class="space-y-2">
        <div class="hidden lg:grid grid-cols-12 gap-2 text-xs font-medium text-dimmed px-1">
          <div class="col-span-3">Champ Strapi</div>
          <div class="col-span-2">Origine</div>
          <div class="col-span-3">Source / valeur</div>
          <div class="col-span-3">Transformations</div>
          <div class="col-span-1" />
        </div>

        <div
          v-for="(row, i) in rows"
          :key="i"
          class="grid grid-cols-1 lg:grid-cols-12 gap-2 items-center"
        >
          <USelectMenu
            :model-value="row.target"
            :items="targetNames"
            create-item="always"
            :search-input="{ placeholder: 'Filtrer ou saisir…' }"
            placeholder="champ Strapi"
            class="lg:col-span-3 w-full"
            @update:model-value="(v: string) => patchRow(i, { target: v })"
            @create="(v: string) => patchRow(i, { target: v })"
          />

          <USelect
            :model-value="row.source !== undefined ? 'source' : 'value'"
            :items="[
              { value: 'source', label: 'Champ WP' },
              { value: 'value', label: 'Valeur fixe' },
            ]"
            value-key="value"
            class="lg:col-span-2 w-full"
            @update:model-value="(v: string) => setMode(i, v as 'source' | 'value')"
          />

          <div v-if="row.source !== undefined" class="lg:col-span-3">
            <USelectMenu
              :model-value="row.source"
              :items="sourcePaths"
              create-item="always"
              :search-input="{ placeholder: 'title.rendered, acf.…' }"
              placeholder="champ WordPress"
              class="w-full"
              @update:model-value="(v: string) => patchRow(i, { source: v })"
              @create="(v: string) => patchRow(i, { source: v })"
            />
            <p v-if="sampleFor(row.source)" class="text-xs text-dimmed mt-1 truncate">
              {{ sampleFor(row.source) }}
            </p>
          </div>
          <USelectMenu
            v-else-if="enumOptions[row.target]"
            :model-value="String(row.value ?? '')"
            :items="enumOptions[row.target]"
            create-item="always"
            placeholder="valeur"
            class="lg:col-span-3 w-full"
            @update:model-value="(v: string) => patchRow(i, { value: v })"
            @create="(v: string) => patchRow(i, { value: v })"
          />
          <UInput
            v-else
            :model-value="String(row.value ?? '')"
            placeholder="fr"
            class="lg:col-span-3 w-full"
            @update:model-value="(v: string | number) => patchRow(i, { value: String(v) })"
          />

          <UInputTags
            :model-value="row.transforms ?? []"
            :items="transformNames"
            placeholder="decodeEntities…"
            class="lg:col-span-3 w-full"
            @update:model-value="(v: string[]) => patchRow(i, { transforms: v.length ? v : undefined })"
          />

          <div class="lg:col-span-1 flex items-center justify-end gap-1">
            <UTooltip text="Ne pas écrire le champ si la valeur est vide">
              <UCheckbox
                :model-value="row.omitEmpty === true"
                @update:model-value="(v: boolean | 'indeterminate') => patchRow(i, { omitEmpty: v === true || undefined })"
              />
            </UTooltip>
            <UButton
              color="error"
              variant="ghost"
              size="xs"
              icon="i-lucide-trash-2"
              :aria-label="`Supprimer ${row.target || 'la ligne'}`"
              @click="removeRow(i)"
            />
          </div>
        </div>

        <p v-if="rows.length === 0" class="text-sm text-muted py-2">
          Aucun champ commun. Ajoutez-en un pour l'appliquer à tous les imports.
        </p>
      </div>

      <div class="flex items-center gap-2">
        <UButton size="sm" icon="i-lucide-plus" @click="addRow">Ajouter un champ</UButton>
        <UButton size="sm" color="neutral" variant="ghost" icon="i-lucide-rotate-ccw" @click="resetToDefault">
          {{ active === "common" ? "Tout retirer" : "Mapping par défaut" }}
        </UButton>
        <UBadge v-if="sourceFields.length" color="neutral" variant="subtle" class="ml-auto">
          {{ sourceFields.length }} champs WP lus
        </UBadge>
      </div>

      <UAlert
        v-if="unknownTargets.length > 0"
        color="warning"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        title="Champs absents du content-type"
        :description="`${unknownTargets.join(', ')} — Strapi refusera ces attributs. Choisissez-les dans la liste ou retirez les lignes.`"
      />

      <UAlert
        v-if="issues.length > 0"
        color="error"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        title="Mapping invalide"
        :description="issues.map((i) => `${i.target || '(sans nom)'} : ${i.message}`).join(' · ')"
      />

      <template v-if="previewError || preview">
        <USeparator label="Aperçu" />
        <UAlert
          v-if="previewError"
          color="error"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          title="Aperçu impossible"
          :description="previewError"
        />
        <div v-else-if="preview" class="space-y-3">
          <p class="text-sm text-muted">Ce qui serait écrit dans Strapi — rien n'est envoyé.</p>
          <div v-for="item in preview" :key="item.wpId" class="space-y-1">
            <div class="flex items-center gap-2 text-xs text-dimmed font-mono">
              <UBadge color="neutral" variant="subtle" size="sm">#{{ item.wpId }}</UBadge>
              <span class="truncate">{{ item.slug }} → {{ item.uid }}</span>
            </div>
            <pre class="text-xs bg-elevated rounded-md p-3 overflow-x-auto">{{ JSON.stringify(item.data, null, 2) }}</pre>
            <p v-for="(w, wi) in item.warnings" :key="wi" class="text-xs text-warning">⚠ {{ w }}</p>
          </div>
          <p v-if="preview.length === 0" class="text-sm text-muted">
            Rien à prévisualiser pour ce type de contenu.
          </p>
        </div>
      </template>
    </div>
  </UCard>
</template>
