import { useEffect, useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Field,
  Flex,
  Grid,
  Layouts,
  NumberInput,
  TextInput,
  Typography,
} from "@strapi/design-system";
import { Play, Check } from "@strapi/icons";
import {
  defaultEntryMapping,
  defaultTermMapping,
  validateMapping,
  TRANSFORMS,
  type FieldMapping,
  type SourceField,
  type TargetSchema,
} from "@paullefizelier/wp-to-strapi-core/mapping";
import { api, eventsUrl } from "../api";
import pluginId from "../pluginId";

type Kind = "media" | "categories" | "tags" | "posts" | "pages" | "custom";

const KINDS: Kind[] = ["media", "categories", "tags", "posts", "pages", "custom"];

interface Settings {
  wpBaseUrl: string;
  wpUsername: string;
  wpAppPassword: string;
  postUid: string;
  categoryUid: string;
  tagUid: string;
  statuses: string[];
  customTypes: string[];
  htmlFallback: boolean;
  mapping: string;
  pageUid: string;
  concurrency: number;
  pageSize: number;
}

type MigratorEvent =
  | { type: "run-start"; at: string; kinds: Kind[] }
  | { type: "section-start"; kind: Kind }
  | { type: "section-end"; kind: Kind; total: number }
  | { type: "item-skip"; kind: Kind; wpId: number; reason: string }
  | { type: "item-ok"; kind: Kind; wpId: number; detail: string }
  | { type: "item-error"; kind: Kind; wpId: number; message: string }
  | { type: "log"; level: "info" | "warn" | "error"; message: string }
  | { type: "run-end"; at: string; summary: Record<string, number> };

const emptySettings: Settings = {
  wpBaseUrl: "",
  wpUsername: "",
  wpAppPassword: "",
  postUid: "api::post.post",
  categoryUid: "",
  tagUid: "",
  statuses: ["publish"],
  customTypes: [],
  htmlFallback: true,
  mapping: "",
  pageUid: "api::page.page",
  concurrency: 4,
  pageSize: 100,
};

const t = (id: string) => `${pluginId}.${id}`;

const HomePage = () => {
  const { formatMessage } = useIntl();
  const [settings, setSettings] = useState<Settings>(emptySettings);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [starting, setStarting] = useState(false);
  const [only, setOnly] = useState<Kind[]>(["media", "posts", "pages"]);
  const [wpFields, setWpFields] = useState<SourceField[]>([]);
  const [strapiFields, setStrapiFields] = useState<TargetSchema | null>(null);
  const [discovering, setDiscovering] = useState(false);

  /** Parse + validate the mapping as it is typed, so mistakes surface before a run. */
  const mappingState = useMemo(() => {
    const text = settings.mapping?.trim();
    if (!text) return { ok: true as const, issues: [] as string[] };
    let parsed: Record<string, FieldMapping[]>;
    try {
      parsed = JSON.parse(text) as Record<string, FieldMapping[]>;
    } catch (err) {
      return { ok: false as const, issues: [`Invalid JSON: ${(err as Error).message}`] };
    }
    const issues = Object.entries(parsed).flatMap(([kind, rows]) => {
      if (kind === "custom" && rows && !Array.isArray(rows)) {
        return Object.entries(rows as unknown as Record<string, FieldMapping[]>).flatMap(
          ([base, r]) => validateMapping(r ?? []).map((i) => `custom.${base}.${i.target}: ${i.message}`),
        );
      }
      if (!Array.isArray(rows)) return [`${kind}: expected an array of field mappings`];
      return validateMapping(rows).map((i) => `${kind}.${i.target || "?"}: ${i.message}`);
    });
    return { ok: issues.length === 0, issues };
  }, [settings.mapping]);

  async function discoverFields() {
    setDiscovering(true);
    try {
      const [wp, target] = await Promise.all([
        api<{ fields: SourceField[] }>("/fields/wp?type=posts").catch(() => ({ fields: [] })),
        api<TargetSchema>(`/fields/strapi?uid=${encodeURIComponent(settings.postUid)}`).catch(() => null),
      ]);
      setWpFields(wp.fields);
      setStrapiFields(target);
    } finally {
      setDiscovering(false);
    }
  }

  function loadDefaultMapping() {
    setSettings((s) => ({
      ...s,
      mapping: JSON.stringify(
        { common: [], post: defaultEntryMapping(), page: defaultEntryMapping(), category: defaultTermMapping() },
        null,
        2,
      ),
    }));
  }
  // Taxonomies and custom types only run when they are configured in the settings above.
  const [status, setStatus] = useState<"idle" | "running" | "completed" | "failed">("idle");
  const [events, setEvents] = useState<MigratorEvent[]>([]);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const s = await api<Settings>("/settings");
        setSettings({ ...emptySettings, ...s });
      } catch {
        // keep defaults
      } finally {
        setLoaded(true);
      }
      try {
        const s = await api<{ hasRun: boolean; status?: string }>("/status");
        if (s.hasRun) {
          setStatus((s.status as typeof status) ?? "running");
          subscribe();
        }
      } catch {
        /* ignore */
      }
    })();
    return () => {
      esRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const counters = useMemo(() => {
    const c = Object.fromEntries(
      KINDS.map((k) => [k, { ok: 0, skipped: 0, errors: 0, total: 0 }]),
    ) as Record<Kind, { ok: number; skipped: number; errors: number; total: number }>;
    for (const e of events) {
      if (e.type === "item-ok") c[e.kind].ok += 1;
      else if (e.type === "item-skip") c[e.kind].skipped += 1;
      else if (e.type === "item-error") c[e.kind].errors += 1;
      else if (e.type === "section-end") c[e.kind].total = e.total;
    }
    return c;
  }, [events]);

  async function save() {
    setSaving(true);
    try {
      const saved = await api<Settings>("/settings", {
        method: "PUT",
        body: JSON.stringify(settings),
      });
      setSettings(saved);
    } finally {
      setSaving(false);
    }
  }

  async function testWp() {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await api<{ ok: boolean; counts?: { posts: number; pages: number; media: number }; error?: string }>(
        "/test-wp",
        { method: "POST" },
      );
      if (r.ok) {
        setTestResult({
          ok: true,
          message: `${r.counts?.posts ?? 0} posts · ${r.counts?.pages ?? 0} pages · ${r.counts?.media ?? 0} media`,
        });
      } else {
        setTestResult({ ok: false, message: r.error ?? "Unknown error" });
      }
    } catch (err) {
      setTestResult({ ok: false, message: (err as Error).message });
    } finally {
      setTesting(false);
    }
  }

  function subscribe() {
    esRef.current?.close();
    const es = new EventSource(eventsUrl());
    esRef.current = es;
    es.addEventListener("progress", (ev) => {
      try {
        setEvents((prev) => {
          const next = [...prev, JSON.parse((ev as MessageEvent).data) as MigratorEvent];
          return next.length > 2000 ? next.slice(next.length - 2000) : next;
        });
      } catch {
        /* ignore */
      }
    });
    es.addEventListener("status", (ev) => {
      try {
        setStatus(JSON.parse((ev as MessageEvent).data).status);
      } catch {
        /* ignore */
      }
    });
    es.addEventListener("end", (ev) => {
      try {
        const d = JSON.parse((ev as MessageEvent).data) as { status: "completed" | "failed" };
        setStatus(d.status);
      } catch {
        /* ignore */
      }
      es.close();
    });
  }

  async function start() {
    setStarting(true);
    setEvents([]);
    try {
      await api("/start", { method: "POST", body: JSON.stringify({ only }) });
      setStatus("running");
      subscribe();
    } catch (err) {
      setTestResult({ ok: false, message: (err as Error).message });
    } finally {
      setStarting(false);
    }
  }

  function toggleKind(k: Kind, v: boolean) {
    setOnly((prev) => (v ? [...new Set([...prev, k])] : prev.filter((x) => x !== k)));
  }

  if (!loaded) return <Layouts.Root>Loading…</Layouts.Root>;

  return (
    <Layouts.Root>
      <Layouts.Header
        title={formatMessage({ id: t("page.title"), defaultMessage: "WordPress Import" })}
        subtitle={formatMessage({
          id: t("page.subtitle"),
          defaultMessage: "Configure your WordPress source and run the migration into Strapi.",
        })}
        primaryAction={
          <Button
            variant="default"
            startIcon={<Play />}
            loading={starting}
            disabled={!settings.wpBaseUrl || only.length === 0 || status === "running" || !mappingState.ok}
            onClick={start}
          >
            {formatMessage({ id: t("actions.start"), defaultMessage: "Start migration" })}
          </Button>
        }
      />
      <Layouts.Content>
        <Flex direction="column" gap={6} alignItems="stretch">
          <Box background="neutral0" padding={6} hasRadius shadow="tableShadow">
            <Typography variant="delta" tag="h2">
              {formatMessage({ id: t("settings.wp.title"), defaultMessage: "WordPress source" })}
            </Typography>
            <Box paddingTop={4}>
              <Grid.Root gap={4}>
                <Grid.Item col={12} s={12}>
                  <Field.Root name="wpBaseUrl" required>
                    <Field.Label>
                      {formatMessage({ id: t("settings.wp.baseUrl"), defaultMessage: "WordPress site URL" })}
                    </Field.Label>
                    <TextInput
                      placeholder="https://example.com"
                      value={settings.wpBaseUrl}
                      onChange={(e: { target: { value: string } }) =>
                        setSettings((s) => ({ ...s, wpBaseUrl: e.target.value }))
                      }
                    />
                  </Field.Root>
                </Grid.Item>
                <Grid.Item col={6} s={12}>
                  <Field.Root name="wpUsername">
                    <Field.Label>
                      {formatMessage({ id: t("settings.wp.username"), defaultMessage: "Username (optional)" })}
                    </Field.Label>
                    <TextInput
                      value={settings.wpUsername}
                      onChange={(e: { target: { value: string } }) =>
                        setSettings((s) => ({ ...s, wpUsername: e.target.value }))
                      }
                    />
                  </Field.Root>
                </Grid.Item>
                <Grid.Item col={6} s={12}>
                  <Field.Root name="wpAppPassword">
                    <Field.Label>
                      {formatMessage({ id: t("settings.wp.appPassword"), defaultMessage: "Application password" })}
                    </Field.Label>
                    <TextInput
                      type="password"
                      value={settings.wpAppPassword}
                      onChange={(e: { target: { value: string } }) =>
                        setSettings((s) => ({ ...s, wpAppPassword: e.target.value }))
                      }
                    />
                  </Field.Root>
                </Grid.Item>
              </Grid.Root>
            </Box>
            <Flex gap={2} paddingTop={4}>
              <Button variant="secondary" loading={saving} onClick={save}>
                {formatMessage({ id: t("actions.save"), defaultMessage: "Save settings" })}
              </Button>
              <Button
                variant="tertiary"
                loading={testing}
                disabled={!settings.wpBaseUrl}
                onClick={testWp}
                startIcon={<Check />}
              >
                {formatMessage({ id: t("actions.testConnection"), defaultMessage: "Test connection" })}
              </Button>
            </Flex>
            {testResult && (
              <Box paddingTop={4}>
                <Alert
                  variant={testResult.ok ? "success" : "danger"}
                  title={testResult.ok ? "Connection OK" : "Connection failed"}
                  closeLabel="Close"
                  onClose={() => setTestResult(null)}
                >
                  {testResult.message}
                </Alert>
              </Box>
            )}
          </Box>

          <Box background="neutral0" padding={6} hasRadius shadow="tableShadow">
            <Typography variant="delta" tag="h2">
              {formatMessage({ id: t("settings.strapi.title"), defaultMessage: "Strapi destination" })}
            </Typography>
            <Box paddingTop={4}>
              <Grid.Root gap={4}>
                <Grid.Item col={6} s={12}>
                  <Field.Root name="postUid">
                    <Field.Label>
                      {formatMessage({ id: t("settings.strapi.postUid"), defaultMessage: "Posts UID" })}
                    </Field.Label>
                    <TextInput
                      value={settings.postUid}
                      onChange={(e: { target: { value: string } }) =>
                        setSettings((s) => ({ ...s, postUid: e.target.value }))
                      }
                    />
                  </Field.Root>
                </Grid.Item>
                <Grid.Item col={6} s={12}>
                  <Field.Root name="pageUid">
                    <Field.Label>
                      {formatMessage({ id: t("settings.strapi.pageUid"), defaultMessage: "Pages UID" })}
                    </Field.Label>
                    <TextInput
                      value={settings.pageUid}
                      onChange={(e: { target: { value: string } }) =>
                        setSettings((s) => ({ ...s, pageUid: e.target.value }))
                      }
                    />
                  </Field.Root>
                </Grid.Item>
                <Grid.Item col={6} s={12}>
                  <Field.Root name="categoryUid">
                    <Field.Label>
                      {formatMessage({ id: t("settings.strapi.categoryUid"), defaultMessage: "Categories UID (empty = skip)" })}
                    </Field.Label>
                    <TextInput
                      placeholder="api::category.category"
                      value={settings.categoryUid}
                      onChange={(e: { target: { value: string } }) =>
                        setSettings((s) => ({ ...s, categoryUid: e.target.value }))
                      }
                    />
                  </Field.Root>
                </Grid.Item>
                <Grid.Item col={6} s={12}>
                  <Field.Root name="tagUid">
                    <Field.Label>
                      {formatMessage({ id: t("settings.strapi.tagUid"), defaultMessage: "Tags UID (empty = skip)" })}
                    </Field.Label>
                    <TextInput
                      placeholder="api::tag.tag"
                      value={settings.tagUid}
                      onChange={(e: { target: { value: string } }) =>
                        setSettings((s) => ({ ...s, tagUid: e.target.value }))
                      }
                    />
                  </Field.Root>
                </Grid.Item>
                <Grid.Item col={12}>
                  <Field.Root name="customTypes">
                    <Field.Label>
                      {formatMessage({ id: t("settings.strapi.customTypes"), defaultMessage: "Custom post types — restBase:api::uid.uid, comma separated" })}
                    </Field.Label>
                    <TextInput
                      placeholder="portfolio:api::project.project, event:api::event.event"
                      value={settings.customTypes.join(", ")}
                      onChange={(e: { target: { value: string } }) =>
                        setSettings((s) => ({
                          ...s,
                          customTypes: e.target.value
                            .split(",")
                            .map((v) => v.trim())
                            .filter(Boolean),
                        }))
                      }
                    />
                  </Field.Root>
                </Grid.Item>
                <Grid.Item col={6} s={12}>
                  <Field.Root name="concurrency">
                    <Field.Label>
                      {formatMessage({ id: t("settings.options.concurrency"), defaultMessage: "Concurrency" })}
                    </Field.Label>
                    <NumberInput
                      value={settings.concurrency}
                      onValueChange={(v?: number) => setSettings((s) => ({ ...s, concurrency: v ?? 4 }))}
                    />
                  </Field.Root>
                </Grid.Item>
                <Grid.Item col={6} s={12}>
                  <Field.Root name="pageSize">
                    <Field.Label>
                      {formatMessage({ id: t("settings.options.pageSize"), defaultMessage: "WP page size" })}
                    </Field.Label>
                    <NumberInput
                      value={settings.pageSize}
                      onValueChange={(v?: number) => setSettings((s) => ({ ...s, pageSize: v ?? 100 }))}
                    />
                  </Field.Root>
                </Grid.Item>
              </Grid.Root>
            </Box>
          </Box>

          <Box background="neutral0" padding={6} hasRadius shadow="tableShadow">
            <Flex justifyContent="space-between" alignItems="center">
              <Typography variant="delta" tag="h2">
                Field mapping
              </Typography>
              <Flex gap={2}>
                <Button size="S" variant="tertiary" loading={discovering} onClick={discoverFields}>
                  Read available fields
                </Button>
                <Button size="S" variant="secondary" onClick={loadDefaultMapping}>
                  Load the built-in mapping
                </Button>
              </Flex>
            </Flex>
            <Box paddingTop={2}>
              <Typography variant="pi" textColor="neutral600">
                JSON keyed by kind — common, post, page, category, tag, custom. Each row writes one
                Strapi field from a WordPress path (<code>source</code>) or a constant
                (<code>value</code>). Leave empty for the built-in mapping. Transforms:{" "}
                {Object.keys(TRANSFORMS).join(", ")}.
              </Typography>
            </Box>
            <Box paddingTop={3}>
              <textarea
                value={settings.mapping}
                spellCheck={false}
                rows={12}
                onChange={(e) => setSettings((s) => ({ ...s, mapping: e.target.value }))}
                placeholder={'{\n  "common": [{ "target": "locale", "value": "fr" }]\n}'}
                style={{
                  width: "100%",
                  fontFamily: "ui-monospace, SFMono-Regular, monospace",
                  fontSize: 12,
                  lineHeight: 1.5,
                  padding: 12,
                  borderRadius: 4,
                  border: `1px solid ${mappingState.ok ? "#dcdce4" : "#d02b20"}`,
                }}
              />
            </Box>
            {!mappingState.ok && (
              <Box paddingTop={2}>
                <Alert closeLabel="Close" title="Invalid mapping" variant="danger">
                  {mappingState.issues.join(" · ")}
                </Alert>
              </Box>
            )}
            {(wpFields.length > 0 || strapiFields) && (
              <Box paddingTop={3}>
                <Typography variant="pi" fontWeight="bold">
                  WordPress paths ({wpFields.length})
                </Typography>
                <Box
                  padding={2}
                  background="neutral100"
                  hasRadius
                  style={{ maxHeight: 140, overflowY: "auto", fontFamily: "ui-monospace, monospace", fontSize: 11 }}
                >
                  {wpFields.map((f) => `${f.path}`).join("  ·  ")}
                </Box>
                <Box paddingTop={2}>
                  <Typography variant="pi" fontWeight="bold">
                    Strapi fields on {settings.postUid} ({strapiFields?.source ?? "none"})
                  </Typography>
                </Box>
                <Box
                  padding={2}
                  background="neutral100"
                  hasRadius
                  style={{ maxHeight: 120, overflowY: "auto", fontFamily: "ui-monospace, monospace", fontSize: 11 }}
                >
                  {(strapiFields?.fields ?? []).map((f) => `${f.name}: ${f.type ?? "?"}`).join("  ·  ")}
                </Box>
              </Box>
            )}
          </Box>

          <Box background="neutral0" padding={6} hasRadius shadow="tableShadow">
            <Typography variant="delta" tag="h2">
              Content to migrate
            </Typography>
            <Flex gap={6} paddingTop={4} wrap="wrap">
              {KINDS.map((k) => (
                <Checkbox
                  key={k}
                  checked={only.includes(k)}
                  onCheckedChange={(v: boolean) => toggleKind(k, Boolean(v))}
                >
                  {k}
                </Checkbox>
              ))}
            </Flex>
            <Flex gap={6} paddingTop={4} wrap="wrap">
              <Checkbox
                checked={settings.statuses.length > 1}
                onCheckedChange={(v: boolean) =>
                  setSettings((s) => ({
                    ...s,
                    statuses: v ? ["publish", "draft", "pending", "future", "private"] : ["publish"],
                  }))
                }
              >
                Include drafts and scheduled (imported as Strapi drafts)
              </Checkbox>
              <Checkbox
                checked={settings.htmlFallback}
                onCheckedChange={(v: boolean) =>
                  setSettings((s) => ({ ...s, htmlFallback: Boolean(v) }))
                }
              >
                Recover page-builder content from the public page
              </Checkbox>
            </Flex>
            <Box paddingTop={2}>
              <Typography variant="pi" textColor="neutral600">
                Categories, tags and custom types only run when configured above. Settings are
                saved with the button at the top.
              </Typography>
            </Box>
          </Box>

          {status !== "idle" && (
            <Box background="neutral0" padding={6} hasRadius shadow="tableShadow">
              <Flex justifyContent="space-between" alignItems="center">
                <Typography variant="delta" tag="h2">
                  Progress
                </Typography>
                <Typography variant="sigma" textColor={status === "failed" ? "danger600" : status === "completed" ? "success600" : "primary600"}>
                  {formatMessage({ id: t(`status.${status}`), defaultMessage: status })}
                </Typography>
              </Flex>
              <Grid.Root gap={4} paddingTop={4}>
                {KINDS.map((k) => (
                  <Grid.Item key={k} col={4} s={12} direction="column" alignItems="start">
                    <Typography variant="sigma" textColor="neutral600">
                      {k}
                    </Typography>
                    <Typography variant="alpha">
                      {counters[k].ok}
                      {counters[k].total ? ` / ${counters[k].total}` : ""}
                    </Typography>
                    {(counters[k].errors > 0 || counters[k].skipped > 0) && (
                      <Typography variant="pi" textColor="neutral500">
                        {counters[k].skipped} skipped · {counters[k].errors} errors
                      </Typography>
                    )}
                  </Grid.Item>
                ))}
              </Grid.Root>
              <Box
                marginTop={4}
                padding={3}
                background="neutral100"
                hasRadius
                style={{
                  fontFamily: "ui-monospace, SFMono-Regular, monospace",
                  fontSize: 12,
                  maxHeight: 320,
                  overflowY: "auto",
                }}
              >
                {events.map((e, i) => (
                  <div key={i}>
                    {e.type === "item-ok" && `✓ ${e.kind} #${e.wpId} ${e.detail}`}
                    {e.type === "item-skip" && `– ${e.kind} #${e.wpId} (${e.reason})`}
                    {e.type === "item-error" && `✗ ${e.kind} #${e.wpId}: ${e.message}`}
                    {e.type === "section-start" && `▶ ${e.kind}`}
                    {e.type === "section-end" && `■ ${e.kind} (${e.total})`}
                    {e.type === "log" && `${e.level === "info" ? "ℹ" : "⚠"} ${e.message}`}
                  </div>
                ))}
              </Box>
            </Box>
          )}
        </Flex>
      </Layouts.Content>
    </Layouts.Root>
  );
};

export default HomePage;
