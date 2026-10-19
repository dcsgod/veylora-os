import type { Project, ProviderHealth, Specification, SystemInfo } from "@veylora/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, FileText, Play, Wand2 } from "lucide-react";
import { useState } from "react";
import { usePendingApprovals, useProjects } from "../components/Shell";
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, KV, Notice, PageHeader, Pre, Select, StatusBadge, TextArea, Toggle } from "../components/ui";
import { api } from "../lib/api";
import { timeAgo } from "../lib/format";
import { useApp } from "../store";

const EXAMPLES = [
  {
    label: "Supply-chain planner",
    text: "Build a supply-chain planning web app: upload CSV demand history, forecast demand per SKU, compute safety stock and reorder points, and show an inventory dashboard with exportable purchase recommendations.",
  },
  {
    label: "Design editor",
    text: "Build a browser-based design editor similar in spirit to Canva: a canvas with shapes, text and images, layers, alignment tools, undo/redo, templates, and PNG export.",
  },
  {
    label: "Repository analysis",
    text: "Analyse the morluto/rea repository and summarise its architecture, languages and capabilities with evidence.",
  },
];

const DOMAINS = [
  ["", "Detect automatically"],
  ["supply_chain", "Supply-chain planning"],
  ["design_editor", "Design editor"],
  ["repo_analysis", "Repository analysis"],
  ["generic", "General web application"],
];

export function progress(p: Project) {
  const counts = p.task_counts ?? {};
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { done: counts.completed ?? 0, total, failed: counts.failed ?? 0 };
}

function SystemCard() {
  const system = useQuery({ queryKey: ["system"], queryFn: () => api.get<SystemInfo>("/system") });
  const providers = useQuery({ queryKey: ["providers"], queryFn: () => api.get<{ health: ProviderHealth[] }>("/models/providers") });
  const approvals = usePendingApprovals();
  const navigate = useApp((s) => s.navigate);
  const local = providers.data?.health.filter((h) => h.kind === "local") ?? [];
  return (
    <Card title="Local environment">
      <KV items={[
        ["Model runtimes", local.length ? (
          <div className="flex flex-wrap gap-1">
            {local.map((h) => <Badge key={h.provider} tone={h.ok ? "green" : "amber"} title={h.detail}>{h.name}: {h.ok ? "connected" : "offline"}</Badge>)}
          </div>
        ) : "-"],
        ["Node.js", system.data?.executables?.node ? <Badge tone="green">available</Badge> : <Badge tone="red">missing</Badge>],
        ["Git", system.data?.git ? <Badge tone="green">available</Badge> : <Badge tone="red">missing</Badge>],
        ["Browser tests", system.data ? (system.data.playwright_module ? <Badge tone="green">Playwright ready</Badge> : <Badge tone="amber">Playwright missing</Badge>) : "-"],
        ["Approvals", approvals.data?.length ? (
          <button className="text-amber-700 underline dark:text-amber-300" onClick={() => navigate({ screen: "security" })}>
            {approvals.data.length} waiting for you
          </button>
        ) : "none pending"],
        ["Version", system.data?.version],
      ]} />
      {local.length > 0 && !local.some((h) => h.ok) && (
        <div className="mt-3">
          <Notice tone="amber">
            No local model runtime is reachable. Deterministic blueprints (supply chain, design editor) still build; model-generated features
            need Ollama or llama.cpp. Start one and sync in Model Studio.
          </Notice>
        </div>
      )}
    </Card>
  );
}

export function Home() {
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [auto, setAuto] = useState(false);
  const [preview, setPreview] = useState<{ spec: Specification; markdown: string } | null>(null);
  const navigate = useApp((s) => s.navigate);
  const client = useQueryClient();
  const projects = useProjects();

  const previewSpec = useMutation({
    mutationFn: () => api.post<{ spec: Specification; markdown: string }>("/projects/preview-spec", { request: text, domain: domain || null }),
    onSuccess: setPreview,
  });
  const create = useMutation({
    mutationFn: () => api.post<Project>("/projects", {
      request: text, name: name || null, domain: domain || null, autonomy: auto ? "auto" : "review", spec: preview?.spec ?? null,
    }),
    onSuccess: (p) => {
      void client.invalidateQueries({ queryKey: ["projects"] });
      navigate({ screen: "studio", projectId: p.id });
    },
  });

  const valid = text.trim().length >= 3;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="What should we build?" subtitle="Describe the outcome. Veylora turns it into a specification, a plan and a working, tested system on this machine." />
      <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
        <div className="space-y-5">
          <Card>
            <TextArea rows={5} value={text} placeholder="e.g. Build an inventory planner that forecasts demand from my sales CSV..."
              onChange={(e) => { setText(e.target.value); setPreview(null); }} className="text-[14px]" />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {EXAMPLES.map((ex) => (
                <button key={ex.label} onClick={() => { setText(ex.text); setPreview(null); }}
                  className="rounded-full border border-graphite-200 px-2.5 py-1 text-xs text-graphite-600 hover:border-accent-400 hover:text-accent-700 dark:border-graphite-700 dark:text-graphite-300">
                  {ex.label}
                </button>
              ))}
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <Field label="Project name (optional)"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} /></Field>
              <Field label="Domain">
                <Select value={domain} onChange={(e) => { setDomain(e.target.value); setPreview(null); }}>
                  {DOMAINS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </Select>
              </Field>
            </div>
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <Toggle checked={auto} onChange={setAuto} label={auto ? "Run automatically after planning" : "Review the plan before running"} />
              <div className="flex gap-2">
                <Button icon={<FileText className="size-3.5" />} disabled={!valid} loading={previewSpec.isPending} onClick={() => previewSpec.mutate()}>
                  Preview specification
                </Button>
                <Button variant="primary" icon={auto ? <Play className="size-3.5" /> : <Wand2 className="size-3.5" />} disabled={!valid}
                  loading={create.isPending} onClick={() => create.mutate()}>
                  {auto ? "Create and run" : "Create project"}
                </Button>
              </div>
            </div>
            <div className="mt-3 space-y-2">
              <ErrorBox error={previewSpec.error} />
              <ErrorBox error={create.error} />
            </div>
          </Card>

          {preview && (
            <Card title="Specification preview" actions={
              <>
                <Badge tone="blue">{preview.spec.domain.replaceAll("_", " ")}</Badge>
                {preview.spec.blueprint && <Badge tone="violet">blueprint: {preview.spec.blueprint}</Badge>}
              </>
            }>
              <p className="mb-3 text-xs text-graphite-500">
                Derived deterministically from your request. You can edit the specification after the project is created; edits re-plan the work.
              </p>
              <Pre className="max-h-[420px]">{preview.markdown}</Pre>
            </Card>
          )}

          <Card title="Recent projects" bodyClassName="p-0">
            {projects.isLoading ? null : !projects.data?.length ? (
              <Empty title="No projects yet">Describe something above to create your first project.</Empty>
            ) : (
              <ul className="divide-y divide-graphite-100 dark:divide-graphite-800">
                {projects.data.slice(0, 12).map((p) => {
                  const pr = progress(p);
                  return (
                    <li key={p.id}>
                      <button className="flex w-full items-center gap-4 px-4 py-3 text-left hover:bg-graphite-50 dark:hover:bg-graphite-850"
                        onClick={() => navigate({ screen: "studio", projectId: p.id })}>
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium">{p.name}</div>
                          <div className="truncate text-xs text-graphite-500">{p.domain.replaceAll("_", " ")} · updated {timeAgo(p.updated_at)}</div>
                        </div>
                        <div className="w-36">
                          <div className="h-1.5 overflow-hidden rounded-full bg-graphite-100 dark:bg-graphite-800">
                            <div className={pr.failed ? "h-full bg-red-500" : "h-full bg-accent-500"} style={{ width: `${pr.total ? (pr.done / pr.total) * 100 : 0}%` }} />
                          </div>
                          <div className="mt-1 text-[11px] text-graphite-500">{pr.done}/{pr.total} tasks</div>
                        </div>
                        <StatusBadge status={p.status} />
                        <ArrowRight className="size-4 text-graphite-400" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>
        <div className="space-y-5">
          <SystemCard />
          <Card title="How it works">
            <ol className="list-decimal space-y-1.5 pl-4 text-xs leading-relaxed text-graphite-600 dark:text-graphite-400">
              <li>Your intent becomes a structured, editable specification.</li>
              <li>A dependency graph of tasks is planned and assigned to specialist agents.</li>
              <li>Agents work in isolated git worktrees under backend-enforced permissions.</li>
              <li>Risky actions pause for your approval in Security.</li>
              <li>Unit and browser tests produce the evidence used for final verification.</li>
            </ol>
          </Card>
        </div>
      </div>
    </div>
  );
}
