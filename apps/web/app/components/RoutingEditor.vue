<script setup lang="ts">
import type { ContentTypeSummary } from "@paullefizelier/wp-to-strapi-core/mapping";
import { useMigrationConfig } from "~/composables/useMigrationConfig";

const props = defineProps<{ contentTypes: ContentTypeSummary[] }>();

const { config } = useMigrationConfig();
const toast = useToast();

interface Term {
  id: number;
  name: string;
  slug: string;
  count: number;
}

const categories = ref<Term[]>([]);
const tags = ref<Term[]>([]);
const loading = ref(false);

const routes = computed({
  get: () => config.value.routing?.routes ?? [],
  set: (next) => {
    config.value.routing = { unmatched: config.value.routing?.unmatched ?? "default", routes: next };
  },
});

/** Pick categories by slug: stable, readable, and what the engine matches first. */
const categoryItems = computed(() =>
  categories.value.map((c) => ({ label: `${c.name} (${c.count})`, value: c.slug })),
);
const tagItems = computed(() =>
  tags.value.map((t) => ({ label: `${t.name} (${t.count})`, value: t.slug })),
);
const uidItems = computed(() =>
  props.contentTypes
    .filter((ct) => ct.kind === "collectionType")
    .map((ct) => ({ label: `${ct.displayName} — ${ct.uid}`, value: ct.uid })),
);

async function loadTerms() {
  if (!config.value.wp.baseUrl) return;
  loading.value = true;
  try {
    const r = await $fetch<{ categories: Term[]; tags: Term[] }>("/api/wp/terms", {
      method: "POST",
      body: config.value.wp,
    });
    categories.value = r.categories;
    tags.value = r.tags;
  } catch (err) {
    const e = err as { data?: { statusMessage?: string }; message?: string };
    toast.add({
      title: "Catégories WordPress illisibles",
      description: e.data?.statusMessage ?? e.message,
      icon: "i-lucide-triangle-alert",
      color: "error",
    });
  } finally {
    loading.value = false;
  }
}

onMounted(loadTerms);

/** A route name becomes a mapping key and a state bucket: keep it a plain identifier. */
function toName(label: string) {
  return (
    label
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "route"
  );
}

function addRoute() {
  const n = routes.value.length + 1;
  routes.value = [...routes.value, { name: `route-${n}`, categories: [], uid: "" }];
}

function patch(index: number, change: Record<string, unknown>) {
  routes.value = routes.value.map((r, i) => (i === index ? { ...r, ...change } : r));
}

/** Renaming moves the route's mapping with it, instead of orphaning it. */
function rename(index: number, raw: string) {
  const route = routes.value[index];
  if (!route) return;
  const next = toName(raw);
  if (next === route.name) return;
  const mapping = { ...(config.value.mapping ?? {}) };
  if (mapping.route?.[route.name]) {
    const { [route.name]: rows, ...rest } = mapping.route;
    mapping.route = { ...rest, [next]: rows! };
    config.value.mapping = mapping;
  }
  patch(index, { name: next });
}

function remove(index: number) {
  routes.value = routes.value.filter((_, i) => i !== index);
}

function move(index: number, delta: number) {
  const list = [...routes.value];
  const [item] = list.splice(index, 1);
  if (!item) return;
  list.splice(index + delta, 0, item);
  routes.value = list;
}

const duplicateNames = computed(() => {
  const seen = new Set<string>();
  return routes.value
    .map((r) => r.name)
    .filter((name) => (seen.has(name) ? true : (seen.add(name), false)));
});
</script>

<template>
  <UCard>
    <template #header>
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 class="font-semibold text-highlighted">Routage par catégorie</h2>
          <p class="text-sm text-muted mt-0.5">
            Envoyer une partie des articles vers un autre content-type, avec son propre mapping.
          </p>
        </div>
        <UButton
          color="neutral"
          variant="subtle"
          icon="i-lucide-refresh-cw"
          :loading="loading"
          :disabled="!config.wp.baseUrl"
          @click="loadTerms"
        >
          Relire les catégories
        </UButton>
      </div>
    </template>

    <div class="space-y-4">
      <p v-if="routes.length === 0" class="text-sm text-muted">
        Aucune route : tous les articles vont dans le content-type des articles. Ajoutez une route
        pour envoyer, par exemple, « Communiqués de presse » dans son propre type.
      </p>

      <div
        v-for="(route, i) in routes"
        :key="i"
        class="rounded-md border border-default p-3 space-y-3"
      >
        <div class="flex items-center gap-2">
          <UBadge color="neutral" variant="subtle" class="tabular-nums">{{ i + 1 }}</UBadge>
          <UInput
            :model-value="route.name"
            class="w-48"
            size="sm"
            icon="i-lucide-route"
            @change="(e: Event) => rename(i, (e.target as HTMLInputElement).value)"
          />
          <div class="ml-auto flex items-center gap-1">
            <UButton
              size="xs"
              color="neutral"
              variant="ghost"
              icon="i-lucide-arrow-up"
              :disabled="i === 0"
              aria-label="Monter"
              @click="move(i, -1)"
            />
            <UButton
              size="xs"
              color="neutral"
              variant="ghost"
              icon="i-lucide-arrow-down"
              :disabled="i === routes.length - 1"
              aria-label="Descendre"
              @click="move(i, 1)"
            />
            <UButton
              size="xs"
              color="error"
              variant="ghost"
              icon="i-lucide-trash-2"
              aria-label="Supprimer la route"
              @click="remove(i)"
            />
          </div>
        </div>

        <div class="grid md:grid-cols-2 gap-3">
          <UFormField label="Articles des catégories">
            <USelectMenu
              :model-value="(route.categories ?? []).map(String)"
              :items="categoryItems"
              value-key="value"
              multiple
              create-item="always"
              :search-input="{ placeholder: 'Filtrer ou saisir…' }"
              placeholder="Choisir des catégories"
              class="w-full"
              @update:model-value="(v: string[]) => patch(i, { categories: v })"
              @create="(v: string) => patch(i, { categories: [...(route.categories ?? []), v] })"
            />
          </UFormField>
          <UFormField label="Vont dans le content-type">
            <USelectMenu
              :model-value="route.uid"
              :items="uidItems"
              value-key="value"
              create-item="always"
              :search-input="{ placeholder: 'Filtrer ou saisir un UID…' }"
              placeholder="api::blog.blog"
              class="w-full"
              @update:model-value="(v: string) => patch(i, { uid: v })"
              @create="(v: string) => patch(i, { uid: v })"
            />
          </UFormField>
        </div>

        <UFormField v-if="tagItems.length" label="… ou des étiquettes" description="Combinées en OU avec les catégories.">
          <USelectMenu
            :model-value="(route.tags ?? []).map(String)"
            :items="tagItems"
            value-key="value"
            multiple
            create-item="always"
            placeholder="Aucune"
            class="w-full"
            @update:model-value="(v: string[]) => patch(i, { tags: v.length ? v : undefined })"
          />
        </UFormField>

        <UAlert
          v-if="!route.uid || !(route.categories?.length || route.tags?.length)"
          color="warning"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          :description="!route.uid
            ? 'Choisissez le content-type de destination — sans lui, la migration refusera de démarrer.'
            : 'Aucune catégorie ni étiquette : cette route ne prendra aucun article.'"
        />

        <p class="text-xs text-dimmed">
          Son mapping se règle dans l'onglet « {{ route.name }} » de l'éditeur ci-dessous — c'est là
          qu'on fixe une valeur comme la target group.
        </p>
      </div>

      <div class="flex flex-wrap items-center gap-3">
        <UButton size="sm" icon="i-lucide-plus" @click="addRoute">Ajouter une route</UButton>
        <USelect
          v-if="routes.length"
          :model-value="config.routing?.unmatched ?? 'default'"
          :items="[
            { value: 'default', label: 'Articles sans route → content-type des articles' },
            { value: 'skip', label: 'Articles sans route → ignorés' },
          ]"
          value-key="value"
          size="sm"
          class="w-80"
          @update:model-value="(v: string) => (config.routing = { routes, unmatched: v as 'default' | 'skip' })"
        />
      </div>

      <UAlert
        v-if="routes.length > 1"
        color="info"
        variant="subtle"
        icon="i-lucide-info"
        description="Un article dans plusieurs catégories routées va à la première route de la liste."
      />
      <UAlert
        v-if="duplicateNames.length"
        color="error"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        :description="`Noms de route en double : ${duplicateNames.join(', ')}.`"
      />
    </div>
  </UCard>
</template>
