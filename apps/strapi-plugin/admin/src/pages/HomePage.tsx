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
import { api, eventsUrl } from "../api";
import pluginId from "../pluginId";

type Kind = "media" | "posts" | "pages";

interface Settings {
  wpBaseUrl: string;
  wpUsername: string;
  wpAppPassword: string;
  postUid: string;
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
  | { type: "run-end"; at: string; summary: { media: number; posts: number; pages: number } };

const emptySettings: Settings = {
  wpBaseUrl: "",
  wpUsername: "",
  wpAppPassword: "",
  postUid: "api::post.post",
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
    const c: Record<Kind, { ok: number; skipped: number; errors: number; total: number }> = {
      media: { ok: 0, skipped: 0, errors: 0, total: 0 },
      posts: { ok: 0, skipped: 0, errors: 0, total: 0 },
      pages: { ok: 0, skipped: 0, errors: 0, total: 0 },
    };
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
            disabled={!settings.wpBaseUrl || only.length === 0 || status === "running"}
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
            <Typography variant="delta" tag="h2">
              Content to migrate
            </Typography>
            <Flex gap={6} paddingTop={4}>
              {(["media", "posts", "pages"] as const).map((k) => (
                <Checkbox
                  key={k}
                  checked={only.includes(k)}
                  onCheckedChange={(v: boolean) => toggleKind(k, Boolean(v))}
                >
                  {k}
                </Checkbox>
              ))}
            </Flex>
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
                {(["media", "posts", "pages"] as const).map((k) => (
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
