<script setup lang="ts">
import { h, resolveComponent } from "vue";
import type { CatalogueEntry, PreviewItem } from "@paullefizelier/wp-to-strapi-core";
import type { TableColumn, TabsItem } from "@nuxt/ui";
import { noticeText } from "~/utils/notices";

const { config } = useMigrationConfig();

const UBadge = resolveComponent("UBadge");
const UButton = resolveComponent("UButton");
const UCheckbox = resolveComponent("UCheckbox");

const PAGE_SIZE = 50;
const ANY = "__any__";
const SKIPPED = "__skipped__";

/** `posts`, `pages` or `custom:<restBase>` — the same keys the engine scopes by. */
type SourceKey = string;

const sources = computed<TabsItem[]>(() => [
  { value: "posts", label: "Articles", icon: "i-lucide-newspaper" },
  { value: "pages", label: "Pages", icon: "i-lucide-file-text" },
  ...config.value.customTypes.map((t) => ({
    value: `custom:${t.restBase}`,
    label: t.restBase,
    icon: "i-lucide-shapes",
  })),
]);
const source = ref<SourceKey>("posts");

const lists = ref<Record<SourceKey, CatalogueEntry[]>>({});
const loading = ref(false);
const loadError = ref<string | null>(null);

const STATUS: Record<string, { label: string; color: string }> = {
  publish: { label: "Publié", color: "success" },
  draft: { label: "Brouillon", color: "neutral" },
  future: { label: "Programmé", color: "info" },
  pending: { label: "En relecture", color: "warning" },
  private: { label: "Privé", color: "neutral" },
};

function errorText(err: unknown): string {
  const e = err as { statusMessage?: string; data?: { statusMessage?: string }; message?: string };
  return e.data?.statusMessage ?? e.statusMessage ?? e.message ?? String(err);
}

/** The body every call sends: the live config, with a placeholder token if none yet. */
function body(extra: Record<string, unknown>) {
  return {
    ...config.value,
    strapi: { ...config.value.strapi, token: config.value.strapi.token || "preview" },
    ...extra,
  };
}

function kindOf(key: SourceKey): { kind: "posts" | "pages" | "custom"; restBase?: string } {
  if (key.startsWith("custom:")) return { kind: "custom", restBase: key.slice("custom:".length) };
  return { kind: key as "posts" | "pages" };
}

async function load(force = false) {
  const key = source.value;
  if (!force && lists.value[key]) return;
  loading.value = true;
  loadError.value = null;
  try {
    const res = await $fetch<{ entries: CatalogueEntry[] }>("/api/catalogue", {
      method: "POST",
      body: body(kindOf(key)),
    });
    lists.value = { ...lists.value, [key]: res.entries };
  } catch (err) {
    loadError.value = errorText(err);
  } finally {
    loading.value = false;
  }
}

watch(source, () => {
  page.value = 1;
  void load();
});
onMounted(() => void load());

const entries = computed(() => lists.value[source.value] ?? []);

// ----- Selection: undefined in the config = everything, as the engine reads it -----

function getSelection(key: SourceKey): number[] | undefined {
  const sel = config.value.selection ?? {};
  if (key === "posts") return sel.posts;
  if (key === "pages") return sel.pages;
  return sel.custom?.[key.slice("custom:".length)];
}

function setSelection(key: SourceKey, ids: number[] | undefined) {
  const sel = { ...(config.value.selection ?? {}) };
  if (key === "posts" || key === "pages") {
    if (ids === undefined) delete sel[key];
    else sel[key] = ids;
  } else {
    const restBase = key.slice("custom:".length);
    const custom = { ...(sel.custom ?? {}) };
    if (ids === undefined) delete custom[restBase];
    else custom[restBase] = ids;
    sel.custom = custom;
  }
  config.value.selection = sel;
}

const selectedSet = computed(() => {
  const ids = getSelection(source.value);
  return ids === undefined ? null : new Set(ids);
});

function isSelected(id: number): boolean {
  return selectedSet.value === null || selectedSet.value.has(id);
}

/**
 * Write a new set of chosen ids; choosing every entry goes back to "everything". Entries the
 * routing skips are left out: they would not be imported anyway, and counting them would
 * overstate the selection.
 */
function commit(next: Set<number>) {
  const routable = entries.value.filter((e) => e.uid !== null);
  const everything = routable.every((e) => next.has(e.wpId));
  const skipped = new Set(entries.value.filter((e) => e.uid === null).map((e) => e.wpId));
  const ids = [...next].filter((id) => !skipped.has(id)).sort((a, b) => a - b);
  setSelection(source.value, everything ? undefined : ids);
}

function currentSet(): Set<number> {
  return selectedSet.value ? new Set(selectedSet.value) : new Set(entries.value.map((e) => e.wpId));
}

function toggle(id: number, on: boolean) {
  const next = currentSet();
  if (on) next.add(id);
  else next.delete(id);
  commit(next);
}

function setMany(ids: number[], on: boolean) {
  const next = currentSet();
  for (const id of ids) {
    if (on) next.add(id);
    else next.delete(id);
  }
  commit(next);
}

/** Routing skips it whatever the checkbox says, so it never counts as imported. */
function willImport(e: CatalogueEntry): boolean {
  return e.uid !== null && isSelected(e.wpId);
}

const selectedCount = computed(() => entries.value.filter(willImport).length);
const routedOutCount = computed(() => entries.value.filter((e) => e.uid === null).length);
/** Ids chosen earlier that WordPress no longer lists (deleted, or a status now filtered out). */
const staleCount = computed(() => {
  if (!selectedSet.value) return 0;
  const listed = new Set(entries.value.map((e) => e.wpId));
  return [...selectedSet.value].filter((id) => !listed.has(id)).length;
});

// ----- Filters -----

const search = ref("");
const statusFilter = ref(ANY);
const targetFilter = ref(ANY);
const categoryFilter = ref(ANY);
const onlyFilter = ref<"all" | "selected" | "unselected">("all");
const page = ref(1);

function targetKey(e: CatalogueEntry): string {
  return e.uid === null ? SKIPPED : e.route ? `route:${e.route}` : e.uid;
}

const statusItems = computed(() => [
  { label: "Tous les statuts", value: ANY },
  ...[...new Set(entries.value.map((e) => e.status))].map((s) => ({
    label: STATUS[s]?.label ?? s,
    value: s,
  })),
]);
const targetItems = computed(() => {
  const seen = new Map<string, string>();
  for (const e of entries.value) {
    const key = targetKey(e);
    if (!seen.has(key)) {
      seen.set(key, e.uid === null ? "Ignoré par le routage" : e.route ? `${e.route} (${e.uid})` : e.uid);
    }
  }
  return [{ label: "Toutes les destinations", value: ANY }, ...[...seen].map(([value, label]) => ({ label, value }))];
});
const categoryItems = computed(() => [
  { label: "Toutes les catégories", value: ANY },
  ...[...new Set(entries.value.flatMap((e) => e.categories))]
    .sort((a, b) => a.localeCompare(b, "fr"))
    .map((c) => ({ label: c, value: c })),
]);
const hasCategories = computed(() => categoryItems.value.length > 1);

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  return entries.value.filter((e) => {
    if (statusFilter.value !== ANY && e.status !== statusFilter.value) return false;
    if (targetFilter.value !== ANY && targetKey(e) !== targetFilter.value) return false;
    if (categoryFilter.value !== ANY && !e.categories.includes(categoryFilter.value)) return false;
    if (onlyFilter.value === "selected" && !willImport(e)) return false;
    if (onlyFilter.value === "unselected" && willImport(e)) return false;
    if (!q) return true;
    return [String(e.wpId), e.title, e.slug, ...e.categories].some((v) => v.toLowerCase().includes(q));
  });
});

watch([search, statusFilter, targetFilter, categoryFilter, onlyFilter], () => (page.value = 1));

const pageRows = computed(() =>
  filtered.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE),
);

const onlyTabs = computed<TabsItem[]>(() => [
  { value: "all", label: `Toutes (${entries.value.length})` },
  { value: "selected", label: `Importées (${selectedCount.value})` },
  { value: "unselected", label: `Exclues (${entries.value.length - selectedCount.value})` },
]);

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("fr-FR");
}

const columns: TableColumn<CatalogueEntry>[] = [
  {
    id: "select",
    header: "",
    cell: ({ row }) =>
      h(UCheckbox, {
        modelValue: willImport(row.original),
        disabled: row.original.uid === null,
        "onUpdate:modelValue": (v: boolean | "indeterminate") => toggle(row.original.wpId, v === true),
        onClick: (e: Event) => e.stopPropagation(),
        "aria-label": "Importer cette entrée",
      }),
  },
  {
    id: "title",
    header: "Entrée",
    cell: ({ row }) => {
      const e = row.original;
      return h("div", { class: ["min-w-0 max-w-md", willImport(e) ? "" : "opacity-50"] }, [
        h("p", { class: "truncate font-medium text-highlighted" }, e.title),
        h("p", { class: "truncate text-xs text-dimmed font-mono" }, `#${e.wpId} · ${e.slug}`),
      ]);
    },
  },
  {
    id: "status",
    header: "Statut",
    cell: ({ row }) => {
      const s = STATUS[row.original.status] ?? { label: row.original.status, color: "neutral" };
      return h(UBadge, { color: s.color, variant: "subtle", size: "sm" }, () => s.label);
    },
  },
  {
    id: "date",
    header: "Date",
    cell: ({ row }) => h("span", { class: "text-xs text-muted tabular-nums" }, formatDate(row.original.date)),
  },
  {
    id: "categories",
    header: "Catégories",
    cell: ({ row }) => {
      const cats = row.original.categories;
      if (cats.length === 0) return h("span", { class: "text-xs text-dimmed" }, "—");
      const shown = cats.slice(0, 2).join(", ");
      return h("span", { class: "text-xs text-toned", title: cats.join(", ") }, cats.length > 2 ? `${shown} +${cats.length - 2}` : shown);
    },
  },
  {
    id: "target",
    header: "Destination",
    cell: ({ row }) => {
      const e = row.original;
      if (e.uid === null) {
        return h(UBadge, { color: "neutral", variant: "outline", size: "sm" }, () => "ignoré (routage)");
      }
      return h("div", { class: "flex flex-wrap items-center gap-1.5" }, [
        ...(e.route ? [h(UBadge, { color: "primary", variant: "outline", size: "sm" }, () => e.route)] : []),
        h("span", { class: "text-xs font-mono text-muted" }, e.uid),
      ]);
    },
  },
  {
    id: "preview",
    header: "",
    cell: ({ row }) =>
      h(
        UButton,
        {
          icon: "i-lucide-eye",
          color: "neutral",
          variant: "ghost",
          size: "xs",
          onClick: (ev: Event) => {
            ev.stopPropagation();
            void openPreview(row.original);
          },
        },
        () => "Mapping",
      ),
  },
];

function onSelectRow(_e: Event, row: { original: CatalogueEntry }) {
  void openPreview(row.original);
}

// ----- Mapping preview of one entry -----

const previewOf = ref<CatalogueEntry | null>(null);
const previewItem = ref<PreviewItem | null>(null);
const previewing = ref(false);
const previewError = ref<string | null>(null);
const previewOpen = computed({
  get: () => previewOf.value !== null,
  set: (v: boolean) => {
    if (!v) previewOf.value = null;
  },
});

async function openPreview(entry: CatalogueEntry) {
  previewOf.value = entry;
  previewItem.value = null;
  previewError.value = null;
  previewing.value = true;
  try {
    const res = await $fetch<{ items: PreviewItem[] }>("/api/preview", {
      method: "POST",
      body: body({ ...kindOf(source.value), ids: [entry.wpId], limit: 1 }),
    });
    if (previewOf.value?.wpId !== entry.wpId) return; // another row was opened meanwhile
    previewItem.value = res.items[0] ?? null;
    if (!previewItem.value) previewError.value = "WordPress n'a pas renvoyé cette entrée.";
  } catch (err) {
    previewError.value = errorText(err);
  } finally {
    previewing.value = false;
  }
}

/** A readable rendering of one payload value. */
function show(value: unknown): { text: string; kind: "empty" | "text" | "html" | "json" } {
  if (value === null || value === undefined || value === "") return { text: "vide", kind: "empty" };
  if (typeof value === "string") return { text: value, kind: /<[a-z][\s\S]*>/i.test(value) ? "html" : "text" };
  if (typeof value === "number" || typeof value === "boolean") return { text: String(value), kind: "text" };
  return { text: JSON.stringify(value, null, 2), kind: "json" };
}

const previewFields = computed(() =>
  Object.entries(previewItem.value?.data ?? {}).map(([field, value]) => ({ field, ...show(value) })),
);
</script>

<template>
  <UCard>
    <template #header>
      <div class="space-y-3">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 class="font-semibold text-highlighted">Choisir ce qu'on importe</h2>
            <p class="text-sm text-muted mt-0.5">
              Tout est coché par défaut. Décochez ce qui ne doit pas partir, et ouvrez une entrée
              pour vérifier exactement ce qui sera écrit dans Strapi.
            </p>
          </div>
          <UButton
            icon="i-lucide-refresh-cw"
            color="neutral"
            variant="subtle"
            size="sm"
            :loading="loading"
            @click="load(true)"
          >
            Recharger
          </UButton>
        </div>
        <UTabs v-model="source" :items="sources" :content="false" size="sm" />
      </div>
    </template>

    <UAlert
      v-if="loadError"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      title="Impossible de lister les entrées"
      :description="loadError"
      class="mb-4"
    />

    <div v-if="entries.length > 0 || loading" class="space-y-4">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <p class="text-sm">
          <span class="font-semibold text-highlighted tabular-nums">{{ selectedCount }}</span>
          <span class="text-muted"> / {{ entries.length }} seront importées</span>
          <span v-if="routedOutCount" class="text-muted">
            · {{ routedOutCount }} ignorée(s) par le routage
          </span>
          <UBadge v-if="selectedSet === null" color="success" variant="subtle" size="sm" class="ml-2">
            tout
          </UBadge>
        </p>
        <div class="flex flex-wrap gap-2">
          <UButton
            size="xs"
            color="neutral"
            variant="subtle"
            icon="i-lucide-check-check"
            :disabled="filtered.length === 0"
            @click="setMany(filtered.map((e) => e.wpId), true)"
          >
            Cocher les {{ filtered.length }} affichées
          </UButton>
          <UButton
            size="xs"
            color="neutral"
            variant="subtle"
            icon="i-lucide-square"
            :disabled="filtered.length === 0"
            @click="setMany(filtered.map((e) => e.wpId), false)"
          >
            Décocher les {{ filtered.length }} affichées
          </UButton>
          <UButton
            v-if="selectedSet !== null"
            size="xs"
            color="neutral"
            variant="ghost"
            icon="i-lucide-rotate-ccw"
            @click="setSelection(source, undefined)"
          >
            Tout importer
          </UButton>
        </div>
      </div>

      <UAlert
        v-if="selectedSet !== null"
        color="info"
        variant="subtle"
        icon="i-lucide-info"
        :title="`Sélection manuelle : seules les ${selectedCount} entrées cochées partiront.`"
        :description="`Une entrée publiée sur WordPress après ce choix ne sera pas importée.${staleCount ? ` ${staleCount} entrée(s) choisie(s) ne sont plus listées par WordPress.` : ''}`"
      />

      <div class="flex flex-wrap items-center gap-2">
        <UInput
          v-model="search"
          icon="i-lucide-search"
          placeholder="Titre, slug, id, catégorie…"
          size="sm"
          class="w-full sm:w-64"
        />
        <USelect v-model="statusFilter" :items="statusItems" size="sm" class="w-full sm:w-40" />
        <USelect
          v-if="hasCategories"
          v-model="categoryFilter"
          :items="categoryItems"
          size="sm"
          class="w-full sm:w-52"
        />
        <USelect v-model="targetFilter" :items="targetItems" size="sm" class="w-full sm:w-56" />
        <UTabs v-model="onlyFilter" :items="onlyTabs" :content="false" size="xs" variant="pill" />
      </div>

      <UTable
        :data="pageRows"
        :columns="columns"
        :loading="loading"
        empty="Aucune entrée ne correspond aux filtres."
        class="cursor-pointer"
        @select="onSelectRow"
      />

      <div v-if="filtered.length > PAGE_SIZE" class="flex items-center justify-between">
        <span class="text-xs text-muted tabular-nums">
          {{ (page - 1) * PAGE_SIZE + 1 }}–{{ Math.min(page * PAGE_SIZE, filtered.length) }} sur {{ filtered.length }}
        </span>
        <UPagination v-model:page="page" :total="filtered.length" :items-per-page="PAGE_SIZE" size="sm" />
      </div>
    </div>

    <div v-else-if="!loadError" class="py-10 text-center space-y-3">
      <UIcon name="i-lucide-list-checks" class="size-10 text-dimmed mx-auto" />
      <p class="text-sm text-muted">Aucune entrée listée pour cette source.</p>
      <UButton size="sm" icon="i-lucide-download" @click="load(true)">Charger la liste</UButton>
    </div>

    <USlideover
      v-model:open="previewOpen"
      :title="previewOf?.title ?? ''"
      :description="previewOf ? `WordPress #${previewOf.wpId} · ${previewOf.slug}` : ''"
      :ui="{ content: 'sm:max-w-2xl' }"
    >
      <template #body>
        <div v-if="previewOf" class="space-y-5 text-sm">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <UCheckbox
              :model-value="willImport(previewOf)"
              :disabled="previewOf.uid === null"
              label="Importer cette entrée"
              @update:model-value="(v: boolean | 'indeterminate') => toggle(previewOf!.wpId, v === true)"
            />
            <UButton
              v-if="previewOf.link"
              :to="previewOf.link"
              target="_blank"
              size="xs"
              color="neutral"
              variant="subtle"
              icon="i-lucide-external-link"
            >
              Voir sur WordPress
            </UButton>
          </div>

          <div v-if="previewing" class="py-10 flex justify-center">
            <UIcon name="i-lucide-loader-circle" class="size-6 animate-spin text-dimmed" />
          </div>
          <UAlert
            v-else-if="previewError"
            color="error"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            title="Aperçu impossible"
            :description="previewError"
          />
          <template v-else-if="previewItem">
            <UAlert
              v-if="previewItem.skipped"
              color="warning"
              variant="subtle"
              icon="i-lucide-route-off"
              title="Le routage ignore cette entrée"
              description="Aucune route ne correspond à ses catégories et les entrées sans route sont ignorées : elle ne partira pas, même cochée."
            />
            <div class="flex flex-wrap items-center gap-2">
              <span class="text-muted">Destination</span>
              <UBadge v-if="previewItem.route" color="primary" variant="outline">{{ previewItem.route }}</UBadge>
              <span class="font-mono text-xs">{{ previewItem.uid }}</span>
            </div>

            <ul v-if="previewItem.notices.length" class="space-y-1.5">
              <li
                v-for="(n, i) in previewItem.notices"
                :key="i"
                class="flex gap-2"
                :class="n.level === 'error' ? 'text-error' : n.level === 'info' ? 'text-muted' : 'text-warning'"
              >
                <UIcon name="i-lucide-triangle-alert" class="size-4 shrink-0 mt-0.5" />
                <span>{{ noticeText(n.code, n.params, n.message) }}</span>
              </li>
            </ul>

            <div class="space-y-2">
              <h3 class="text-xs font-semibold uppercase tracking-wide text-dimmed">
                Champs envoyés à Strapi ({{ previewFields.length }})
              </h3>
              <div class="rounded-md border border-default divide-y divide-default">
                <div v-for="f in previewFields" :key="f.field" class="px-3 py-2 space-y-1">
                  <div class="flex items-center gap-2">
                    <span class="font-mono text-xs text-highlighted">{{ f.field }}</span>
                    <UBadge v-if="f.kind === 'html'" size="sm" color="neutral" variant="outline">HTML</UBadge>
                    <UBadge v-else-if="f.kind === 'json'" size="sm" color="neutral" variant="outline">objet</UBadge>
                  </div>
                  <p v-if="f.kind === 'empty'" class="text-xs text-dimmed italic">vide</p>
                  <p v-else-if="f.kind === 'text'" class="text-xs text-toned break-words">{{ f.text }}</p>
                  <pre
                    v-else
                    class="text-xs text-toned bg-elevated rounded p-2 max-h-56 overflow-auto whitespace-pre-wrap break-all"
                  >{{ f.text }}</pre>
                </div>
              </div>
              <p class="text-xs text-dimmed">
                Pour changer un champ, revenez à l'étape Mapping : l'aperçu se recalcule à chaque ouverture.
              </p>
            </div>
          </template>
        </div>
      </template>
    </USlideover>
  </UCard>
</template>
