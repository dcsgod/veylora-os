import type { DesktopSettings, ProviderConfig, Settings, SystemInfo } from "@veylora/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Save, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge, Button, Card, ErrorBox, Field, Input, KV, Notice, PageHeader, Select, Spinner, TextArea, Toggle } from "../components/ui";
import { api } from "../lib/api";
import { bridge } from "../lib/bridge";
import { useApp, type Theme } from "../store";

function useSaveSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<Settings>) => api.patch<Settings>("/settings", patch),
    onSuccess: (data) => {
      client.setQueryData(["settings"], data);
      void client.invalidateQueries({ queryKey: ["providers"] });
      void client.invalidateQueries({ queryKey: ["models"] });
    },
  });
}

function NetworkCard({ settings }: { settings: Settings }) {
  const save = useSaveSettings();
  const [text, setText] = useState(settings.network_allowlist.join("\n"));
  useEffect(() => setText(settings.network_allowlist.join("\n")), [settings.network_allowlist]);
  const hosts = text.split(/\s+/).map((h) => h.trim()).filter(Boolean);
  return (
    <Card title="Network allowlist" actions={
      <Button size="sm" variant="primary" icon={<Save className="size-3.5" />} loading={save.isPending}
        onClick={() => save.mutate({ network_allowlist: hosts })}>Save</Button>
    }>
      <p className="mb-2 text-xs text-graphite-500">
        Bare hostnames (one per line) that agents with network grants may reach without asking. Requests to any other host require
        your approval. Model runtime connections are configured under Model providers.
      </p>
      <TextArea rows={6} value={text} onChange={(e) => setText(e.target.value)} className="mono text-xs" spellCheck={false} />
      <ErrorBox error={save.error} />
    </Card>
  );
}

const BLANK: ProviderConfig = { id: "", type: "ollama", url: "", enabled: true, max_concurrency: 1, name: "", api_key_env: "" };

function ProvidersCard({ settings }: { settings: Settings }) {
  const save = useSaveSettings();
  const [rows, setRows] = useState<ProviderConfig[]>(settings.providers);
  useEffect(() => setRows(settings.providers), [settings.providers]);
  const update = (i: number, patch: Partial<ProviderConfig>) => setRows((r) => r.map((row, j) => (j === i ? { ...row, ...patch } : row)));
  const submit = () => save.mutate({
    providers: rows.map((r) => ({ ...r, url: r.url.trim(), name: r.name?.trim() || null, api_key_env: r.api_key_env?.trim() || null })),
  });
  return (
    <Card title="Model providers" actions={
      <>
        <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setRows((r) => [...r, { ...BLANK }])}>Add</Button>
        <Button size="sm" variant="primary" icon={<Save className="size-3.5" />} loading={save.isPending} onClick={submit}>Save</Button>
      </>
    }>
      <div className="space-y-3">
        {rows.map((p, i) => (
          <div key={i} className="grid gap-2 rounded-md border border-graphite-200 p-3 md:grid-cols-[130px_150px_1fr_90px_auto] dark:border-graphite-800">
            <Field label="Id"><Input value={p.id} onChange={(e) => update(i, { id: e.target.value })} className="mono" placeholder="ollama" /></Field>
            <Field label="Type">
              <Select value={p.type} onChange={(e) => update(i, { type: e.target.value as ProviderConfig["type"] })}>
                <option value="ollama">Ollama</option>
                <option value="llama_cpp">llama.cpp server</option>
                <option value="openai_compatible">OpenAI-compatible (hosted)</option>
              </Select>
            </Field>
            <Field label="URL">
              <Input value={p.url} onChange={(e) => update(i, { url: e.target.value })} className="mono"
                placeholder={p.type === "ollama" ? "http://127.0.0.1:11434" : p.type === "llama_cpp" ? "http://127.0.0.1:8080" : "https://…/v1"} />
            </Field>
            <Field label="Concurrency">
              <Select value={p.max_concurrency} onChange={(e) => update(i, { max_concurrency: Number(e.target.value) })}>
                {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => <option key={n} value={n}>{n}</option>)}
              </Select>
            </Field>
            <div className="flex items-end gap-2 pb-1">
              <Toggle checked={p.enabled} onChange={(v) => update(i, { enabled: v })} label="On" />
              <Button size="sm" variant="ghost" aria-label="Remove provider" icon={<Trash2 className="size-3.5" />}
                onClick={() => setRows((r) => r.filter((_, j) => j !== i))} />
            </div>
            {p.type === "openai_compatible" && (
              <div className="grid gap-2 md:col-span-5 md:grid-cols-2">
                <Field label="Display name"><Input value={p.name ?? ""} onChange={(e) => update(i, { name: e.target.value })} /></Field>
                <Field label="API key environment variable" hint="The key is read from this variable at runtime; it is never stored by Veylora.">
                  <Input value={p.api_key_env ?? ""} onChange={(e) => update(i, { api_key_env: e.target.value.toUpperCase() })} className="mono"
                    placeholder="OPENAI_API_KEY" />
                </Field>
              </div>
            )}
          </div>
        ))}
        {rows.length === 0 && <div className="text-xs text-graphite-500">No providers configured. Agents will not be able to call models.</div>}
      </div>
      <ErrorBox error={save.error} />
    </Card>
  );
}

function HostedCard({ settings }: { settings: Settings }) {
  const save = useSaveSettings();
  return (
    <Card title="Hosted inference">
      <div className="space-y-3">
        <Notice tone="amber">
          When authorised, projects that individually opt in may send prompts, including source code and specifications, to the hosted
          providers you configured. Local runtimes remain preferred. Nothing is sent to a hosted provider unless both this switch and the
          project setting are on.
        </Notice>
        <Toggle checked={settings.hosted_authorized} onChange={(v) => save.mutate({ hosted_authorized: v })}
          label={settings.hosted_authorized ? "Hosted inference authorised" : "Hosted inference not authorised"} />
        <ErrorBox error={save.error} />
      </div>
    </Card>
  );
}

function EngineCard({ settings }: { settings: Settings }) {
  const save = useSaveSettings();
  const [rea, setRea] = useState(settings.rea_executable ?? "");
  const [args, setArgs] = useState((settings.rea_inspect_args ?? []).join("\n"));
  useEffect(() => {
    setRea(settings.rea_executable ?? "");
    setArgs((settings.rea_inspect_args ?? []).join("\n"));
  }, [settings.rea_executable, settings.rea_inspect_args]);
  const argList = args.split("\n").map((a) => a.trim()).filter(Boolean);
  return (
    <Card title="Execution">
      <div className="space-y-4">
        <Field label="Parallel tasks" hint="Maximum tasks the scheduler runs at once. Takes effect after the backend restarts.">
          <Select value={settings.max_parallel} className="w-24" onChange={(e) => save.mutate({ max_parallel: Number(e.target.value) })}>
            {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => <option key={n} value={n}>{n}</option>)}
          </Select>
        </Field>
        {save.data?.note && <div className="text-xs text-amber-700 dark:text-amber-300">{save.data.note}</div>}
        <Field label="REA executable" hint="Optional. Absolute path to a locally built REA binary. Leave empty to search PATH.">
          <Input value={rea} onChange={(e) => setRea(e.target.value)} className="mono" />
        </Field>
        <Field label="REA inspect arguments" hint="One argument per line; must include {target}. Arguments are passed as a list, never through a shell.">
          <TextArea rows={3} value={args} onChange={(e) => setArgs(e.target.value)} className="mono text-xs" spellCheck={false} />
        </Field>
        <Button size="sm" variant="primary" icon={<Save className="size-3.5" />} loading={save.isPending}
          onClick={() => save.mutate({ rea_executable: rea.trim(), ...(argList.length ? { rea_inspect_args: argList } : {}) })}>Save REA settings</Button>
        <ErrorBox error={save.error} />
      </div>
    </Card>
  );
}

function AppearanceCard() {
  const save = useSaveSettings();
  const theme = useApp((s) => s.theme);
  const setTheme = useApp((s) => s.setTheme);
  return (
    <Card title="Appearance">
      <Field label="Theme">
        <Select value={theme} className="w-40" onChange={(e) => {
          const t = e.target.value as Theme;
          setTheme(t);
          save.mutate({ theme: t });
        }}>
          <option value="system">Match system</option><option value="light">Light</option><option value="dark">Dark</option>
        </Select>
      </Field>
    </Card>
  );
}

function DesktopCard() {
  const [desktop, setDesktop] = useState<DesktopSettings>();
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    bridge?.getDesktopSettings().then(setDesktop, setError);
  }, []);
  if (!bridge) {
    return <Card title="Desktop"><span className="text-xs text-graphite-500">Running in a browser; desktop options are available in the app.</span></Card>;
  }
  const run = (p: Promise<DesktopSettings>) => p.then(setDesktop, setError);
  return (
    <Card title="Desktop">
      {!desktop ? <Spinner /> : (
        <div className="space-y-3">
          <Toggle checked={desktop.workspaceMode} onChange={(v) => run(bridge!.setWorkspaceMode(v))}
            label="Workspace mode (full screen, Veylora as your primary environment)" />
          <Toggle checked={desktop.launchAtLogin} disabled={!desktop.launchAtLoginSupported}
            onChange={(v) => run(bridge!.setLaunchAtLogin(v))} label="Open Veylora when I sign in" />
          {!desktop.launchAtLoginSupported && <div className="text-[11px] text-graphite-500">Launch at login is not supported on this platform.</div>}
          <div className="text-[11px] text-graphite-500">App version {desktop.version}</div>
        </div>
      )}
      <ErrorBox error={error} />
    </Card>
  );
}

function SystemCard({ settings }: { settings: Settings }) {
  const system = useQuery({ queryKey: ["system"], queryFn: () => api.get<SystemInfo>("/system") });
  const s = system.data;
  const tool = (p: string | null | undefined) => (p ? <span className="mono text-xs">{p}</span> : <Badge tone="amber">not found</Badge>);
  return (
    <Card title="System">
      {system.isLoading && <Spinner />}
      <ErrorBox error={system.error} />
      {s && (
        <KV items={[
          ["Version", s.version], ["Platform", s.platform], ["Backend Python", s.python],
          ["Data directory", <span className="mono text-xs">{settings.data_dir}</span>],
          ["Node.js", tool(s.executables.node)], ["Git", tool(s.git)],
          ["Playwright", s.playwright_module ? <Badge tone="green">available</Badge> : <Badge tone="amber">not installed</Badge>],
          ["Uptime", `${Math.floor(s.uptime_s / 60)} min`],
          ["Last recovery", s.recovery ? `${s.recovery.requeued_tasks} task(s) requeued, ${s.recovery.paused_projects} project(s) paused` : "-"],
        ]} />
      )}
    </Card>
  );
}

export default function SettingsScreen() {
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api.get<Settings>("/settings") });
  return (
    <div className="space-y-5">
      <PageHeader title="Settings" subtitle="Everything stays on this machine unless you allow otherwise." />
      {settings.isLoading && <Spinner />}
      <ErrorBox error={settings.error} />
      {settings.data && (
        <div className="grid gap-5 xl:grid-cols-2">
          <div className="space-y-5">
            <ProvidersCard settings={settings.data} />
            <HostedCard settings={settings.data} />
            <NetworkCard settings={settings.data} />
          </div>
          <div className="space-y-5">
            <EngineCard settings={settings.data} />
            <AppearanceCard />
            <DesktopCard />
            <SystemCard settings={settings.data} />
          </div>
        </div>
      )}
    </div>
  );
}
