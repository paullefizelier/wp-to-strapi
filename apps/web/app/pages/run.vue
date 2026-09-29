<script setup lang="ts">
import type { MigratorEvent, Kind } from "@paullefizelier/wp-to-strapi-core";
import type { TabsItem } from "@nuxt/ui";
import { noticeText } from "~/utils/notices";
import type { ImportRow } from "~/components/ImportDetails.vue";

definePageMeta({ title: "Migration en cours" });

type Counter = { ok: number; skipped: number; errors: number; total: number };
const emptyCounter = (): Counter => ({ ok: 0, skipped: 0, errors: 0, total: 0 });

const KIND_LABELS: Record<Kind, string> = {
  media: "Médias",
  categories: "Catégories",
  tags: "Étiquettes",
  taxonomies: "Taxonomies",
  authors: "Auteurs",
  posts: "Articles",
  pages: "Pages",
  custom: "Types personnalisés",
  comments: "Commentaires",
  menus: "Menus",
};
const KIND_ICONS: Record<Kind, string> = {
  media: "i-lucide-image",
  categories: "i-lucide-folder-tree",
  tags: "i-lucide-tags",
  taxonomies: "i-lucide-library",
  authors: "i-lucide-users",
  posts: "i-lucide-newspaper",
  pages: "i-lucide-file-text",
  custom: "i-lucide-shapes",
  comments: "i-lucide-message-square",
  menus: "i-lucide-menu",
};

const events = ref<MigratorEvent[]>([]);
const status = ref<"idle" | "running" | "completed" | "failed">("idle");
const error = ref<string | null>(null);
const counters = ref<Record<string, Counter>>({});
const currentKind = ref<Kind | null>(null);
const currentItem = ref<string | null>(null);
const startedAt = ref<number | null>(null);
const finishedAt = ref<number | null>(null);
const now = ref(Date.now());
let ticker: ReturnType<typeof setInterval> | null = null;
const logFilter = ref<"all" | "problems">("all");
const failures = ref<Array<{ kind: string; wpId: number; message: string }>>([]);
const retrying = ref(false);
const toast = useToast();
const { config: migrationConfig } = useMigrationConfig();

/** One row per entry for the detail table; a retried entry replaces its earlier row. */
const rows = ref<ImportRow[]>([]);
const rowIndex = new Map<string, number>();
let rowSeq = 0;

function recordRow(e: MigratorEvent) {
  if (e.type !== "item-ok" && e.type !== "item-skip" && e.type !== "item-error") return;
  const key = `${e.kind}:${e.wpId}`;
  const row: ImportRow = {
    key,
    seq: rowSeq++,
    kind: e.kind,
    wpId: e.wpId,
    outcome: e.type === "item-ok" ? "ok" : e.type === "item-skip" ? "skip" : "error",
    item: e.item,
    ...(e.type === "item-ok" ? { detail: e.detail } : {}),
    ...(e.type === "item-skip" ? { reason: e.reason } : {}),
    ...(e.type === "item-error" ? { message: e.message } : {}),
  };
  const at = rowIndex.get(key);
  if (at === undefined) {
    rowIndex.set(key, rows.value.length);
    rows.value.push(row);
  } else rows.value[at] = row;
}

/** Same cause, one line — three hundred identical 403s are one problem, not three hundred. */
const failureGroups = computed(() => {
  const groups = new Map<string, { count: number; kinds: Set<string>; ids: number[] }>();
  for (const f of failures.value) {
    const cause = f.message.replace(/\/\d+\b/g, "/<id>").replace(/\b\d{3,}\b/g, "<n>").slice(0, 160);
    const g = groups.get(cause) ?? { count: 0, kinds: new Set<string>(), ids: [] };
    g.count += 1;
    g.kinds.add(f.kind);
    if (g.ids.length < 8) g.ids.push(f.wpId);
    groups.set(cause, g);
  }
  return [...groups.entries()]
    .map(([cause, g]) => ({ cause, count: g.count, kinds: [...g.kinds], ids: g.ids }))
    .sort((a, b) => b.count - a.count);
});

async function retryFailed() {
  retrying.value = true;
  try {
    const { config } = useMigrationConfig();
    await $fetch("/api/migrate", { method: "POST", body: { ...config.value, retryFailed: true } });
    toast.add({ title: "Reprise lancée", icon: "i-lucide-refresh-cw", color: "success" });
    window.location.reload();
  } catch (err) {
    toast.add({
      title: "Reprise impossible",
      description: (err as { statusMessage?: string }).statusMessage ?? String(err),
      icon: "i-lucide-triangle-alert",
      color: "error",
    });
  } finally {
    retrying.value = false;
  }
}
const logEnd = ref<HTMLDivElement | null>(null);
const autoScroll = ref(true);

const filterTabs: TabsItem[] = [
  { value: "all", label: "Tout", icon: "i-lucide-list" },
  { value: "problems", label: "Alertes et erreurs", icon: "i-lucide-triangle-alert" },
];

function apply(e: MigratorEvent) {
  recordRow(e);
  events.value.push(e);
  if (events.value.length > 2000) events.value.splice(0, events.value.length - 2000);

  if ("kind" in e && !counters.value[e.kind]) counters.value[e.kind] = emptyCounter();
  if (e.type === "item-ok") {
    counters.value[e.kind]!.ok += 1;
    currentItem.value = `${KIND_LABELS[e.kind] ?? e.kind} #${e.wpId} · ${e.item?.title ?? e.detail}`;
  } else if (e.type === "item-skip") counters.value[e.kind]!.skipped += 1;
  else if (e.type === "item-error") counters.value[e.kind]!.errors += 1;
  else if (e.type === "section-start") {
    currentKind.value = e.kind;
    // The expected size arrives up front, so progress has a denominator from the first item.
    if (e.expected) counters.value[e.kind]!.total = e.expected;
  } else if (e.type === "section-end") counters.value[e.kind]!.total = e.total;
  else if (e.type === "run-start") startedAt.value = Date.parse(e.at) || Date.now();
  else if (e.type === "run-end") {
    failures.value = e.failures ?? [];
    finishedAt.value = Date.parse(e.at) || Date.now();
    currentItem.value = null;
  }

  if (autoScroll.value) {
    nextTick(() => logEnd.value?.scrollIntoView({ behavior: "smooth", block: "end" }));
  }
}

const started = computed(() => Object.keys(counters.value).length > 0);

const elapsedMs = computed(() =>
  startedAt.value ? (finishedAt.value ?? now.value) - startedAt.value : 0,
);

function humanDuration(ms: number) {
  if (ms <= 0) return "0 s";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, "0")} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}

/** Entries per second over the whole run — steady enough to project a finish time. */
const rate = computed(() => {
  const done = totals.value.ok + totals.value.skipped + totals.value.errors;
  return elapsedMs.value > 1000 ? done / (elapsedMs.value / 1000) : 0;
});

const remaining = computed(() => {
  const done = totals.value.ok + totals.value.skipped + totals.value.errors;
  const left = totals.value.total - done;
  if (status.value !== "running" || left <= 0 || rate.value <= 0) return null;
  return humanDuration((left / rate.value) * 1000);
});
const totals = computed(() =>
  Object.values(counters.value).reduce(
    (acc, c) => ({
      ok: acc.ok + c.ok,
      skipped: acc.skipped + c.skipped,
      errors: acc.errors + c.errors,
      total: acc.total + c.total,
    }),
    { ok: 0, skipped: 0, errors: 0, total: 0 },
  ),
);
const overallProgress = computed(() => {
  const { ok, skipped, errors, total } = totals.value;
  if (total === 0) return undefined; // indeterminate until a section reports its size
  return Math.min(100, Math.round(((ok + skipped + errors) / total) * 100));
});

const problems = computed(() =>
  events.value.filter(
    (e) => e.type === "item-error" || (e.type === "log" && e.level !== "info"),
  ),
);
const visibleEvents = computed(() =>
  logFilter.value === "problems" ? problems.value : events.value,
);

const statusMeta = computed(() => {
  switch (status.value) {
    case "running":
      return { color: "info" as const, label: "En cours", icon: "i-lucide-loader-circle" };
    case "completed":
      return { color: "success" as const, label: "Terminée", icon: "i-lucide-circle-check" };
    case "failed":
      return { color: "error" as const, label: "Échouée", icon: "i-lucide-circle-x" };
    default:
      return { color: "neutral" as const, label: "Aucun run", icon: "i-lucide-circle-dashed" };
  }
});

function progressOf(c: Counter) {
  const done = c.ok + c.skipped + c.errors;
  return c.total > 0 ? Math.min(100, Math.round((done / c.total) * 100)) : 0;
}

let es: EventSource | null = null;

onMounted(() => {
  $fetch<{ hasRun: boolean; status?: string }>("/api/run-status").then((s) => {
    if (!s.hasRun) {
      status.value = "idle";
      return;
    }
    status.value = (s.status as typeof status.value) ?? "running";
    es = new EventSource("/api/events");
    es.addEventListener("progress", (ev) => {
      try {
        apply(JSON.parse((ev as MessageEvent).data) as MigratorEvent);
      } catch {
        /* a malformed frame is not worth killing the stream over */
      }
    });
    es.addEventListener("status", (ev) => {
      try {
        status.value = JSON.parse((ev as MessageEvent).data).status;
      } catch {
        /* ignore */
      }
    });
    es.addEventListener("end", (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as { status: string; error: string | null };
        status.value = data.status as typeof status.value;
        error.value = data.error;
      } catch {
        /* ignore */
      }
      es?.close();
    });
  });
});

onMounted(() => {
  ticker = setInterval(() => (now.value = Date.now()), 1000);
});

onUnmounted(() => {
  es?.close();
  if (ticker) clearInterval(ticker);
});
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-wrap items-start justify-between gap-4">
      <div>
        <div class="flex items-center gap-3">
          <h1 class="text-2xl font-bold text-highlighted">Migration</h1>
          <UBadge :color="statusMeta.color" variant="subtle" :icon="statusMeta.icon">
            {{ statusMeta.label }}
          </UBadge>
        </div>
        <p class="text-muted mt-1">
          <template v-if="status === 'running' && currentKind">
            {{ KIND_LABELS[currentKind] }} en cours · {{ humanDuration(elapsedMs) }} écoulées<template
              v-if="remaining"
            >, ~{{ remaining }} restantes</template>
          </template>
          <template v-else-if="status === 'completed'">
            {{ totals.ok }} entrées écrites, {{ totals.errors }} en erreur, en
            {{ humanDuration(elapsedMs) }}.
          </template>
          <template v-else-if="status === 'failed'">
            Interrompue après {{ humanDuration(elapsedMs) }}.
          </template>
          <template v-else>Progression en direct.</template>
        </p>
        <p
          v-if="status === 'running' && currentItem"
          class="text-xs text-dimmed font-mono mt-1 truncate max-w-xl"
        >
          {{ currentItem }}
        </p>
      </div>
      <UButton to="/" color="neutral" variant="subtle" icon="i-lucide-sliders-horizontal">
        Configuration
      </UButton>
    </div>

    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      title="La migration a échoué"
      :description="error"
    />

    <UCard v-if="!started && status === 'idle'">
      <div class="py-10 text-center space-y-3">
        <UIcon name="i-lucide-inbox" class="size-10 text-dimmed mx-auto" />
        <p class="font-medium text-highlighted">Aucune migration lancée</p>
        <p class="text-sm text-muted">
          Configurez la source, la destination et le mapping, puis lancez la migration.
        </p>
        <UButton to="/" icon="i-lucide-arrow-right" trailing>Aller à la configuration</UButton>
      </div>
    </UCard>

    <template v-else>
      <UCard>
        <div class="space-y-3">
          <div class="flex items-center justify-between text-sm">
            <span class="font-medium text-highlighted">Progression</span>
            <span class="text-muted tabular-nums">
              {{ totals.ok + totals.skipped + totals.errors }}
              <template v-if="totals.total"> / {{ totals.total }}</template>
              entrées
              <template v-if="overallProgress !== undefined"> · {{ overallProgress }} %</template>
              <template v-if="status === 'running' && rate > 0">
                · {{ rate.toFixed(1) }}/s
              </template>
            </span>
          </div>
          <UProgress
            :model-value="status === 'running' ? overallProgress : (overallProgress ?? 100)"
            :color="status === 'failed' ? 'error' : status === 'completed' ? 'success' : 'primary'"
          />
          <div class="flex flex-wrap gap-2 pt-1">
            <UBadge color="success" variant="subtle" icon="i-lucide-check">
              {{ totals.ok }} écrites
            </UBadge>
            <UBadge color="neutral" variant="subtle" icon="i-lucide-minus">
              {{ totals.skipped }} ignorées
            </UBadge>
            <UBadge
              :color="totals.errors > 0 ? 'error' : 'neutral'"
              variant="subtle"
              icon="i-lucide-x"
            >
              {{ totals.errors }} en erreur
            </UBadge>
          </div>
        </div>
      </UCard>

      <div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <UCard v-for="(counter, kind) in counters" :key="kind">
          <div class="space-y-2">
            <div class="flex items-center justify-between">
              <span class="inline-flex items-center gap-2 text-sm font-medium text-highlighted">
                <UIcon :name="KIND_ICONS[kind as Kind] ?? 'i-lucide-circle'" class="size-4 text-dimmed" />
                {{ KIND_LABELS[kind as Kind] ?? kind }}
              </span>
              <span class="text-xs text-dimmed tabular-nums">
                {{ counter.ok }}<template v-if="counter.total"> / {{ counter.total }}</template>
              </span>
            </div>
            <UProgress
              :model-value="progressOf(counter)"
              size="sm"
              :color="counter.errors > 0 ? 'warning' : 'primary'"
            />
            <div v-if="counter.skipped || counter.errors" class="flex gap-3 text-xs text-muted">
              <span v-if="counter.skipped">{{ counter.skipped }} ignorées</span>
              <span v-if="counter.errors" class="text-error">{{ counter.errors }} erreurs</span>
            </div>
          </div>
        </UCard>
      </div>

      <UCard v-if="failures.length > 0">
        <template #header>
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 class="font-semibold text-highlighted">Rapport d'échecs</h2>
              <p class="text-sm text-muted mt-0.5">
                {{ failures.length }} entrée(s) en échec, regroupées par cause.
              </p>
            </div>
            <UButton
              icon="i-lucide-refresh-cw"
              :loading="retrying"
              @click="retryFailed"
            >
              Relancer uniquement ces entrées
            </UButton>
          </div>
        </template>
        <div class="space-y-3">
          <div
            v-for="g in failureGroups"
            :key="g.cause"
            class="flex items-start gap-3 text-sm"
          >
            <UBadge color="error" variant="subtle" class="tabular-nums shrink-0">{{ g.count }}×</UBadge>
            <div class="min-w-0">
              <p class="text-toned break-words">{{ g.cause }}</p>
              <p class="text-xs text-dimmed mt-0.5">
                {{ g.kinds.join(", ") }} · ids {{ g.ids.join(", ") }}<span v-if="g.count > g.ids.length">, …</span>
              </p>
            </div>
          </div>
        </div>
      </UCard>

      <ImportDetails
        :rows="rows"
        :kind-labels="KIND_LABELS"
        :strapi-base-url="migrationConfig.strapi.baseUrl"
      />

      <UCard>
        <template #header>
          <div class="flex flex-wrap items-center justify-between gap-3">
            <h2 class="font-semibold text-highlighted">Journal</h2>
            <div class="flex items-center gap-3">
              <USwitch v-model="autoScroll" label="Suivre" size="sm" />
              <UTabs
                v-model="logFilter"
                :items="filterTabs"
                :content="false"
                size="xs"
                variant="pill"
              />
            </div>
          </div>
        </template>

        <div class="font-mono text-xs max-h-96 overflow-y-auto bg-elevated rounded-md p-3">
          <p v-if="visibleEvents.length === 0" class="text-muted font-sans py-6 text-center">
            {{ logFilter === "problems" ? "Aucune alerte — tout est passé." : "En attente d'événements…" }}
          </p>
          <div v-for="(e, i) in visibleEvents" :key="i" class="py-0.5">
            <template v-if="e.type === 'section-start'">
              <span class="text-primary">▶ {{ KIND_LABELS[e.kind] ?? e.kind }}</span>
            </template>
            <template v-else-if="e.type === 'section-end'">
              <span class="text-dimmed">■ {{ KIND_LABELS[e.kind] ?? e.kind }} ({{ e.total }})</span>
            </template>
            <template v-else-if="e.type === 'item-ok'">
              <span class="text-success">✓</span>
              <span class="text-dimmed"> {{ e.kind }} #{{ e.wpId }}</span>
              <span class="text-toned"> {{ e.detail }}</span>
            </template>
            <template v-else-if="e.type === 'item-skip'">
              <span class="text-dimmed">– {{ e.kind }} #{{ e.wpId }} ({{ e.reason }})</span>
            </template>
            <template v-else-if="e.type === 'item-error'">
              <span class="text-error">✗ {{ e.kind }} #{{ e.wpId }} : {{ e.message }}</span>
            </template>
            <template v-else-if="e.type === 'log'">
              <span :class="e.level === 'error' ? 'text-error' : e.level === 'warn' ? 'text-warning' : 'text-dimmed'">
                {{ e.level === "info" ? "ℹ" : "⚠" }}
                {{ noticeText(e.code, e.params, e.message) }}
              </span>
            </template>
            <template v-else-if="e.type === 'run-start'">
              <span class="text-dimmed">— début {{ e.at }} ({{ e.kinds.join(", ") }})</span>
            </template>
            <template v-else-if="e.type === 'run-end'">
              <span class="text-dimmed">— fin {{ e.at }}</span>
            </template>
          </div>
          <div ref="logEnd" />
        </div>
      </UCard>
    </template>
  </div>
</template>
