<template>
  <UApp>
    <div class="min-h-screen bg-gray-50 dark:bg-gray-950">
      <header class="border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
        <div class="max-w-4xl mx-auto px-6 py-4 flex items-center justify-between">
          <NuxtLink to="/" class="flex items-center gap-2">
            <div class="w-8 h-8 rounded-lg bg-indigo-500 text-white flex items-center justify-center font-bold">W</div>
            <span class="font-semibold text-gray-900 dark:text-white">wp-to-strapi</span>
          </NuxtLink>
          <nav class="flex items-center gap-4 text-sm">
            <NuxtLink to="/" class="text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white">Config</NuxtLink>
            <NuxtLink to="/run" class="text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white">Run</NuxtLink>
            <UButton
              to="https://github.com"
              target="_blank"
              color="gray"
              variant="ghost"
              icon="i-heroicons-arrow-top-right-on-square"
              size="xs"
            >
              GitHub
            </UButton>
          </nav>
        </div>
      </header>
      <main class="max-w-4xl mx-auto px-6 py-8">
        <NuxtPage />
      </main>
    </div>
    <UNotifications />
  </UApp>
</template>
