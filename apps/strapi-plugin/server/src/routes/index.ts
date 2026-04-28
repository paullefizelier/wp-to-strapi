/**
 * Admin-only routes. Anything under `admin` is mounted at /wp-import/* and
 * gated by the admin auth strategy, so only logged-in admins with the right
 * permissions can call these endpoints.
 */
export default {
  admin: {
    type: "admin",
    routes: [
      {
        method: "GET",
        path: "/settings",
        handler: "settings.get",
        config: { policies: [] },
      },
      {
        method: "PUT",
        path: "/settings",
        handler: "settings.update",
        config: { policies: [] },
      },
      {
        method: "POST",
        path: "/test-wp",
        handler: "migration.testWp",
        config: { policies: [] },
      },
      {
        method: "POST",
        path: "/start",
        handler: "migration.start",
        config: { policies: [] },
      },
      {
        method: "GET",
        path: "/status",
        handler: "migration.status",
        config: { policies: [] },
      },
      {
        method: "GET",
        path: "/events",
        handler: "migration.events",
        config: { policies: [] },
      },
    ],
  },
};
