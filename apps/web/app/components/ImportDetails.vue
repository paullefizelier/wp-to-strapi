<script setup lang="ts">
import { h, resolveComponent } from "vue";
import type { ItemDetails, Kind } from "@paullefizelier/wp-to-strapi-core";
import type { TableColumn, TabsItem } from "@nuxt/ui";
import { noticeText } from "~/utils/notices";

export interface ImportRow {
  /** `${kind}:${wpId}` — a retried entry replaces its earlier row. */
  key: string;
  /** Arrival order, so the table can list the latest first. */
  seq: number;
  kind: Kind;
  wpId: number;
  outcome: "ok" | "skip" | "error";
  detail?: string;
  reason?: string;
  message?: string;
  item?: ItemDetails;
}

const props = defineProps<{
  rows: ImportRow[];
  kindLabels: Record<string, string>;
  strapiBaseUrl?: string;
}>();

const UBadge = resolveComponent("UBadge");
const UButton = resolveComponent("UButton");

const PAGE_SIZE = 50;

type Filter = "all" | "written" | "dry-run" | "skip" | "error";
const filter = ref<Filter>("all");
const kindFilter = ref<string>("all");
const search = ref("");
const page = ref(1);
const selected = ref<ImportRow | null>(null);
const open = computed({
  get: () => selected.value !== null,
  set: (v: boolean) => {
    if (!v) selected.value = null;
  },
});

const WP_STATUS: Record<string, string> = {
  publish: "Publié",
  draft: "Brouillon",
  future: "Programmé",
  pending: "En attente de relecture",
  private: "Privé",
  inherit: "Hérité",
};

/** What happened, in one word, with the badge colour that goes with it. */
function outcomeOf(row: ImportRow): { label: string; color: string; icon: string } {
  if (row.outcome === "error") return { label: "Erreur", color: "error", icon: "i-lucide-x" };
  if (row.outcome === "skip") return { label: "Ignoré", color: "neutral", icon: "i-lucide-minus" };
  switch (row.item?.action) {
    case "created":
      return { label: "Créé", color: "success", icon: "i-lucide-plus" };
    case "updated":
      return { label: "Mis à jour", color: "info", icon: "i-lucide-refresh-cw" };
    case "uploaded":
      return { label: "Importé", color: "success", icon: "i-lucide-upload" };
    case "dry-run":
      return { label: "Simulé", color: "warning", icon: "i-lucide-flask-conical" };
    default:
      return { label: "Écrit", color: "success", icon: "i-lucide-check" };
  }
}

function reasonText(reason?: string): string {
  if (!reason) return "";
  if (reason === "already migrated") return "Déjà migré lors d'un run précédent";
  if (reason === "no source_url") return "Le média n'a pas d'URL de fichier";
  if (reason === "no route matches") return "Aucune route ne correspond à ses catégories";
  const orphan = /^entry (\d+) not migrated$/.exec(reason);
  if (orphan) return `L'entrée WordPress #${orphan[1]} qu'il commente n'a pas été migrée`;
  return reason;
}

function humanBytes(n?: number): string {
  if (n === undefined) return "";
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} Ko`;
  return `${(n / 1024 / 1024).toFixed(1)} Mo`;
}

function strapiRoot(): string {
  return (props.strapiBaseUrl ?? "").replace(/\/+$/, "");
}

/** Where to see the entry in Strapi: its edit screen, or the file itself for media. */
function strapiLink(row: ImportRow): string | undefined {
  const it = row.item;
  if (!it || it.action === "dry-run") return undefined;
  if (it.url) return it.url.startsWith("http") ? it.url : `${strapiRoot()}${it.url}`;
  if (it.documentId && it.target && strapiRoot()) {
    return `${strapiRoot()}/admin/content-manager/collection-types/${it.target}/${it.documentId}`;
  }
  return undefined;
}

const writtenCount = (rows: ImportRow[]) =>
  rows.filter((r) => r.outcome === "ok" && r.item?.action !== "dry-run").length;

const byKind = computed(() =>
  kindFilter.value === "all" ? props.rows : props.rows.filter((r) => r.kind === kindFilter.value),
);

const counts = computed(() => ({
  all: byKind.value.length,
  written: writtenCount(byKind.value),
  "dry-run": byKind.value.filter((r) => r.outcome === "ok" && r.item?.action === "dry-run").length,
  skip: byKind.value.filter((r) => r.outcome === "skip").length,
  error: byKind.value.filter((r) => r.outcome === "error").length,
}));

const tabs = computed<TabsItem[]>(() =>
  (
    [
      { value: "all", label: "Tout", icon: "i-lucide-list" },
      { value: "written", label: "Écrits", icon: "i-lucide-check" },
      { value: "dry-run", label: "Simulés", icon: "i-lucide-flask-conical" },
      { value: "skip", label: "Ignorés", icon: "i-lucide-minus" },
      { value: "error", label: "Erreurs", icon: "i-lucide-x" },
    ] as const
  )
    .filter((t) => t.value === "all" || counts.value[t.value] > 0 || filter.value === t.value)
    .map((t) => ({ ...t, label: `${t.label} (${counts.value[t.value]})` })),
);

const kindItems = computed(() => [
  { label: "Tous les types", value: "all" },
  ...[...new Set(props.rows.map((r) => r.kind))].map((k) => ({
    label: props.kindLabels[k] ?? k,
    value: k,
  })),
]);

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  return byKind.value
    .filter((r) => {
      if (filter.value === "written") return r.outcome === "ok" && r.item?.action !== "dry-run";
      if (filter.value === "dry-run") return r.outcome === "ok" && r.item?.action === "dry-run";
      if (filter.value === "skip") return r.outcome === "skip";
      if (filter.value === "error") return r.outcome === "error";
      return true;
    })
    .filter((r) => {
      if (!q) return true;
      const it = r.item;
      return [String(r.wpId), it?.title, it?.slug, it?.target, it?.route, r.message, r.reason, r.detail]
        .some((v) => v?.toLowerCase().includes(q));
    })
    .sort((a, b) => b.seq - a.seq);
});

watch([filter, kindFilter, search], () => (page.value = 1));

const pageRows = computed(() =>
  filtered.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE),
);

const columns: TableColumn<ImportRow>[] = [
  {
    id: "outcome",
    header: "Résultat",
    cell: ({ row }) => {
      const o = outcomeOf(row.original);
      return h(UBadge, { color: o.color, variant: "subtle", icon: o.icon, size: "sm" }, () => o.label);
    },
  },
  {
    id: "kind",
    header: "Type",
    cell: ({ row }) => props.kindLabels[row.original.kind] ?? row.original.kind,
  },
  {
    id: "title",
    header: "Entrée WordPress",
    cell: ({ row }) => {
      const r = row.original;
      const title = r.item?.title || r.item?.slug || r.detail || `#${r.wpId}`;
      const sub = [`#${r.wpId}`, r.item?.slug && r.item.slug !== title ? r.item.slug : null]
        .filter(Boolean)
        .join(" · ");
      return h("div", { class: "min-w-0 max-w-sm" }, [
        h("p", { class: "truncate text-highlighted font-medium" }, title),
        h("p", { class: "truncate text-xs text-dimmed font-mono" }, sub),
      ]);
    },
  },
  {
    id: "target",
    header: "Destination",
    cell: ({ row }) => {
      const r = row.original;
      if (r.outcome === "error") {
        return h("p", { class: "text-xs text-error max-w-xs truncate" }, r.message);
      }
      if (r.outcome === "skip") {
        return h("p", { class: "text-xs text-muted max-w-xs truncate" }, reasonText(r.reason));
      }
      const it = r.item;
      if (!it) return h("span", { class: "text-xs text-muted font-mono" }, r.detail);
      const parts: ReturnType<typeof h>[] = [];
      if (it.target === "upload") {
        parts.push(
          h("span", { class: "text-xs text-muted" }, [humanBytes(it.size), it.mime].filter(Boolean).join(" · ")),
        );
      } else if (it.target) {
        parts.push(h("span", { class: "text-xs font-mono text-toned" }, it.target));
      }
      if (it.route) {
        parts.push(h(UBadge, { color: "primary", variant: "outline", size: "sm" }, () => it.route));
      }
      if (it.status === "draft") {
        parts.push(h(UBadge, { color: "neutral", variant: "outline", size: "sm" }, () => "brouillon"));
      }
      if (it.notices?.length) {
        parts.push(
          h(UBadge, { color: "warning", variant: "subtle", size: "sm", icon: "i-lucide-triangle-alert" }, () =>
            String(it.notices!.length),
          ),
        );
      }
      return h("div", { class: "flex flex-wrap items-center gap-1.5" }, parts);
    },
  },
  {
    id: "open",
    header: "",
    cell: ({ row }) =>
      h(UButton, {
        icon: "i-lucide-panel-right-open",
        color: "neutral",
        variant: "ghost",
        size: "xs",
        "aria-label": "Voir le détail",
        onClick: (e: Event) => {
          e.stopPropagation();
          selected.value = row.original;
        },
      }),
  },
];

function onSelect(_e: Event, row: { original: ImportRow }) {
  selected.value = row.original;
}

// ----- Export -----

const CSV_COLUMNS = [
  "type", "wpId", "résultat", "titre", "slug", "source", "statut WP", "destination", "route",
  "statut Strapi", "documentId", "fichier", "taille", "mime", "alertes", "message",
] as const;

function csvCell(v: unknown): string {
  const s = v === undefined || v === null ? "" : String(v);
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function download(name: string, type: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function stamp() {
  return new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
}

function exportCsv() {
  const lines = filtered.value.map((r) => {
    const it = r.item ?? {};
    return [
      props.kindLabels[r.kind] ?? r.kind,
      r.wpId,
      outcomeOf(r).label,
      it.title,
      it.slug,
      it.source,
      it.wpStatus,
      it.target,
      it.route,
      it.status,
      it.documentId,
      it.url,
      it.size,
      it.mime,
      (it.notices ?? []).map((n) => noticeText(n.code, n.params, n.message)).join(" | "),
      r.message ?? reasonText(r.reason),
    ]
      .map(csvCell)
      .join(";");
  });
  // BOM + semicolons: what Excel expects from a French locale.
  download(
    `imports-${stamp()}.csv`,
    "text/csv;charset=utf-8",
    `﻿${[CSV_COLUMNS.join(";"), ...lines].join("\r\n")}`,
  );
}

function exportJson() {
  download(`imports-${stamp()}.json`, "application/json", JSON.stringify(filtered.value, null, 2));
}
</script>

<template>
  <UCard>
    <template #header>
      <div class="space-y-3">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 class="font-semibold text-highlighted">Détail des imports</h2>
            <p class="text-sm text-muted mt-0.5">
              Chaque entrée, d'où elle vient et ce qu'elle est devenue. Cliquez une ligne pour tout voir.
            </p>
          </div>
          <div class="flex gap-2">
            <UButton
              icon="i-lucide-file-spreadsheet"
              color="neutral"
              variant="subtle"
              size="sm"
              :disabled="filtered.length === 0"
              @click="exportCsv"
            >
              CSV
            </UButton>
            <UButton
              icon="i-lucide-braces"
              color="neutral"
              variant="subtle"
              size="sm"
              :disabled="filtered.length === 0"
              @click="exportJson"
            >
              JSON
            </UButton>
          </div>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <UInput
            v-model="search"
            icon="i-lucide-search"
            placeholder="Titre, slug, id, content-type, erreur…"
            size="sm"
            class="w-full sm:w-72"
          />
          <USelect v-model="kindFilter" :items="kindItems" size="sm" class="w-full sm:w-48" />
          <UTabs v-model="filter" :items="tabs" :content="false" size="xs" variant="pill" />
        </div>
      </div>
    </template>

    <UTable
      :data="pageRows"
      :columns="columns"
      :empty="rows.length === 0 ? 'Les entrées apparaîtront ici au fil de la migration.' : 'Aucune entrée ne correspond aux filtres.'"
      class="cursor-pointer"
      @select="onSelect"
    />

    <div v-if="filtered.length > PAGE_SIZE" class="flex items-center justify-between pt-3">
      <span class="text-xs text-muted tabular-nums">
        {{ (page - 1) * PAGE_SIZE + 1 }}–{{ Math.min(page * PAGE_SIZE, filtered.length) }} sur {{ filtered.length }}
      </span>
      <UPagination v-model:page="page" :total="filtered.length" :items-per-page="PAGE_SIZE" size="sm" />
    </div>

    <USlideover
      v-model:open="open"
      :title="selected?.item?.title || selected?.item?.slug || (selected ? `#${selected.wpId}` : '')"
      :description="selected ? `${kindLabels[selected.kind] ?? selected.kind} · WordPress #${selected.wpId}` : ''"
    >
      <template #body>
        <div v-if="selected" class="space-y-6 text-sm">
          <div class="flex flex-wrap items-center gap-2">
            <UBadge
              :color="outcomeOf(selected).color as never"
              variant="subtle"
              :icon="outcomeOf(selected).icon"
            >
              {{ outcomeOf(selected).label }}
            </UBadge>
            <UBadge v-if="selected.item?.route" color="primary" variant="outline">
              route {{ selected.item.route }}
            </UBadge>
          </div>

          <UAlert
            v-if="selected.outcome === 'error'"
            color="error"
            variant="subtle"
            icon="i-lucide-circle-x"
            title="Erreur"
            :description="selected.message"
          />
          <UAlert
            v-else-if="selected.outcome === 'skip'"
            color="neutral"
            variant="subtle"
            icon="i-lucide-minus"
            title="Ignoré"
            :description="reasonText(selected.reason)"
          />
          <UAlert
            v-else-if="selected.item?.action === 'dry-run'"
            color="warning"
            variant="subtle"
            icon="i-lucide-flask-conical"
            title="Dry-run : rien n'a été écrit"
            description="Voici ce qui serait envoyé à Strapi."
          />

          <section class="space-y-2">
            <h3 class="text-xs font-semibold uppercase tracking-wide text-dimmed">WordPress</h3>
            <dl class="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1.5">
              <dt class="text-muted">Id</dt>
              <dd class="font-mono">{{ selected.wpId }}</dd>
              <template v-if="selected.item?.slug">
                <dt class="text-muted">Slug</dt>
                <dd class="font-mono break-all">{{ selected.item.slug }}</dd>
              </template>
              <template v-if="selected.item?.wpStatus">
                <dt class="text-muted">Statut</dt>
                <dd>{{ WP_STATUS[selected.item.wpStatus] ?? selected.item.wpStatus }}</dd>
              </template>
              <template v-if="selected.item?.source">
                <dt class="text-muted">Adresse</dt>
                <dd class="break-all">
                  <ULink :to="selected.item.source" target="_blank" class="text-primary">
                    {{ selected.item.source }}
                  </ULink>
                </dd>
              </template>
            </dl>
          </section>

          <section v-if="selected.item?.target" class="space-y-2">
            <h3 class="text-xs font-semibold uppercase tracking-wide text-dimmed">Strapi</h3>
            <dl class="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1.5">
              <dt class="text-muted">Destination</dt>
              <dd class="font-mono break-all">
                {{ selected.item.target === "upload" ? "Médiathèque" : selected.item.target }}
              </dd>
              <template v-if="selected.item.status">
                <dt class="text-muted">Statut</dt>
                <dd>{{ selected.item.status === "published" ? "Publié" : "Brouillon" }}</dd>
              </template>
              <template v-if="selected.item.documentId">
                <dt class="text-muted">documentId</dt>
                <dd class="font-mono break-all">{{ selected.item.documentId }}</dd>
              </template>
              <template v-if="selected.item.mediaId !== undefined">
                <dt class="text-muted">Id du fichier</dt>
                <dd class="font-mono">{{ selected.item.mediaId }}</dd>
              </template>
              <template v-if="selected.item.size !== undefined || selected.item.mime">
                <dt class="text-muted">Fichier</dt>
                <dd>{{ [humanBytes(selected.item.size), selected.item.mime].filter(Boolean).join(" · ") }}</dd>
              </template>
            </dl>
            <UButton
              v-if="strapiLink(selected)"
              :to="strapiLink(selected)"
              target="_blank"
              icon="i-lucide-external-link"
              size="sm"
              color="neutral"
              variant="subtle"
            >
              {{ selected.item.url ? "Ouvrir le fichier" : "Ouvrir dans Strapi" }}
            </UButton>
          </section>

          <section v-if="selected.item?.notices?.length" class="space-y-2">
            <h3 class="text-xs font-semibold uppercase tracking-wide text-dimmed">Alertes</h3>
            <ul class="space-y-1.5">
              <li
                v-for="(n, i) in selected.item.notices"
                :key="i"
                class="flex gap-2"
                :class="n.level === 'error' ? 'text-error' : n.level === 'info' ? 'text-muted' : 'text-warning'"
              >
                <UIcon name="i-lucide-triangle-alert" class="size-4 shrink-0 mt-0.5" />
                <span>{{ noticeText(n.code, n.params, n.message) }}</span>
              </li>
            </ul>
          </section>

          <section v-if="selected.item?.values && Object.keys(selected.item.values).length" class="space-y-2">
            <h3 class="text-xs font-semibold uppercase tracking-wide text-dimmed">
              Champs {{ selected.item.action === "dry-run" ? "qui seraient écrits" : "écrits" }}
            </h3>
            <div class="rounded-md border border-default divide-y divide-default">
              <div
                v-for="(value, field) in selected.item.values"
                :key="field"
                class="grid grid-cols-[8rem_1fr] gap-3 px-3 py-2"
              >
                <span class="font-mono text-xs text-muted break-all">{{ field }}</span>
                <span class="text-xs break-words" :class="value ? 'text-toned' : 'text-dimmed italic'">
                  {{ value || "vide" }}
                </span>
              </div>
            </div>
          </section>
        </div>
      </template>
    </USlideover>
  </UCard>
</template>
