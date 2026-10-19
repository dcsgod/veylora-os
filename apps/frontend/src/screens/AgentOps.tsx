import type { AgentExecution, Resources, Role } from "@veylora/contracts";
import { useQuery } from "@tanstack/react-query";
import { Activity, Cpu, MemoryStick, Server } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { EventFeed } from "../components/EventFeed";
import { ProjectPicker, useCurrentProjectId } from "../components/Shell";
import { Badge, Card, Empty, ErrorBox, Input, PageHeader, Spinner, StatusBadge, Table, Tabs } from "../components/ui";
import { api } from "../lib/api";
import { between, clock, duration } from "../lib/format";
import { useApp } from "../store";

function Stat({ icon, label, value, sub }: { icon: ReactNode; label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <Card>
      <div className="flex items-center gap-3">
        <div className="rounded-md bg-accent-50 p-2 text-accent-700 dark:bg-accent-500/15 dark:text-accent-300">{icon}</div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-graphite-500">{label}</div>
          <div className="text-lg font-semibold">{value}</div>
          {sub && <div className="text-[11px] text-graphite-500">{sub}</div>}
        </div>
      </div>
    </Card>
  );
}

function ResourcesRow() {
  const res = useQuery({ queryKey: ["resources"], queryFn: () => api.get<Resources>("/resources"), refetchInterval: 3000 });
  const r = res.data;
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <Stat icon={<Activity className="size-4" />} label="Running tasks" value={r ? `${r.scheduler.running_tasks}` : "-"} sub={r && `max ${r.scheduler.max_parallel} in parallel`} />
      <Stat icon={<Cpu className="size-4" />} label="CPU" value={r ? `${r.system.cpu_percent.toFixed(0)}%` : "-"} sub={r && `${r.system.cpu_count} logical cores`} />
      <Stat icon={<MemoryStick className="size-4" />} label="Memory" value={r ? `${r.system.memory_used_percent.toFixed(0)}%` : "-"} sub={r && `${(r.system.memory_total_mb / 1024).toFixed(1)} GB total`} />
      <Stat icon={<Server className="size-4" />} label="Backend" value={r ? `${r.backend.rss_mb} MB` : "-"}
        sub={r && `${r.backend.child_processes} child processes · ${r.models.map((m) => `${m.provider}: ${m.active} active / ${m.queued} queued`).join(", ") || "no providers"}`} />
    </div>
  );
}

function Executions({ projectId }: { projectId: string }) {
  const ex = useQuery({ queryKey: ["executions", projectId], queryFn: () => api.get<AgentExecution[]>(`/projects/${projectId}/executions`) });
  const navigate = useApp((s) => s.navigate);
  if (ex.isLoading) return <Spinner />;
  return (
    <>
      <ErrorBox error={ex.error} />
      <Table head={["Task", "Agent", "Model", "Status", "Attempt", "Tokens in/out", "Model latency", "Duration", "Started"]}
        empty={<Empty title="No agent executions yet">Executions appear when the plan runs.</Empty>}>
        {(ex.data ?? []).map((e) => (
          <tr key={e.id} className="cursor-pointer hover:bg-graphite-50 dark:hover:bg-graphite-850"
            onClick={() => navigate({ screen: "studio", projectId, taskId: e.task_id })}>
            <td><div className="font-medium">{e.task_title}</div><div className="mono text-[11px] text-graphite-500">{e.task_key}</div></td>
            <td>{e.role.replaceAll("_", " ")}</td>
            <td title={e.route_reason ?? undefined}>{e.model ?? <span className="text-graphite-500">deterministic</span>}</td>
            <td><StatusBadge status={e.status} />{e.last_event && <div className="mt-0.5 text-[11px] text-graphite-500">{e.last_event}</div>}</td>
            <td>{e.attempt}</td>
            <td>{e.input_tokens ?? "-"} / {e.output_tokens ?? "-"}</td>
            <td>{duration(e.model_latency_ms)}</td>
            <td>{between(e.started_at, e.finished_at)}</td>
            <td className="text-graphite-500">{clock(e.started_at)}</td>
          </tr>
        ))}
      </Table>
    </>
  );
}

function Roles() {
  const roles = useQuery({ queryKey: ["roles"], queryFn: () => api.get<Role[]>("/roles") });
  if (roles.isLoading) return <Spinner />;
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {(roles.data ?? []).map((r) => (
        <Card key={r.id} title={r.title} actions={<Badge tone="blue">{r.model_class}</Badge>}>
          <p className="mb-2 text-xs text-graphite-600 dark:text-graphite-400">{r.description}</p>
          <div className="mb-2 flex flex-wrap gap-1">{r.tools.map((t) => <Badge key={t} className="mono">{t}</Badge>)}</div>
          <div className="space-y-0.5">
            {Object.entries(r.grants).map(([perm, grant]) => (
              <div key={perm} className="flex justify-between text-[11px]">
                <span className="mono text-graphite-600 dark:text-graphite-400">{perm}</span>
                <Badge tone={grant === "allow" ? "green" : grant === "approve" ? "amber" : "blue"}>{grant}</Badge>
              </div>
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}

export default function AgentOps() {
  const projectId = useCurrentProjectId();
  const events = useApp((s) => s.events);
  const [tab, setTab] = useState<"executions" | "live" | "roles">("executions");
  const [filter, setFilter] = useState("");
  const feed = useMemo(() => [...events].reverse().filter((e) => !filter || e.type.includes(filter) || JSON.stringify(e.payload).includes(filter)),
    [events, filter]);

  return (
    <div className="mx-auto max-w-[1500px] space-y-5">
      <PageHeader title="Agent Ops" subtitle="What every agent is doing, with which model, and what it cost in time. Nothing here is simulated."
        actions={<ProjectPicker screen="agents" />} />
      <ResourcesRow />
      <Tabs value={tab} onChange={setTab} tabs={[
        { id: "executions", label: "Executions" }, { id: "live", label: `Live events (${events.length})` }, { id: "roles", label: "Agent roles" },
      ]} />
      {tab === "executions" && (projectId ? <Card bodyClassName="p-0"><Executions projectId={projectId} /></Card> : <Empty title="No projects yet" />)}
      {tab === "live" && (
        <Card title="Live event stream" actions={<Input placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} className="w-56" />}
          bodyClassName="p-0 max-h-[640px] overflow-auto">
          <EventFeed events={feed} empty="Waiting for events. Run a project to see agents work." />
        </Card>
      )}
      {tab === "roles" && <Roles />}
    </div>
  );
}
