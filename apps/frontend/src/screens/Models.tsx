import type { ModelConfig, ProviderConfig, ProviderHealth, Role, RouteDecision } from "@veylora/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cpu, FlaskConical, RefreshCw, Route as RouteIcon } from "lucide-react";
import { useState } from "react";
import { Badge, Button, Card, Drawer, Empty, ErrorBox, Field, Input, KV, Notice, PageHeader, Pre, Select, Spinner, Table, TextArea,
         Toggle } from "../components/ui";
import { api } from "../lib/api";
import { bytes, duration, timeAgo } from "../lib/format";

const TASK_TYPES = [
  "specification", "architecture", "discovery", "repo_analysis", "rea_inspect", "scaffold", "implement", "generate_feature", "repair",
  "integrate", "test", "browser_test", "review_code", "review_security", "docs", "verify", "llm_task",
];

function useRoles() {
  return useQuery({ queryKey: ["roles"], queryFn: () => api.get<Role[]>("/roles"), staleTime: Infinity });
}

function ProvidersCard() {
  const client = useQueryClient();
  const providers = useQuery({
    queryKey: ["providers"],
    queryFn: () => api.get<{ configured: ProviderConfig[]; health: ProviderHealth[] }>("/models/providers"),
    refetchInterval: 15000,
  });
  const sync = useMutation({
    mutationFn: () => api.post<Record<string, { ok: boolean; error?: string; models?: string[] }>>("/models/sync"),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ["models"] });
      void client.invalidateQueries({ queryKey: ["providers"] });
    },
  });
  const health = new Map((providers.data?.health ?? []).map((h) => [h.provider, h]));
  return (
    <Card title="Model runtimes" actions={
      <Button size="sm" icon={<RefreshCw className="size-3.5" />} loading={sync.isPending} onClick={() => sync.mutate()}>Discover models</Button>
    }>
      {providers.isLoading && <Spinner />}
      <ErrorBox error={providers.error ?? sync.error} />
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {(providers.data?.configured ?? []).map((cfg) => {
          const h = health.get(cfg.id);
          return (
            <div key={cfg.id} className="rounded-md border border-graphite-200 p-3 dark:border-graphite-800">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="font-medium">{cfg.name || cfg.id} <span className="text-[11px] text-graphite-500">{cfg.type}</span></div>
                {!cfg.enabled ? <Badge>disabled</Badge> : h?.ok ? <Badge tone="green">connected</Badge> : <Badge tone="red">unreachable</Badge>}
              </div>
              <KV items={[
                ["Endpoint", <span className="mono text-xs">{cfg.url || "default"}</span>],
                ["Kind", h?.kind ?? (cfg.type === "openai_compatible" ? "hosted" : "local")],
                ["Version", h?.version],
                ["Loaded", h?.loaded_models?.length ? h.loaded_models.join(", ") : "-"],
                ["Queue", h ? `${h.active} active · ${h.queued} queued · limit ${h.max_concurrency}` : "-"],
                ["Detail", h && !h.ok && h.detail ? <span className="text-xs text-red-600">{h.detail}</span> : "-"],
              ]} />
            </div>
          );
        })}
      </div>
      {sync.data && (
        <div className="mt-3 space-y-1 text-xs">
          {Object.entries(sync.data).map(([pid, r]) => (
            <div key={pid}>
              <span className="font-medium">{pid}:</span>{" "}
              {r.ok ? `${r.models?.length ?? 0} model(s) reported by the runtime` : <span className="text-red-600">{r.error}</span>}
            </div>
          ))}
        </div>
      )}
      <p className="mt-3 text-[11px] text-graphite-500">
        Only models reported by a running runtime are marked installed. Veylora never downloads models on its own; use your runtime (for example
        <span className="mono"> ollama pull</span>) and then discover again.
      </p>
    </Card>
  );
}

function ModelDetail({ model, onClose }: { model?: ModelConfig; onClose(): void }) {
  const client = useQueryClient();
  const roles = useRoles();
  const [prompt, setPrompt] = useState("Reply with the single word: ready");
  const patch = useMutation({
    mutationFn: (body: Partial<{ enabled: boolean; role_assignments: string[]; max_concurrency: number }>) =>
      api.patch<ModelConfig>(`/models/${model!.id}`, body),
    onSettled: () => void client.invalidateQueries({ queryKey: ["models"] }),
  });
  const test = useMutation({
    mutationFn: () => api.post<{ text: string; latency_ms: number; input_tokens: number | null; output_tokens: number | null }>(
      `/models/${model!.id}/test`, { prompt }),
  });
  const m = model;
  return (
    <Drawer open={Boolean(m)} onClose={() => { test.reset(); onClose(); }} title={m ? m.name : "Model"} width="w-[640px]">
      {m && (
        <div className="space-y-5">
          <KV items={[
            ["Provider", `${m.provider} (${m.provider_kind})`], ["Family", m.family], ["Parameters", m.parameter_size],
            ["Quantization", m.quantization], ["Context", m.context_length?.toLocaleString()], ["Size", bytes(m.size_bytes)],
            ["Installed", m.installed ? <Badge tone="green">reported by runtime</Badge> : <Badge tone="amber">not reported</Badge>],
            ["Last seen", timeAgo(m.last_seen_at)],
            ["Tags", m.capabilities.map((c) => <Badge key={c} className="mr-1">{c}</Badge>)],
          ]} />
          <div className="flex flex-wrap items-center gap-4">
            <Toggle checked={Boolean(m.enabled)} onChange={(v) => patch.mutate({ enabled: v })} label="Available to the router" />
            <Field label="Concurrency">
              <Select value={m.max_concurrency} className="w-24" onChange={(e) => patch.mutate({ max_concurrency: Number(e.target.value) })}>
                {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => <option key={n} value={n}>{n}</option>)}
              </Select>
            </Field>
          </div>
          <div>
            <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-graphite-500">Preferred for roles</h4>
            <div className="flex flex-wrap gap-1.5">
              {(roles.data ?? []).map((r) => {
                const on = m.role_assignments.includes(r.id);
                return (
                  <button key={r.id} onClick={() => patch.mutate({
                    role_assignments: on ? m.role_assignments.filter((x) => x !== r.id) : [...m.role_assignments, r.id],
                  })}
                    className={on ? "rounded border border-accent-500 bg-accent-50 px-2 py-0.5 text-xs text-accent-800 dark:bg-accent-500/15 dark:text-accent-200"
                                  : "rounded border border-graphite-200 px-2 py-0.5 text-xs text-graphite-600 hover:bg-graphite-100 dark:border-graphite-700 dark:text-graphite-300 dark:hover:bg-graphite-800"}>
                    {r.title}
                  </button>
                );
              })}
            </div>
            <p className="mt-1 text-[11px] text-graphite-500">Assignments are a routing preference; capability and health checks still apply.</p>
          </div>
          <ErrorBox error={patch.error} />
          <div>
            <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-graphite-500">Outcomes</h4>
            {m.outcomes.length === 0 ? <span className="text-graphite-500">No recorded executions yet.</span> : (
              <Table head={["Task class", "Successes", "Failures", "Mean latency"]}>
                {m.outcomes.map((o) => (
                  <tr key={o.task_class}>
                    <td>{o.task_class}</td><td>{o.successes}</td><td>{o.failures}</td>
                    <td>{duration(o.successes + o.failures ? Math.round(o.total_latency_ms / (o.successes + o.failures)) : null)}</td>
                  </tr>
                ))}
              </Table>
            )}
          </div>
          <div className="space-y-2">
            <h4 className="text-[11px] font-semibold uppercase tracking-wide text-graphite-500">Test generation</h4>
            {m.provider_kind === "hosted" && <Notice tone="amber">This sends the prompt below to a hosted provider.</Notice>}
            <TextArea rows={2} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
            <Button icon={<FlaskConical className="size-3.5" />} loading={test.isPending} disabled={!m.provider_connected}
              onClick={() => test.mutate()}>Run test</Button>
            {!m.provider_connected && <span className="ml-2 text-xs text-graphite-500">Runtime is not connected.</span>}
            <ErrorBox error={test.error} />
            {test.data && (
              <>
                <Pre>{test.data.text || "(empty response)"}</Pre>
                <div className="text-[11px] text-graphite-500">
                  {duration(test.data.latency_ms)} · tokens in {test.data.input_tokens ?? "-"} / out {test.data.output_tokens ?? "-"}
                  {test.data.input_tokens === null && " (not reported by runtime)"}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </Drawer>
  );
}

function RoutePreview() {
  const roles = useRoles();
  const [taskType, setTaskType] = useState("implement");
  const [role, setRole] = useState("backend_engineer");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const route = useMutation({
    mutationFn: () => api.post<RouteDecision>("/models/route", { task_type: taskType, role, title, description }),
  });
  return (
    <Card title={<span className="inline-flex items-center gap-1.5"><RouteIcon className="size-4" /> Routing preview</span>}>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Task type">
          <Select value={taskType} onChange={(e) => setTaskType(e.target.value)}>
            {TASK_TYPES.map((t) => <option key={t} value={t}>{t.replaceAll("_", " ")}</option>)}
          </Select>
        </Field>
        <Field label="Role">
          <Select value={role} onChange={(e) => setRole(e.target.value)}>
            {(roles.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
          </Select>
        </Field>
        <Field label="Title"><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Optional, used for complexity hints" /></Field>
        <Field label="Description"><Input value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
      </div>
      <div className="mt-3"><Button variant="primary" loading={route.isPending} onClick={() => route.mutate()}>Preview route</Button></div>
      <ErrorBox error={route.error} />
      {route.data && (
        <div className="mt-4 space-y-3">
          <KV items={[
            ["Selected", route.data.model_name ? <span className="mono">{route.data.provider}/{route.data.model_name}</span>
                                               : <Badge tone="amber">no model available</Badge>],
            ["Class", `${route.data.task_class} · ${route.data.complexity}`],
            ["Reason", route.data.reason],
          ]} />
          {route.data.considered.length > 0 && (
            <Table head={["Candidate", "Score", "Notes"]}>
              {route.data.considered.map((c) => (
                <tr key={c.model_id}>
                  <td className="mono">{c.model}</td>
                  <td>{c.excluded ? <Badge tone="red">excluded</Badge> : c.score?.toFixed(2)}</td>
                  <td className="text-xs text-graphite-500">{c.excluded ?? (c.notes ?? []).join("; ")}</td>
                </tr>
              ))}
            </Table>
          )}
        </div>
      )}
    </Card>
  );
}

export default function Models() {
  const models = useQuery({ queryKey: ["models"], queryFn: () => api.get<ModelConfig[]>("/models") });
  const [selected, setSelected] = useState<string>();
  const current = models.data?.find((m) => m.id === selected);
  return (
    <div className="space-y-5">
      <PageHeader title="Models" subtitle="Local runtimes first. Hosted providers are used only when you configure and authorise them." />
      <ProvidersCard />
      <Card title="Discovered models" bodyClassName="p-0">
        {models.isLoading && <Spinner />}
        <ErrorBox error={models.error} />
        <Table head={["Model", "Provider", "Family", "Params", "Quant", "Context", "Size", "State", "Roles", "Runs"]}
          empty={!models.isLoading && <Empty icon={<Cpu className="size-6" />} title="No models discovered">
            Start a local runtime such as Ollama, pull a model, then choose Discover models.
          </Empty>}>
          {(models.data ?? []).map((m) => {
            const runs = m.outcomes.reduce((n, o) => n + o.successes + o.failures, 0);
            return (
              <tr key={m.id} onClick={() => setSelected(m.id)} className="cursor-pointer hover:bg-graphite-50 dark:hover:bg-graphite-850">
                <td className="mono font-medium">{m.name}</td>
                <td>{m.provider} {m.provider_kind === "hosted" && <Badge tone="violet">hosted</Badge>}</td>
                <td>{m.family ?? "-"}</td>
                <td>{m.parameter_size ?? "-"}</td>
                <td>{m.quantization ?? "-"}</td>
                <td>{m.context_length?.toLocaleString() ?? "-"}</td>
                <td>{bytes(m.size_bytes)}</td>
                <td className="space-x-1">
                  {!m.enabled ? <Badge>disabled</Badge> : !m.installed ? <Badge tone="amber">not installed</Badge>
                    : m.provider_connected ? <Badge tone="green">ready</Badge> : <Badge tone="red">runtime offline</Badge>}
                </td>
                <td className="text-xs">{m.role_assignments.length ? m.role_assignments.join(", ") : <span className="text-graphite-400">any</span>}</td>
                <td>{runs}</td>
              </tr>
            );
          })}
        </Table>
      </Card>
      <RoutePreview />
      <ModelDetail model={current} onClose={() => setSelected(undefined)} />
    </div>
  );
}
