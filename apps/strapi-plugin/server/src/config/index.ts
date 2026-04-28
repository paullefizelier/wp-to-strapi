/**
 * Plugin defaults. Users override these via config/plugins.ts:
 *
 *   export default () => ({
 *     'wp-import': {
 *       enabled: true,
 *       config: { postUid: 'api::article.article' },
 *     },
 *   });
 */
export default {
  default: {
    postUid: "api::post.post",
    pageUid: "api::page.page",
    stateFile: "./.wp-import-state.json",
    concurrency: 4,
    pageSize: 100,
  },
  validator() {
    // Optional validation hook — add strict checks here if you want to fail fast.
  },
};
