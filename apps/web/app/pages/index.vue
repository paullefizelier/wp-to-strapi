<script setup lang="ts">
import type { Kind } from "@paullefizelier/wp-to-strapi-core";
import type { StepperItem } from "@nuxt/ui";
import { useMigrationConfig } from "~/composables/useMigrationConfig";

definePageMeta({ title: "Configuration" });

const { config } = useMigrationConfig();
const toast = useToast();

const testingWp = ref(false);
const testingStrapi = ref(false);
const starting = ref(false);
const wpResult = ref<{ ok: boolean; message: string } | null>(null);
const strapiResult = ref<{ ok: boolean; message: string } | null>(null);

const step = ref(0);
const stepper = useTemplateRef("stepper");
const items: StepperItem[] = [
  { title: "Source", description: "WordPress", icon: "i-lucide-globe", slot: "source" },
  { title: "Destination", description: "Strapi v5", icon: "i-lucide-database", slot: "destination" },
  { title: "Mapping", description: "Champs", icon: "i-lucide-arrow-left-right", slot: "mapping" },
  { title: "Lancement", description: "Portée et options", icon: "i-lucide-play", slot: "run" },
];

const kindOptions: Array<{ value: Kind; label: string; icon: string }> = [
  { value: "media", label: "Médias", icon: "i-lucide-image" },
  { value: "categories", label: "Catégories", icon: "i-lucide-folder-tree" },
  { value: "tags", label: "Étiquettes", icon: "i-lucide-tags" },
  { value: "posts", label: "Articles", icon: "i-lucide-newspaper" },
  { value: "pages", label: "Pages", icon: "i-lucide-file-text" },
  { value: "custom", label: "Types personnalisés", icon: "i-lucide-shapes" },
];

/** Inline validation: a red field beats a failed run three minutes later. */
const wpUrlError = computed(() => {
  const v = config.value.wp.baseUrl;
  if (!v) return undefined;
  return /^https?:\/\/.+/.test(v) ? undefined : "URL invalide — commencez par http:// ou https://";
});
const strapiUrlError = computed(() => {
  const v = config.value.strapi.baseUrl;
  if (!v) return undefined;
  return /^https?:\/\/.+/.test(v) ? undefined : "URL invalide — commencez par http:// ou https://";
});

const wpReady = computed(() => Boolean(config.value.wp.baseUrl) && !wpUrlError.value);
const strapiReady = computed(
  () => Boolean(config.value.strapi.baseUrl && config.value.strapi.token) && !strapiUrlError.value,
);
const canStart = computed(() => wpReady.value && strapiReady.value && config.value.only.length > 0);

/** CPTs are edited as `restBase:api::uid.uid[|pluralPath]`, one per line. */
const customTypesText = computed(() =>
  config.value.customTypes
    .map((t: { restBase: string; uid: string; pluralPath?: string }) =>
      `${t.restBase}:${t.uid}${t.pluralPath ? `|${t.pluralPath}` : ""}`)
    .join("\n"),
);

function setCustomTypes(text: string) {
  config.value.customTypes = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const colon = line.indexOf(":");
      if (colon <= 0) return [];
      const [uid, pluralPath] = line.slice(colon + 1).split("|").map((part) => part.trim());
      if (!uid) return [];
      const restBase = line.slice(0, colon).trim();
      return [pluralPath ? { restBase, uid, pluralPath } : { restBase, uid }];
    });
}

function toggleKind(kind: Kind, on: boolean) {
  const set = new Set(config.value.only);
  if (on) set.add(kind);
  else set.delete(kind);
  config.value.only = [...set];
}

async function testWordPress() {
  testingWp.value = true;
  wpResult.value = null;
  try {
    const r = await $fetch<{
      ok: boolean;
      counts?: { posts: number; pages: number; media: number };
      error?: string;
    }>("/api/test/wp", {
      method: "POST",
      body: {
        baseUrl: config.value.wp.baseUrl,
        username: config.value.wp.username || undefined,
        appPassword: config.value.wp.appPassword || undefined,
      },
    });
    wpResult.value = r.ok
      ? {
          ok: true,
          message: `${r.counts?.posts ?? 0} articles · ${r.counts?.pages ?? 0} pages · ${r.counts?.media ?? 0} médias`,
        }
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
    }>("/api/test/strapi", { method: "POST", body: config.value.strapi });

    if (r.posts.ok && r.pages.ok) {
      strapiResult.value = {
        ok: true,
        message: `${r.posts.total} articles · ${r.pages.total} pages déjà en base`,
      };
    } else {
      strapiResult.value = {
        ok: false,
        message: [
          !r.posts.ok ? `articles (${r.posts.status}) : ${r.posts.message}` : "",
          !r.pages.ok ? `pages (${r.pages.status}) : ${r.pages.message}` : "",
        ]
          .filter(Boolean)
          .join(" · "),
      };
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
    await $fetch<{ runId: string }>("/api/migrate", { method: "POST", body: config.value });
    toast.add({ title: "Migration lancée", icon: "i-lucide-rocket", color: "success" });
    await navigateTo("/run");
  } catch (err) {
    toast.add({
      title: "Lancement impossible",
      description: (err as { statusMessage?: string }).statusMessage ?? (err as Error).message,
      icon: "i-lucide-triangle-alert",
      color: "error",
    });
  } finally {
    starting.value = false;
  }
}
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-start justify-between gap-4">
      <div>
        <h1 class="text-2xl font-bold text-highlighted">Configuration</h1>
        <p class="text-muted mt-1">
          Connectez les deux bouts, réglez le mapping, lancez. Les identifiants restent dans
          votre navigateur.
        </p>
      </div>
      <UButton
        icon="i-lucide-rocket"
        size="lg"
        :loading="starting"
        :disabled="!canStart"
        @click="startMigration"
      >
        Lancer la migration
      </UButton>
    </div>

    <UStepper ref="stepper" v-model="step" :items="items" class="w-full">
      <!-- 1 · WordPress -->
      <template #source>
        <UCard class="mt-6">
          <template #header>
            <div class="flex items-center justify-between gap-4">
              <div class="flex items-center gap-2">
                <h2 class="font-semibold text-highlighted">Source WordPress</h2>
                <UBadge
                  v-if="wpResult"
                  :color="wpResult.ok ? 'success' : 'error'"
                  variant="subtle"
                  :icon="wpResult.ok ? 'i-lucide-check' : 'i-lucide-x'"
                >
                  {{ wpResult.ok ? "Connecté" : "Échec" }}
                </UBadge>
              </div>
              <UButton
                color="neutral"
                variant="subtle"
                icon="i-lucide-plug-zap"
                :loading="testingWp"
                :disabled="!wpReady"
                @click="testWordPress"
              >
                Tester
              </UButton>
            </div>
          </template>

          <div class="space-y-4">
            <UFormField
              label="URL du site WordPress"
              description="L'API REST doit être accessible sur /wp-json/wp/v2/."
              required
              :error="wpUrlError"
            >
              <UInput
                v-model="config.wp.baseUrl"
                placeholder="https://mon-site.com"
                icon="i-lucide-globe"
                class="w-full"
              />
            </UFormField>

            <div class="grid sm:grid-cols-2 gap-4">
              <UFormField
                label="Utilisateur"
                description="Nécessaire pour les brouillons, les contenus privés et les champs meta."
              >
                <UInput v-model="config.wp.username" placeholder="admin" icon="i-lucide-user" class="w-full" />
              </UFormField>
              <UFormField label="Application Password" description="Réglages → Utilisateurs → Application Passwords.">
                <UInput
                  v-model="config.wp.appPassword"
                  type="password"
                  placeholder="xxxx xxxx xxxx xxxx"
                  icon="i-lucide-key-round"
                  class="w-full"
                />
              </UFormField>
            </div>

            <UAlert
              v-if="wpResult"
              :color="wpResult.ok ? 'success' : 'error'"
              variant="subtle"
              :icon="wpResult.ok ? 'i-lucide-circle-check' : 'i-lucide-triangle-alert'"
              :title="wpResult.ok ? 'Connexion WordPress OK' : 'Connexion WordPress impossible'"
              :description="wpResult.message"
            />
          </div>
        </UCard>
      </template>

      <!-- 2 · Strapi -->
      <template #destination>
        <UCard class="mt-6">
          <template #header>
            <div class="flex items-center justify-between gap-4">
              <div class="flex items-center gap-2">
                <h2 class="font-semibold text-highlighted">Destination Strapi v5</h2>
                <UBadge
                  v-if="strapiResult"
                  :color="strapiResult.ok ? 'success' : 'error'"
                  variant="subtle"
                  :icon="strapiResult.ok ? 'i-lucide-check' : 'i-lucide-x'"
                >
                  {{ strapiResult.ok ? "Connecté" : "Échec" }}
                </UBadge>
              </div>
              <UButton
                color="neutral"
                variant="subtle"
                icon="i-lucide-plug-zap"
                :loading="testingStrapi"
                :disabled="!strapiReady"
                @click="testStrapi"
              >
                Tester
              </UButton>
            </div>
          </template>

          <div class="space-y-4">
            <div class="grid sm:grid-cols-2 gap-4">
              <UFormField label="URL de l'instance" required :error="strapiUrlError">
                <UInput
                  v-model="config.strapi.baseUrl"
                  placeholder="http://localhost:1337"
                  icon="i-lucide-server"
                  class="w-full"
                />
              </UFormField>
              <UFormField label="API Token" description="Full access — Settings → API Tokens." required>
                <UInput
                  v-model="config.strapi.token"
                  type="password"
                  placeholder="Bearer token…"
                  icon="i-lucide-key-round"
                  class="w-full"
                />
              </UFormField>
            </div>

            <USeparator label="Content-types cibles" />

            <div class="grid sm:grid-cols-2 gap-4">
              <UFormField label="Articles">
                <UInput v-model="config.strapi.postUid" placeholder="api::post.post" class="w-full" />
              </UFormField>
              <UFormField label="Pages">
                <UInput v-model="config.strapi.pageUid" placeholder="api::page.page" class="w-full" />
              </UFormField>
              <UFormField label="Catégories" description="Vide = catégories non migrées.">
                <UInput v-model="config.strapi.categoryUid" placeholder="api::category.category" class="w-full" />
              </UFormField>
              <UFormField label="Étiquettes" description="Vide = étiquettes non migrées.">
                <UInput v-model="config.strapi.tagUid" placeholder="api::tag.tag" class="w-full" />
              </UFormField>
            </div>

            <UAlert
              v-if="strapiResult"
              :color="strapiResult.ok ? 'success' : 'error'"
              variant="subtle"
              :icon="strapiResult.ok ? 'i-lucide-circle-check' : 'i-lucide-triangle-alert'"
              :title="strapiResult.ok ? 'Connexion Strapi OK' : 'Connexion Strapi impossible'"
              :description="strapiResult.message"
            />
          </div>
        </UCard>
      </template>

      <!-- 3 · Mapping -->
      <template #mapping>
        <FieldMapper class="mt-6" />
      </template>

      <!-- 4 · Portée et lancement -->
      <template #run>
        <div class="mt-6 space-y-4">
          <UCard>
            <template #header>
              <h2 class="font-semibold text-highlighted">Contenus à migrer</h2>
            </template>
            <div class="grid sm:grid-cols-3 gap-3">
              <UCheckbox
                v-for="opt in kindOptions"
                :key="opt.value"
                :model-value="config.only.includes(opt.value)"
                @update:model-value="(v: boolean | 'indeterminate') => toggleKind(opt.value, v === true)"
              >
                <template #label>
                  <span class="inline-flex items-center gap-1.5">
                    <UIcon :name="opt.icon" class="size-4 text-dimmed" />
                    {{ opt.label }}
                  </span>
                </template>
              </UCheckbox>
            </div>
          </UCard>

          <UCard>
            <template #header>
              <h2 class="font-semibold text-highlighted">Options</h2>
            </template>
            <div class="space-y-5">
              <div class="grid sm:grid-cols-3 gap-4">
                <UFormField label="Concurrence" description="Requêtes en parallèle.">
                  <UInputNumber v-model="config.concurrency" :min="1" :max="32" class="w-full" />
                </UFormField>
                <UFormField label="Taille de page (WP)" description="Entrées par requête REST.">
                  <UInputNumber v-model="config.pageSize" :min="1" :max="100" class="w-full" />
                </UFormField>
                <UFormField label="Fichier d'état" description="Reprise après interruption.">
                  <UInput v-model="config.stateFile" class="w-full" />
                </UFormField>
              </div>

              <USeparator />

              <div class="space-y-3">
                <USwitch
                  v-model="config.dryRun"
                  label="Mode dry-run"
                  description="Parcourt tout sans rien écrire dans Strapi."
                />
                <USwitch
                  :model-value="config.statuses.length > 1"
                  label="Inclure brouillons et programmés"
                  description="Importés en brouillon Strapi. Nécessite les identifiants WordPress."
                  @update:model-value="(v: boolean) => {
                    config.statuses = v ? ['publish', 'draft', 'pending', 'future', 'private'] : ['publish'];
                  }"
                />
                <USwitch
                  v-model="config.htmlFallback"
                  label="Récupérer le contenu des page builders"
                  description="Lit la page publique quand le REST ne renvoie rien (Elementor, Divi, FSE)."
                />
              </div>

              <UFormField
                label="Types personnalisés (CPT)"
                description="Un par ligne : restBase:api::uid.uid — ex. portfolio:api::project.project"
              >
                <UTextarea
                  :model-value="customTypesText"
                  :rows="2"
                  placeholder="portfolio:api::project.project"
                  class="w-full"
                  @update:model-value="(v: string | number) => setCustomTypes(String(v))"
                />
              </UFormField>
            </div>
          </UCard>

          <UAlert
            v-if="!canStart"
            color="warning"
            variant="subtle"
            icon="i-lucide-info"
            title="Il manque quelque chose"
            :description="
              !wpReady
                ? 'Renseignez une URL WordPress valide.'
                : !strapiReady
                  ? 'Renseignez l\'URL et le token Strapi.'
                  : 'Cochez au moins un type de contenu.'
            "
          />
        </div>
      </template>
    </UStepper>

    <div class="flex items-center justify-between gap-3">
      <UButton
        color="neutral"
        variant="subtle"
        icon="i-lucide-arrow-left"
        :disabled="!stepper?.hasPrev"
        @click="stepper?.prev()"
      >
        Précédent
      </UButton>
      <UButton
        v-if="stepper?.hasNext"
        icon="i-lucide-arrow-right"
        trailing
        @click="stepper?.next()"
      >
        Suivant
      </UButton>
      <UButton
        v-else
        icon="i-lucide-rocket"
        :loading="starting"
        :disabled="!canStart"
        @click="startMigration"
      >
        Lancer la migration
      </UButton>
    </div>
  </div>
</template>
