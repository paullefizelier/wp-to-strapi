<script setup lang="ts">
import type { MigratorEvent, Kind } from "@paullefizelier/wp-to-strapi-core";

definePageMeta({ title: "Migration en cours" });

type Counters = Record<Kind, { ok: number; skipped: number; errors: number; total: number }>;

const events = ref<MigratorEvent[]>([]);
const status = ref<"idle" | "running" | "completed" | "failed">("idle");
const error = ref<string | null>(null);
const counters = ref<Counters>({
  media: { ok: 0, skipped: 0, errors: 0, total: 0 },
  posts: { ok: 0, skipped: 0, errors: 0, total: 0 },
  pages: { ok: 0, skipped: 0, errors: 0, total: 0 },
});

const logEnd = ref<HTMLDivElement | null>(null);

function apply(e: MigratorEvent) {
  events.value.push(e);
  if (events.value.length > 2000) events.value.splice(0, events.value.length - 2000);
  if (e.type === "item-ok") counters.value[e.kind].ok += 1;
  else if (e.type === "item-skip") counters.value[e.kind].skipped += 1;
  else if (e.type === "item-error") counters.value[e.kind].errors += 1;
  else if (e.type === "section-end") counters.value[e.kind].total = e.total;

  nextTick(() => {
    logEnd.value?.scrollIntoView({ behavior: "smooth", block: "end" });
  });
}

let es: EventSource | null = null;

onMounted(() => {
  // Check first whether a run exists at all.
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
        /* ignore */
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
    es.onerror = () => {
      if (status.value === "running") {
        // Will be handled by polling — server might just have terminated the stream.
      }
    };
  });
});

onUnmounted(() => {
  es?.close();
});

function kindLabel(k: Kind) {
  return k === "media" ? "Médias" : k === "posts" ? "Articles" : "Pages";
}

const statusColor = computed<"gray" | "blue" | "green" | "red">(() =>
  status.value === "running" ? "blue" : status.value === "completed" ? "green" : status.value === "failed" ? "red" : "gray",
);
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-bold text-gray-900 dark:text-white">Migration</h1>
        <p class="text-gray-600 dark:text-gray-400 mt-1">Progression en direct.</p>
      </div>
      <UBadge :color="statusColor" variant="subtle" size="lg">
        {{
          status === "running"
            ? "En cours"
            : status === "completed"
              ? "Terminé"
              : status === "failed"
                ? "Échec"
                : "Aucune migration"
        }}
      </UBadge>
    </div>

    <div v-if="status === 'idle'" class="text-center py-12">
      <UIcon name="i-heroicons-arrow-path-rounded-square" class="w-12 h-12 text-gray-400 mx-auto" />
      <p class="mt-4 text-gray-600 dark:text-gray-400">Aucune migration n'est en cours.</p>
      <UButton to="/" class="mt-4">Retour à la configuration</UButton>
    </div>

    <template v-else>
      <div class="grid grid-cols-3 gap-4">
        <UCard v-for="kind in (['media', 'posts', 'pages'] as const)" :key="kind">
          <div class="text-sm text-gray-500 dark:text-gray-400">{{ kindLabel(kind) }}</div>
          <div class="text-3xl font-bold text-gray-900 dark:text-white mt-1">
            {{ counters[kind].ok }}
            <span v-if="counters[kind].total" class="text-base font-normal text-gray-400">/ {{ counters[kind].total }}</span>
          </div>
          <div class="mt-2 flex gap-3 text-xs text-gray-500">
            <span v-if="counters[kind].skipped">
              <UIcon name="i-heroicons-minus-circle" class="inline w-4 h-4" /> {{ counters[kind].skipped }} ignoré(s)
            </span>
            <span v-if="counters[kind].errors" class="text-red-500">
              <UIcon name="i-heroicons-x-circle" class="inline w-4 h-4" /> {{ counters[kind].errors }} erreur(s)
            </span>
          </div>
        </UCard>
      </div>

      <UCard>
        <template #header>
          <h2 class="text-lg font-semibold">Log</h2>
        </template>
        <div class="font-mono text-xs max-h-96 overflow-y-auto bg-gray-50 dark:bg-gray-900 rounded p-3">
          <div v-for="(e, i) in events" :key="i" class="py-0.5">
            <template v-if="e.type === 'section-start'">
              <span class="text-indigo-600 dark:text-indigo-400">▶ {{ kindLabel(e.kind) }}</span>
            </template>
            <template v-else-if="e.type === 'section-end'">
              <span class="text-gray-500">■ {{ kindLabel(e.kind) }} ({{ e.total }} items)</span>
            </template>
            <template v-else-if="e.type === 'item-ok'">
              <span class="text-green-600 dark:text-green-400">✓</span>
              <span class="text-gray-500"> {{ e.kind }} #{{ e.wpId }}</span>
              <span class="text-gray-700 dark:text-gray-300"> {{ e.detail }}</span>
            </template>
            <template v-else-if="e.type === 'item-skip'">
              <span class="text-gray-400">– {{ e.kind }} #{{ e.wpId }} ({{ e.reason }})</span>
            </template>
            <template v-else-if="e.type === 'item-error'">
              <span class="text-red-600 dark:text-red-400">✗ {{ e.kind }} #{{ e.wpId }}: {{ e.message }}</span>
            </template>
            <template v-else-if="e.type === 'run-start'">
              <span class="text-gray-500">— début {{ e.at }} ({{ e.kinds.join(", ") }})</span>
            </template>
            <template v-else-if="e.type === 'run-end'">
              <span class="text-gray-500">— fin {{ e.at }} ({{ e.summary.media }}/{{ e.summary.posts }}/{{ e.summary.pages }})</span>
            </template>
          </div>
          <div ref="logEnd" />
        </div>
      </UCard>

      <UAlert
        v-if="error"
        color="red"
        icon="i-heroicons-exclamation-triangle"
        title="La migration a échoué"
        :description="error"
        variant="subtle"
      />
    </template>
  </div>
</template>
