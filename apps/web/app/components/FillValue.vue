<script setup lang="ts">
/**
 * One value of a Strapi payload, rendered the way an editor would read it: HTML as a page,
 * components as nested fields, lists as chips. Recursive for components and dynamic zones.
 */
defineOptions({ name: "FillValue" });

const props = defineProps<{ value: unknown; depth?: number }>();

const depth = computed(() => props.depth ?? 0);
const htmlView = ref<"render" | "source">("render");
const expanded = ref(false);

const isEmpty = computed(() => {
  const v = props.value;
  return v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
});
const isHtml = computed(() => typeof props.value === "string" && /<[a-z][\s\S]*>/i.test(props.value));
const isScalar = computed(() => ["string", "number", "boolean"].includes(typeof props.value));
const isPrimitiveList = computed(
  () => Array.isArray(props.value) && props.value.every((v) => v === null || typeof v !== "object"),
);
const objectList = computed(() =>
  Array.isArray(props.value) && !isPrimitiveList.value ? (props.value as Record<string, unknown>[]) : [],
);
const entries = computed(() =>
  props.value && typeof props.value === "object" && !Array.isArray(props.value)
    ? Object.entries(props.value as Record<string, unknown>).filter(([k]) => k !== "__component")
    : [],
);
const componentName = (v: unknown) =>
  v && typeof v === "object" && "__component" in v ? String((v as { __component: unknown }).__component) : "";

/** Rendered in a sandbox: no scripts, no access to this page. */
const srcdoc = computed(() =>
  isHtml.value
    ? `<!doctype html><meta charset="utf-8"><style>body{font:14px/1.6 system-ui,sans-serif;color:#1f2937;margin:12px;}img,video,iframe{max-width:100%;height:auto;}figure{margin:0 0 1em;}table{border-collapse:collapse;}td,th{border:1px solid #e5e7eb;padding:4px 6px;}</style>${props.value as string}`
    : "",
);

const LONG = 400;
const text = computed(() => String(props.value));
const shown = computed(() => (expanded.value || text.value.length <= LONG ? text.value : `${text.value.slice(0, LONG)}…`));
</script>

<template>
  <span v-if="isEmpty" class="text-xs italic text-dimmed">non rempli</span>

  <div v-else-if="isHtml" class="space-y-1.5">
    <div class="flex gap-1">
      <UButton
        size="xs"
        :variant="htmlView === 'render' ? 'soft' : 'ghost'"
        color="neutral"
        icon="i-lucide-eye"
        @click="htmlView = 'render'"
      >
        Rendu
      </UButton>
      <UButton
        size="xs"
        :variant="htmlView === 'source' ? 'soft' : 'ghost'"
        color="neutral"
        icon="i-lucide-code"
        @click="htmlView = 'source'"
      >
        HTML
      </UButton>
    </div>
    <iframe
      v-if="htmlView === 'render'"
      :srcdoc="srcdoc"
      sandbox=""
      referrerpolicy="no-referrer"
      title="Aperçu du contenu"
      class="w-full h-72 resize-y rounded border border-default bg-white"
    />
    <pre
      v-else
      class="text-xs text-toned bg-elevated rounded p-2 max-h-72 overflow-auto whitespace-pre-wrap break-all"
    >{{ value }}</pre>
  </div>

  <span v-else-if="isScalar" class="text-sm text-toned break-words whitespace-pre-wrap">
    {{ shown }}
    <button
      v-if="text.length > LONG"
      type="button"
      class="text-xs text-primary ml-1"
      @click="expanded = !expanded"
    >
      {{ expanded ? "réduire" : "voir tout" }}
    </button>
  </span>

  <div v-else-if="isPrimitiveList" class="flex flex-wrap gap-1">
    <UBadge v-for="(v, i) in value as unknown[]" :key="i" color="neutral" variant="outline" size="sm">
      {{ String(v) }}
    </UBadge>
  </div>

  <div v-else-if="objectList.length" class="space-y-2">
    <div
      v-for="(item, i) in objectList"
      :key="i"
      class="rounded-md border border-default p-2 space-y-1.5"
    >
      <div class="flex items-center gap-2 text-xs text-dimmed">
        <span class="tabular-nums">#{{ i + 1 }}</span>
        <UBadge v-if="componentName(item)" color="primary" variant="subtle" size="sm">
          {{ componentName(item) }}
        </UBadge>
      </div>
      <FillValue :value="item" :depth="depth + 1" />
    </div>
  </div>

  <dl v-else-if="entries.length" class="grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-3 gap-y-1.5">
    <template v-for="[key, v] in entries" :key="key">
      <dt class="font-mono text-xs text-muted pt-0.5 break-all">{{ key }}</dt>
      <dd class="min-w-0"><FillValue :value="v" :depth="depth + 1" /></dd>
    </template>
  </dl>

  <span v-else class="text-xs font-mono text-toned">{{ JSON.stringify(value) }}</span>
</template>
