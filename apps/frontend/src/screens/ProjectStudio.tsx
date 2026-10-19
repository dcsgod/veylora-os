import type { Approval, Plan, Preview, Project, TestResult, VeyloraEvent } from "@veylora/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, ExternalLink, Pause, Play, Square, SquareTerminal, Trash2, XCircle } from "lucide-react";
import { useMemo, useState } from "react";
import { ApprovalCard } from "../components/Approvals";
import { DagView } from "../components/DagView";
import { EventFeed } from "../components/EventFeed";
import { ProjectPicker, useCurrentProjectId } from "../components/Shell";
import { SpecEditor } from "../components/SpecEditor";
import { TaskDrawer } from "../components/TaskDrawer";
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, KV, PageHeader, Pre, Select, Spinner, StatusBadge, Table, Tabs,
         Toggle } from "../components/ui";
import { api } from "../lib/api";
import { bridge } from "../lib/bridge";
import { clock, duration, pretty, timeAgo } from "../lib/format";
import { useApp } from "../store";

type Tab = "plan" | "spec" | "tests" | "activity" | "settings";

export function openPreviewUrl(url: string) {
  if (bridge) void bridge.openPreview(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

function Controls({ project }: { project: Project }) {
  const client = useQueryClient();
  const act = useMutation({
    mutationFn: (action: "start" | "pause" | "resume" | "cancel") => api.post<Project>(`/projects/${project.id}/${action}`),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ["project", project.id] });
      void client.invalidateQueries({ queryKey: ["projects"] });
    },
  });
  const s = project.status;
  const pausing = s === "running" && !project.scheduler_active;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {(s === "draft" || s === "planned" || s === "failed") && (
        <Button variant="primary" icon={<Play className="size-3.5" />} loading={act.isPending && act.variables === "start"}
          onClick={() => act.mutate("start")}>{s === "failed" ? "Resume remaining work" : "Run plan"}</Button>
      )}
      {s === "running" && (
        <Button icon={<Pause className="size-3.5" />} loading={act.isPending && act.variables === "pause"} disabled={pausing}
          onClick={() => act.mutate("pause")}>Pause</Button>
      )}
      {s === "paused" && (
        <Button variant="primary" icon={<Play className="size-3.5" />} loading={act.isPending && act.variables === "resume"}
          onClick={() => act.mutate("resume")}>Resume</Button>
      )}
      {(s === "running" || s === "paused") && (
        <Button variant="danger" icon={<XCircle className="size-3.5" />} loading={act.isPending && act.variables === "cancel"}
          onClick={() => act.mutate("cancel")}>Cancel</Button>
      )}
      {act.error && <ErrorBox error={act.error} />}
    </div>
  );
}

function PreviewControls({ project }: { project: Project }) {
  const client = useQueryClient();
  const [showLog, setShowLog] = useState(false);
  const preview = project.preview;
  const refresh = () => void client.invalidateQueries({ queryKey: ["project", project.id] });
  const start = useMutation({ mutationFn: () => api.post<Preview>(`/projects/${project.id}/preview`), onSuccess: (p) => { refresh(); openPreviewUrl(p.url); } });
  const stop = useMutation({ mutationFn: () => api.post(`/previews/${preview!.id}/stop`), onSettled: refresh });
  const log = useQuery({
    queryKey: ["preview-log", preview?.id], queryFn: () => api.text(`/previews/${preview!.id}/log`),
    enabled: showLog && Boolean(preview), refetchInterval: showLog ? 3000 : false,
  });
  if (project.domain === "repo_analysis") return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {preview ? (
        <>
          <Button variant="primary" icon={<ExternalLink className="size-3.5" />} onClick={() => openPreviewUrl(preview.url)}>Open preview</Button>
          <Button icon={<SquareTerminal className="size-3.5" />} onClick={() => setShowLog(!showLog)}>Log</Button>
          <Button icon={<Square className="size-3.5" />} loading={stop.isPending} onClick={() => stop.mutate()}>Stop</Button>
          <span className="mono text-[11px] text-graphite-500">{preview.url}</span>
        </>
      ) : (
        <Button icon={<Play className="size-3.5" />} loading={start.isPending} onClick={() => start.mutate()}>Start preview</Button>
      )}
      <ErrorBox error={start.error ?? stop.error} />
      {showLog && preview && <Pre className="mt-2 max-h-56 w-full">{log.data || "(no output yet)"}</Pre>}
    </div>
  );
}

function TestsTab({ projectId }: { projectId: string }) {
  const tests = useQuery({ queryKey: ["tests", projectId], queryFn: () => api.get<TestResult[]>(`/projects/${projectId}/tests`) });
  const [open, setOpen] = useState<string | null>(null);
  if (tests.isLoading) return <Spinner />;
  return (
    <Card bodyClassName="p-0">
      <ErrorBox error={tests.error} />
      <Table head={["", "Suite", "Kind", "Status", "Passed", "Failed", "Skipped", "Duration", "When"]}
        empty={<Empty title="No test results yet">Results appear here when the test agents run. Every number shown comes from a real test run.</Empty>}>
        {(tests.data ?? []).flatMap((t) => [
          <tr key={t.id} className="cursor-pointer hover:bg-graphite-50 dark:hover:bg-graphite-850" onClick={() => setOpen(open === t.id ? null : t.id)}>
            <td>{open === t.id ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}</td>
            <td className="font-medium">{t.suite}</td>
            <td>{t.kind}</td>
            <td><StatusBadge status={t.status} /></td>
            <td className="text-emerald-700 dark:text-emerald-400">{t.passed}</td>
            <td className={t.failed ? "text-red-600" : ""}>{t.failed}</td>
            <td>{t.skipped}</td>
            <td>{duration(t.duration_ms)}</td>
            <td className="text-graphite-500">{timeAgo(t.created_at)}</td>
          </tr>,
          open === t.id && (
            <tr key={`${t.id}-r`}><td colSpan={9}><Pre className="max-h-[420px]">{pretty(t.report)}</Pre></td></tr>
          ),
        ]).filter(Boolean)}
      </Table>
    </Card>
  );
}

function ActivityTab({ projectId }: { projectId: string }) {
  const history = useQuery({
    queryKey: ["history", projectId],
    queryFn: () => api.get<VeyloraEvent[]>("/events/history", { project_id: projectId, limit: 2000 }),
  });
  const live = useApp((s) => s.events);
  const events = useMemo(() => {
    const byId = new Map<number, VeyloraEvent>();
    for (const e of history.data ?? []) byId.set(e.id, e);
    for (const e of live) if (e.project_id === projectId) byId.set(e.id, e);
    return [...byId.values()].sort((a, b) => b.id - a.id);
  }, [history.data, live, projectId]);
  return (
    <Card title="Activity" actions={<span className="text-[11px] text-graphite-500">{events.length} events · newest first</span>} bodyClassName="p-0 max-h-[640px] overflow-auto">
      {history.isLoading ? <Spinner /> : <EventFeed events={events} />}
    </Card>
  );
}

function SettingsTab({ project }: { project: Project }) {
  const client = useQueryClient();
  const navigate = useApp((s) => s.navigate);
  const [name, setName] = useState(project.name);
  const [confirm, setConfirm] = useState(false);
  const update = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch<Project>(`/projects/${project.id}`, body),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ["project", project.id] });
      void client.invalidateQueries({ queryKey: ["projects"] });
    },
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/projects/${project.id}`),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["projects"] });
      navigate({ screen: "home" });
    },
  });
  return (
    <div className="grid max-w-3xl gap-5">
      <Card title="Project settings">
        <div className="space-y-4">
          <Field label="Name">
            <div className="flex gap-2">
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
              <Button disabled={name === project.name || !name.trim()} onClick={() => update.mutate({ name })}>Rename</Button>
            </div>
          </Field>
          <Field label="Autonomy" hint="Review mode waits for you to run the plan. Risky actions always need approval in either mode.">
            <Select value={project.autonomy} onChange={(e) => update.mutate({ autonomy: e.target.value })}>
              <option value="review">Review plan before running</option>
              <option value="auto">Run automatically</option>
            </Select>
          </Field>
          <Toggle checked={Boolean(project.allow_hosted_inference)} onChange={(v) => update.mutate({ allow_hosted: v })}
            label="Allow hosted inference for this project (requires global authorisation in Settings)" />
          <ErrorBox error={update.error} />
        </div>
      </Card>
      <Card title="Danger zone">
        <p className="mb-3 text-xs text-graphite-500">Deleting removes the project's records from the database. Workspace files stay on disk.</p>
        {confirm ? (
          <div className="flex gap-2">
            <Button variant="danger" icon={<Trash2 className="size-3.5" />} loading={remove.isPending} onClick={() => remove.mutate()}>Confirm delete</Button>
            <Button onClick={() => setConfirm(false)}>Keep project</Button>
          </div>
        ) : (
          <Button variant="danger" icon={<Trash2 className="size-3.5" />} onClick={() => setConfirm(true)}>Delete project</Button>
        )}
        <div className="mt-2"><ErrorBox error={remove.error} /></div>
      </Card>
    </div>
  );
}

function PlanTab({ project, plan }: { project: Project; plan: Plan }) {
  const route = useApp((s) => s.route);
  const navigate = useApp((s) => s.navigate);
  const [showSuperseded, setShowSuperseded] = useState(false);
  const approvals = useQuery({
    queryKey: ["approvals", "pending", project.id],
    queryFn: () => api.get<Approval[]>("/approvals", { status: "pending", project_id: project.id }),
  });
  const active = plan.tasks.filter((t) => !t.superseded_by);
  const latest = plan.revisions[plan.revisions.length - 1];
  const select = (taskId?: string) => navigate({ screen: "studio", projectId: project.id, taskId });

  return (
    <div className="space-y-4">
      {(approvals.data?.length ?? 0) > 0 && (
        <div className="space-y-2">{approvals.data!.map((a) => <ApprovalCard key={a.id} approval={a} compact />)}</div>
      )}
      <div className="grid gap-4 xl:grid-cols-[1fr_280px]">
        <Card bodyClassName="p-0 h-[560px]" title={`Plan revision ${latest?.revision ?? 1}`} actions={
          <Toggle checked={showSuperseded} onChange={setShowSuperseded} label="Show superseded" />
        }>
          {plan.tasks.length ? (
            <DagView tasks={plan.tasks} edges={plan.edges} selectedId={route.taskId} onSelect={select} showSuperseded={showSuperseded} />
          ) : <Empty title="No tasks in this plan" />}
        </Card>
        <div className="space-y-4">
          <Card title="Progress">
            <KV items={[
              ["Tasks", active.length],
              ...(["completed", "running", "verifying", "ready", "pending", "waiting_for_approval", "blocked", "failed", "cancelled"] as const)
                .filter((s) => active.some((t) => t.status === s))
                .map((s) => [<StatusBadge status={s} />, active.filter((t) => t.status === s).length] as [React.ReactNode, React.ReactNode]),
            ]} />
          </Card>
          <Card title="Tasks" bodyClassName="p-0 max-h-[360px] overflow-auto">
            <ul className="divide-y divide-graphite-100 dark:divide-graphite-800">
              {active.map((t) => (
                <li key={t.id}>
                  <button onClick={() => select(t.id)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-graphite-50 dark:hover:bg-graphite-850">
                    <span className="min-w-0 flex-1 truncate">{t.title}</span>
                    <StatusBadge status={t.status} />
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
      <TaskDrawer projectId={project.id} taskId={route.taskId} onClose={() => select(undefined)} />
    </div>
  );
}

export default function ProjectStudio() {
  const projectId = useCurrentProjectId();
  const navigate = useApp((s) => s.navigate);
  const [tab, setTab] = useState<Tab>("plan");
  const project = useQuery({
    queryKey: ["project", projectId], queryFn: () => api.get<Project>(`/projects/${projectId}`), enabled: Boolean(projectId),
  });
  const plan = useQuery({ queryKey: ["plan", projectId], queryFn: () => api.get<Plan>(`/projects/${projectId}/plan`), enabled: Boolean(projectId) });

  if (!projectId) {
    return (
      <Empty title="No project selected">
        <Button variant="primary" onClick={() => navigate({ screen: "home" })}>Describe a project</Button>
      </Empty>
    );
  }
  if (project.isLoading || plan.isLoading) return <Spinner />;
  if (project.error) return <ErrorBox error={project.error} />;
  const p = project.data!;
  const locked = !(["draft", "planned"].includes(p.status) && (plan.data?.tasks ?? []).every((t) => t.status === "pending"));

  return (
    <div className="mx-auto max-w-[1500px]">
      <PageHeader
        title={<span className="flex items-center gap-3">{p.name}<StatusBadge status={p.status} /></span>}
        subtitle={<span className="flex flex-wrap items-center gap-2">
          <Badge tone="blue">{p.domain.replaceAll("_", " ")}</Badge>
          <Badge>{p.autonomy === "auto" ? "automatic" : "review mode"}</Badge>
          {p.allow_hosted_inference ? <Badge tone="amber">hosted inference allowed</Badge> : <Badge tone="green">local inference only</Badge>}
          <span className="text-xs">created {timeAgo(p.created_at)} · updated {clock(p.updated_at)}</span>
        </span>}
        actions={<ProjectPicker screen="studio" />}
      />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Controls project={p} />
        <PreviewControls project={p} />
      </div>
      <p className="mb-4 line-clamp-2 text-xs text-graphite-500" title={p.request}>Request: {p.request}</p>
      <Tabs value={tab} onChange={setTab} tabs={[
        { id: "plan", label: "Plan" }, { id: "spec", label: "Specification" }, { id: "tests", label: "Tests" },
        { id: "activity", label: "Activity" }, { id: "settings", label: "Settings" },
      ]} />
      <div className="mt-4">
        <ErrorBox error={plan.error} />
        {tab === "plan" && plan.data && <PlanTab project={p} plan={plan.data} />}
        {tab === "spec" && <SpecEditor projectId={p.id} locked={locked} />}
        {tab === "tests" && <TestsTab projectId={p.id} />}
        {tab === "activity" && <ActivityTab projectId={p.id} />}
        {tab === "settings" && <SettingsTab project={p} />}
      </div>
    </div>
  );
}
