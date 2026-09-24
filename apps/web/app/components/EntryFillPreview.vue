<script setup lang="ts">
import type { PreviewItem } from "@paullefizelier/wp-to-strapi-core";
import type { TargetField, TargetSchema } from "@paullefizelier/wp-to-strapi-core/mapping";

/**
 * An entry as its Strapi edit screen would show it once imported: every field of the target
 * content-type, what fills it, and what would go wrong — a required field left empty, an enum
 * value Strapi would refuse, a field Strapi does not have.
 */
const props = defineProps<{
  item: PreviewItem;
  schema: TargetSchema | null;
  schemaLoading?: boolean;
  /** Fields the AI assistant filled, to mark them. */
  aiFields?: string[];
}>();

/** Maintained by Strapi itself; never written by an import. */
const SYSTEM = new Set([
  "id", "documentId", "createdAt", "updatedAt", "publishedAt", "createdBy", "updatedBy",
  "locale", "localizations",
]);

const TYPE_LABEL: Record<string, string> = {
  string: "texte", text: "texte long", richtext: "texte riche", blocks: "blocs", email: "email",
  uid: "uid", enumeration: "liste", integer: "nombre", biginteger: "nombre", float: "nombre",
  decimal: "nombre", boolean: "oui/non", date: "date", datetime: "date et heure", time: "heure",
  json: "JSON", media: "média", relation: "relation", component: "composant",
  dynamiczone: "zone dynamique", password: "mot de passe",
};

const onlyFilled = ref(false);

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
}

type RowState = "filled" | "pending" | "empty" | "missing" | "invalid";

interface Row {
  name: string;
  field?: TargetField;
  value: unknown;
  state: RowState;
  note?: string;
}

const known = computed(() =>
  (props.schema?.fields ?? []).filter((f) => !SYSTEM.has(f.name)),
);

const rows = computed<Row[]>(() => {
  const data = props.item.data;
  const pending = props.item.pending ?? {};
  return known.value.map((field) => {
    const value = data[field.name];
    if (!isEmpty(value)) {
      if (field.type === "enumeration" && field.options?.length && !field.options.includes(String(value))) {
        return { name: field.name, field, value, state: "invalid", note: `valeur refusée — attendu : ${field.options.join(", ")}` };
      }
      return { name: field.name, field, value, state: "filled" };
    }
    if (pending[field.name]) {
      return { name: field.name, field, value, state: "pending", note: `rempli à l'import : ${pending[field.name]}` };
    }
    return { name: field.name, field, value, state: field.required ? "missing" : "empty" };
  });
});

/** Payload keys Strapi does not declare: a real write would be rejected with a 400. */
const unknownKeys = computed(() => {
  if (!props.schema || props.schema.source === "none") return [];
  const names = new Set(props.schema.fields.map((f) => f.name));
  return Object.keys(props.item.data).filter((k) => !names.has(k) && !SYSTEM.has(k));
});
const strictSchema = computed(() => props.schema?.source === "schema");

const counts = computed(() => ({
  filled: rows.value.filter((r) => r.state === "filled").length,
  pending: rows.value.filter((r) => r.state === "pending").length,
  missing: rows.value.filter((r) => r.state === "missing").length,
  invalid: rows.value.filter((r) => r.state === "invalid").length,
  total: rows.value.length,
}));

const visibleRows = computed(() =>
  onlyFilled.value ? rows.value.filter((r) => r.state !== "empty") : rows.value,
);

const STATE_UI: Record<RowState, { icon: string; class: string }> = {
  filled: { icon: "i-lucide-circle-check", class: "text-success" },
  pending: { icon: "i-lucide-clock", class: "text-info" },
  empty: { icon: "i-lucide-circle-dashed", class: "text-dimmed" },
  missing: { icon: "i-lucide-circle-alert", class: "text-error" },
  invalid: { icon: "i-lucide-circle-x", class: "text-error" },
};
</script>

<template>
  <div class="space-y-4">
    <div v-if="schemaLoading" class="flex items-center gap-2 text-sm text-muted">
      <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" />
      Lecture du content-type Strapi…
    </div>

    <template v-else-if="schema && known.length">
      <div class="flex flex-wrap items-center gap-2">
        <UBadge color="success" variant="subtle" icon="i-lucide-circle-check">
          {{ counts.filled }} / {{ counts.total }} remplis
        </UBadge>
        <UBadge v-if="counts.pending" color="info" variant="subtle" icon="i-lucide-clock">
          {{ counts.pending }} rempli(s) à l'import
        </UBadge>
        <UBadge v-if="counts.missing" color="error" variant="subtle" icon="i-lucide-circle-alert">
          {{ counts.missing }} obligatoire(s) vide(s)
        </UBadge>
        <UBadge v-if="counts.invalid" color="error" variant="subtle" icon="i-lucide-circle-x">
          {{ counts.invalid }} valeur(s) refusée(s)
        </UBadge>
        <USwitch v-model="onlyFilled" size="sm" label="Masquer les champs vides" class="ml-auto" />
      </div>

      <UAlert
        v-if="counts.missing || counts.invalid || (unknownKeys.length && strictSchema)"
        color="error"
        variant="subtle"
        icon="i-lucide-shield-alert"
        title="Strapi refuserait cette entrée"
        :description="[
          counts.missing ? `Champs obligatoires vides : ${rows.filter((r) => r.state === 'missing').map((r) => r.name).join(', ')}.` : '',
          counts.invalid ? `Valeurs hors liste : ${rows.filter((r) => r.state === 'invalid').map((r) => r.name).join(', ')}.` : '',
          unknownKeys.length && strictSchema ? `Champs inconnus de Strapi : ${unknownKeys.join(', ')}.` : '',
        ].filter(Boolean).join(' ') + ' Corrigez le mapping avant de lancer.'"
      />
      <UAlert
        v-else-if="unknownKeys.length"
        color="warning"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        title="Champs absents de l'échantillon Strapi"
        :description="`${unknownKeys.join(', ')} — le schéma a été déduit d'une entrée existante ; vérifiez que ces champs existent.`"
      />

      <div class="rounded-lg border border-default divide-y divide-default">
        <div v-for="row in visibleRows" :key="row.name" class="px-3 py-2.5 space-y-1.5">
          <div class="flex flex-wrap items-center gap-2">
            <UIcon :name="STATE_UI[row.state].icon" class="size-4 shrink-0" :class="STATE_UI[row.state].class" />
            <span class="font-mono text-xs font-semibold text-highlighted">{{ row.name }}</span>
            <span v-if="row.field?.required" class="text-error text-xs" title="obligatoire">*</span>
            <UBadge v-if="row.field?.type" color="neutral" variant="outline" size="sm">
              {{ TYPE_LABEL[row.field.type] ?? row.field.type }}
              <template v-if="row.field.component"> · {{ row.field.component }}</template>
              <template v-if="row.field.repeatable"> ×n</template>
            </UBadge>
            <UBadge
              v-if="aiFields?.includes(row.name)"
              color="primary"
              variant="subtle"
              size="sm"
              icon="i-lucide-sparkles"
            >
              IA
            </UBadge>
          </div>
          <p v-if="row.note" class="text-xs" :class="STATE_UI[row.state].class">{{ row.note }}</p>
          <div v-if="row.state !== 'pending'" class="pl-6">
            <FillValue :value="row.value" />
          </div>
        </div>
      </div>

      <div v-if="unknownKeys.length" class="space-y-2">
        <h3 class="text-xs font-semibold uppercase tracking-wide text-dimmed">Envoyés mais inconnus de Strapi</h3>
        <div class="rounded-lg border border-error/40 divide-y divide-default">
          <div v-for="key in unknownKeys" :key="key" class="px-3 py-2 space-y-1">
            <span class="font-mono text-xs text-error">{{ key }}</span>
            <FillValue :value="item.data[key]" />
          </div>
        </div>
      </div>
    </template>

    <!-- No schema readable: show the payload as sent. -->
    <template v-else>
      <UAlert
        v-if="!schemaLoading"
        color="neutral"
        variant="subtle"
        icon="i-lucide-info"
        title="Schéma Strapi indisponible"
        :description="schema?.note ?? 'Connectez Strapi (étape Destination) pour voir la fiche complète. Voici les champs envoyés.'"
      />
      <div class="rounded-lg border border-default divide-y divide-default">
        <div v-for="(value, key) in item.data" :key="key" class="px-3 py-2.5 space-y-1.5">
          <div class="flex items-center gap-2">
            <span class="font-mono text-xs font-semibold text-highlighted">{{ key }}</span>
            <UBadge v-if="aiFields?.includes(String(key))" color="primary" variant="subtle" size="sm" icon="i-lucide-sparkles">
              IA
            </UBadge>
          </div>
          <FillValue :value="value" />
        </div>
      </div>
    </template>
  </div>
</template>
