import type { Artifact, TaskDetail, ToolExecution } from "@veylora/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, FileText, RotateCcw } from "lucide-react";
import { useState } from "react";
import { api } from "../lib/api";
import { between, bytes, clock, duration, pretty } from "../lib/format";
import { useApp } from "../store";
import { ApprovalCard } from "./Approvals";
import { Badge, Button, Drawer, ErrorBox, KV, Pre, Spinner, StatusBadge, Table } from "./ui";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h4 className="text-[11px] font-semibold uppercase tracking-wide text-graphite-500">{title}</h4>
      {children}
    </section>
  );
}

function Chips({ items }: { items: string[] }) {
  if (!items.length) return <span className="text-graphite-500">none</span>;
  return <div className="flex flex-wrap gap-1">{items.map((i) => <Badge key={i} className="mono">{i}</Badge>)}</div>;
}

function ToolRow({ tool }: { tool: ToolExecution }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr className="cursor-pointer hover:bg-graphite-50 dark:hover:bg-graphite-850" onClick={() => setOpen(!open)}>
        <td>{open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}</td>
        <td className="mono">{tool.tool}</td>
        <td><StatusBadge status={tool.status} /></td>
        <td>{tool.exit_code ?? "-"}</td>
        <td>{duration(tool.duration_ms)}</td>
        <td className="text-graphite-500">{clock(tool.created_at)}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={6}>
            <div className="space-y-2">
              <Pre className="max-h-40">{pretty(tool.args)}</Pre>
              {tool.output_excerpt && <Pre className="max-h-72">{tool.output_excerpt}</Pre>}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export function TaskDrawer({ projectId, taskId, onClose }: { projectId: string; taskId?: string; onClose(): void }) {
  const client = useQueryClient();
  const navigate = useApp((s) => s.navigate);
  const task = useQuery({
    queryKey: ["task", projectId, taskId],
    queryFn: () => api.get<TaskDetail>(`/projects/${projectId}/tasks/${taskId}`),
    enabled: Boolean(taskId),
  });
  const retry = useMutation({
    mutationFn: () => api.post(`/projects/${projectId}/tasks/${taskId}/retry`),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["plan", projectId] }),
  });
  const t = task.data;
  const openArtifact = (a: Artifact) => navigate({ screen: "explorer", projectId, artifactId: a.id });

  return (
    <Drawer open={Boolean(taskId)} onClose={onClose} width="w-[640px]"
      title={t ? <div className="flex items-center gap-2"><span className="truncate">{t.title}</span><StatusBadge status={t.status} /></div> : "Task"}>
      {task.isLoading && <Spinner />}
      <ErrorBox error={task.error} />
      {t && (
        <div className="space-y-6">
          {t.last_error && <ErrorBox error={t.last_error} />}
          {["failed", "cancelled", "blocked"].includes(t.status) && !t.superseded_by && (
            <div className="flex items-center gap-2">
              <Button variant="primary" size="sm" icon={<RotateCcw className="size-3.5" />} loading={retry.isPending} onClick={() => retry.mutate()}>
                Retry task and dependents
              </Button>
              <ErrorBox error={retry.error} />
            </div>
          )}
          <KV items={[
            ["Key", <span className="mono">{t.key}</span>],
            ["Agent role", t.role.replaceAll("_", " ")],
            ["Type / phase", `${t.task_type} · ${t.phase}`],
            ["Attempts", `${t.attempts} of ${t.max_retries + 1}`],
            ["Timeout", `${t.timeout_s}s`],
            ["Verification", <StatusBadge status={t.verification_status} />],
            ["Started", clock(t.started_at)],
            ["Duration", t.started_at ? between(t.started_at, t.finished_at) : "-"],
            ["Plan revision", t.plan_revision],
            ...(t.superseded_by ? [["Superseded by", <span className="mono">{t.superseded_by}</span>] as [string, React.ReactNode]] : []),
          ]} />
          {t.description && <Section title="Description"><p className="leading-relaxed">{t.description}</p></Section>}
          {t.acceptance.length > 0 && (
            <Section title="Acceptance"><ul className="list-disc space-y-1 pl-4">{t.acceptance.map((a) => <li key={a}>{a}</li>)}</ul></Section>
          )}
          {t.rationale.length > 0 && (
            <Section title="Why this task exists"><ul className="list-disc space-y-1 pl-4 text-graphite-600 dark:text-graphite-400">{t.rationale.map((a) => <li key={a}>{a}</li>)}</ul></Section>
          )}
          <Section title="Capabilities, skills and permissions">
            <KV items={[
              ["Capabilities", <Chips items={t.required_capabilities} />],
              ["Skills", <Chips items={t.skills} />],
              ["Permissions", <Chips items={t.permissions} />],
            ]} />
          </Section>
          {t.approvals.length > 0 && (
            <Section title="Approvals">{t.approvals.map((a) => <ApprovalCard key={a.id} approval={a} compact />)}</Section>
          )}
          <Section title="Agent executions">
            <Table head={["#", "Model", "Status", "Tokens in/out", "Latency", "Started"]}
              empty={<div className="px-3 py-3 text-graphite-500">Not executed yet.</div>}>
              {t.executions.map((e) => (
                <tr key={e.id}>
                  <td>{e.attempt}</td>
                  <td title={e.route_reason ?? undefined}>{e.model ?? <span className="text-graphite-500">deterministic</span>}</td>
                  <td><StatusBadge status={e.status} />{e.error && <div className="mt-1 text-[11px] text-red-600">{e.error}</div>}</td>
                  <td title="Reported by the model runtime; '-' means it did not report counts">
                    {e.input_tokens ?? "-"} / {e.output_tokens ?? "-"}
                  </td>
                  <td>{duration(e.model_latency_ms)}</td>
                  <td className="text-graphite-500">{clock(e.started_at)}</td>
                </tr>
              ))}
            </Table>
            {t.executions.some((e) => e.route_reason) && (
              <div className="text-[11px] text-graphite-500">Routing: {t.executions[t.executions.length - 1].route_reason}</div>
            )}
          </Section>
          <Section title="Tool executions">
            <Table head={["", "Tool", "Status", "Exit", "Duration", "Time"]} empty={<div className="px-3 py-3 text-graphite-500">No tools ran.</div>}>
              {t.tools.map((tool) => <ToolRow key={tool.id} tool={tool} />)}
            </Table>
          </Section>
          <Section title="Artifacts">
            {t.artifacts.length === 0 ? <div className="text-graphite-500">No artifacts.</div> : (
              <ul className="space-y-1">
                {t.artifacts.map((a) => (
                  <li key={a.id}>
                    <button onClick={() => openArtifact(a)} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-graphite-100 dark:hover:bg-graphite-800">
                      <FileText className="size-3.5 text-graphite-400" />
                      <span className="flex-1 truncate">{a.name}</span>
                      <Badge>{a.kind}</Badge>
                      <span className="text-[11px] text-graphite-500">{bytes(a.size)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Section>
          {Object.keys(t.result ?? {}).length > 0 && <Section title="Result"><Pre>{pretty(t.result)}</Pre></Section>}
        </div>
      )}
    </Drawer>
  );
}
