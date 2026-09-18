<script setup lang="ts">
import type { MigratorEvent, Kind } from "@paullefizelier/wp-to-strapi-core";
import type { TabsItem } from "@nuxt/ui";

definePageMeta({ title: "Migration en cours" });

type Counter = { ok: number; skipped: number; errors: number; total: number };
const emptyCounter = (): Counter => ({ ok: 0, skipped: 0, errors: 0, total: 0 });

const KIND_LABELS: Record<Kind, string> = {
  media: "Médias",
  categories: "Catégories",
  tags: "Étiquettes",
  posts: "Articles",
  pages: "Pages",
  custom: "Types personnalisés",
};
const KIND_ICONS: Record<Kind, string> = {
  media: "i-lucide-image",
  categories: "i-lucide-folder-tree",
  tags: "i-lucide-tags",
  posts: "i-lucide-newspaper",
  pages: "i-lucide-file-text",
  custom: "i-lucide-shapes",
};

const events = ref<MigratorEvent[]>([]);
const status = ref<"idle" | "running" | "completed" | "failed">("idle");
const error = ref<string | null>(null);
const counters = ref<Record<string, Counter>>({});
const currentKind = ref<Kind | null>(null);
const logFilter = ref<"all" | "problems">("all");
const logEnd = ref<HTMLDivElement | null>(null);
const autoScroll = ref(true);

const filterTabs: TabsItem[] = [
  { value: "all", label: "Tout", icon: "i-lucide-list" },
  { value: "problems", label: "Alertes et erreurs", icon: "i-lucide-triangle-alert" },
];

function apply(e: MigratorEvent) {
  events.value.push(e);
  if (events.value.length > 2000) events.value.splice(0, events.value.length - 2000);

  if ("kind" in e && !counters.value[e.kind]) counters.value[e.kind] = emptyCounter();
  if (e.type === "item-ok") counters.value[e.kind]!.ok += 1;
  else if (e.type === "item-skip") counters.value[e.kind]!.skipped += 1;
  else if (e.type === "item-error") counters.value[e.kind]!.errors += 1;
  else if (e.type === "section-start") currentKind.value = e.kind;
  else if (e.type === "section-end") counters.value[e.kind]!.total = e.total;

  if (autoScroll.value) {
    nextTick(() => logEnd.value?.scrollIntoView({ behavior: "smooth", block: "end" }));
  }
}

const started = computed(() => Object.keys(counters.value).length > 0);
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

onUnmounted(() => es?.close());
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
            En cours : {{ KIND_LABELS[currentKind] }}…
          </template>
          <template v-else-if="status === 'completed'">
            {{ totals.ok }} entrées écrites, {{ totals.errors }} en erreur.
          </template>
          <template v-else>Progression en direct.</template>
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
                {{ e.level === "info" ? "ℹ" : "⚠" }} {{ e.message }}
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
