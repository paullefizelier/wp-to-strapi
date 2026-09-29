<script setup lang="ts">
const route = useRoute();

const links = [
  { label: "Configuration", to: "/", icon: "i-lucide-sliders-horizontal" },
  { label: "Migration", to: "/run", icon: "i-lucide-activity" },
];
</script>

<template>
  <UApp>
    <div class="min-h-screen bg-default">
      <header class="border-b border-default bg-elevated/50 backdrop-blur sticky top-0 z-10">
        <UContainer class="flex items-center justify-between h-14">
          <NuxtLink to="/" class="flex items-center gap-2.5">
            <span
              class="size-7 rounded-lg bg-primary text-inverted grid place-items-center font-bold text-sm"
            >W</span>
            <span class="font-semibold text-highlighted">wp-to-strapi</span>
          </NuxtLink>

          <nav class="flex items-center gap-1">
            <UButton
              v-for="link in links"
              :key="link.to"
              :to="link.to"
              :icon="link.icon"
              :color="route.path === link.to ? 'primary' : 'neutral'"
              :variant="route.path === link.to ? 'soft' : 'ghost'"
              size="sm"
            >
              {{ link.label }}
            </UButton>
            <UColorModeButton />
          </nav>
        </UContainer>
      </header>

      <UContainer class="py-8">
        <NuxtPage />
      </UContainer>
    </div>
  </UApp>
</template>
