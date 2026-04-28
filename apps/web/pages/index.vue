<script setup lang="ts">
import { useMigrationConfig } from "~/composables/useMigrationConfig";

definePageMeta({ title: "Configuration" });

const { config } = useMigrationConfig();
const toast = useToast();

const testingWp = ref(false);
const testingStrapi = ref(false);
const wpResult = ref<{ ok: boolean; message: string; counts?: { posts: number; pages: number; media: number } } | null>(null);
const strapiResult = ref<{ ok: boolean; message: string } | null>(null);
const starting = ref(false);

const kindOptions = [
  { value: "media", label: "Médias" },
  { value: "posts", label: "Articles" },
  { value: "pages", label: "Pages" },
];

async function testWordPress() {
  testingWp.value = true;
  wpResult.value = null;
  try {
    const r = await $fetch<{ ok: boolean; counts?: { posts: number; pages: number; media: number }; error?: string }>(
      "/api/test/wp",
      {
        method: "POST",
        body: {
          baseUrl: config.value.wp.baseUrl,
          username: config.value.wp.username || undefined,
          appPassword: config.value.wp.appPassword || undefined,
        },
      },
    );
    wpResult.value = r.ok
      ? { ok: true, message: `Connecté — ${r.counts?.posts ?? 0} articles, ${r.counts?.pages ?? 0} pages, ${r.counts?.media ?? 0} médias`, counts: r.counts }
      : { ok: false, message: r.error ?? "Échec inconnu" };
  } catch (err) {
    wpResult.value = { ok: false, message: (err as Error).message };
  } finally {
    testingWp.value = false;
  }
}

async function testStrapi() {
  testingStrapi.value = true;
  strapiResult.value = null;
  try {
    const r = await $fetch<{
      posts: { ok: true; total: number } | { ok: false; status: number; message: string };
      pages: { ok: true; total: number } | { ok: false; status: number; message: string };
    }>("/api/test/strapi", {
      method: "POST",
      body: config.value.strapi,
    });
    const postsOk = r.posts.ok;
    const pagesOk = r.pages.ok;
    if (postsOk && pagesOk) {
      strapiResult.value = {
        ok: true,
        message: `Connecté — ${(r.posts as { total: number }).total} articles, ${(r.pages as { total: number }).total} pages déjà en base`,
      };
    } else {
      const errors = [
        !postsOk ? `posts (${(r.posts as { status: number; message: string }).status}): ${(r.posts as { message: string }).message}` : "",
        !pagesOk ? `pages (${(r.pages as { status: number; message: string }).status}): ${(r.pages as { message: string }).message}` : "",
      ].filter(Boolean).join(" · ");
      strapiResult.value = { ok: false, message: errors };
    }
  } catch (err) {
    strapiResult.value = { ok: false, message: (err as Error).message };
  } finally {
    testingStrapi.value = false;
  }
}

async function startMigration() {
  starting.value = true;
  try {
    await $fetch<{ runId: string }>("/api/migrate", {
      method: "POST",
      body: config.value,
    });
    toast.add({ title: "Migration lancée", color: "green" });
    await navigateTo("/run");
  } catch (err) {
    toast.add({ title: "Erreur", description: (err as Error).message, color: "red" });
  } finally {
    starting.value = false;
  }
}

const canStart = computed(() => {
  return (
    Boolean(config.value.wp.baseUrl) &&
    Boolean(config.value.strapi.baseUrl) &&
    Boolean(config.value.strapi.token) &&
    config.value.only.length > 0
  );
});
</script>

<template>
  <div class="space-y-6">
    <div>
      <h1 class="text-2xl font-bold text-gray-900 dark:text-white">Configuration</h1>
      <p class="text-gray-600 dark:text-gray-400 mt-1">
        Indiquez les credentials WordPress et Strapi, testez les connexions, puis lancez la migration.
      </p>
    </div>

    <UCard>
      <template #header>
        <div class="flex items-center justify-between">
          <h2 class="text-lg font-semibold">Source WordPress</h2>
          <UButton
            :loading="testingWp"
            :disabled="!config.wp.baseUrl"
            size="sm"
            color="gray"
            @click="testWordPress"
          >
            Tester la connexion
          </UButton>
        </div>
      </template>

      <div class="space-y-4">
        <UFormGroup label="URL du site WordPress" required>
          <UInput v-model="config.wp.baseUrl" placeholder="https://mon-site.com" />
        </UFormGroup>
        <div class="grid grid-cols-2 gap-4">
          <UFormGroup label="Utilisateur (optionnel)" help="Pour accéder aux brouillons ou contenus privés">
            <UInput v-model="config.wp.username" placeholder="admin" />
          </UFormGroup>
          <UFormGroup label="Application Password" help="Settings → Users → Application Passwords dans WP">
            <UInput v-model="config.wp.appPassword" type="password" placeholder="xxxx xxxx xxxx xxxx" />
          </UFormGroup>
        </div>
        <UAlert
          v-if="wpResult"
          :color="wpResult.ok ? 'green' : 'red'"
          :icon="wpResult.ok ? 'i-heroicons-check-circle' : 'i-heroicons-exclamation-triangle'"
          :title="wpResult.ok ? 'Connexion WordPress OK' : 'Échec de la connexion'"
          :description="wpResult.message"
          variant="subtle"
        />
      </div>
    </UCard>

    <UCard>
      <template #header>
        <div class="flex items-center justify-between">
          <h2 class="text-lg font-semibold">Destination Strapi v5</h2>
          <UButton
            :loading="testingStrapi"
            :disabled="!config.strapi.baseUrl || !config.strapi.token"
            size="sm"
            color="gray"
            @click="testStrapi"
          >
            Tester la connexion
          </UButton>
        </div>
      </template>

      <div class="space-y-4">
        <UFormGroup label="URL de l'instance Strapi" required>
          <UInput v-model="config.strapi.baseUrl" placeholder="http://localhost:1337" />
        </UFormGroup>
        <UFormGroup label="API Token (Full access)" required help="Settings → API Tokens dans l'admin Strapi">
          <UInput v-model="config.strapi.token" type="password" placeholder="Bearer token..." />
        </UFormGroup>
        <div class="grid grid-cols-2 gap-4">
          <UFormGroup label="UID des articles">
            <UInput v-model="config.strapi.postUid" placeholder="api::post.post" />
          </UFormGroup>
          <UFormGroup label="UID des pages">
            <UInput v-model="config.strapi.pageUid" placeholder="api::page.page" />
          </UFormGroup>
        </div>
        <UAlert
          v-if="strapiResult"
          :color="strapiResult.ok ? 'green' : 'red'"
          :icon="strapiResult.ok ? 'i-heroicons-check-circle' : 'i-heroicons-exclamation-triangle'"
          :title="strapiResult.ok ? 'Connexion Strapi OK' : 'Échec de la connexion'"
          :description="strapiResult.message"
          variant="subtle"
        />
      </div>
    </UCard>

    <UCard>
      <template #header>
        <h2 class="text-lg font-semibold">Options</h2>
      </template>
      <div class="space-y-4">
        <UFormGroup label="Contenus à migrer">
          <div class="flex gap-3">
            <UCheckbox
              v-for="opt in kindOptions"
              :key="opt.value"
              :label="opt.label"
              :model-value="config.only.includes(opt.value as 'media' | 'posts' | 'pages')"
              @update:model-value="(v: boolean) => {
                const set = new Set(config.only);
                if (v) set.add(opt.value as 'media' | 'posts' | 'pages');
                else set.delete(opt.value as 'media' | 'posts' | 'pages');
                config.only = [...set];
              }"
            />
          </div>
        </UFormGroup>
        <div class="grid grid-cols-3 gap-4">
          <UFormGroup label="Concurrence">
            <UInput v-model.number="config.concurrency" type="number" :min="1" :max="32" />
          </UFormGroup>
          <UFormGroup label="Taille de page (WP)">
            <UInput v-model.number="config.pageSize" type="number" :min="1" :max="100" />
          </UFormGroup>
          <UFormGroup label="Mode dry-run" help="Aucun écrit côté Strapi">
            <UToggle v-model="config.dryRun" />
          </UFormGroup>
        </div>
      </div>
    </UCard>

    <div class="flex justify-end gap-3">
      <UButton
        size="lg"
        color="primary"
        icon="i-heroicons-play"
        :loading="starting"
        :disabled="!canStart"
        @click="startMigration"
      >
        Lancer la migration
      </UButton>
    </div>
  </div>
</template>
