import type { Approval, AuditEvent } from "@veylora/contracts";
import { useQuery } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import { ApprovalCard } from "../components/Approvals";
import { usePendingApprovals, useProjects } from "../components/Shell";
import { Badge, Card, Empty, ErrorBox, Input, Notice, PageHeader, Pre, Select, Spinner, STATUS_TONE, Table, Tabs } from "../components/ui";
import { clock, pretty, timeAgo } from "../lib/format";
import { api } from "../lib/api";

type View = "pending" | "decided" | "audit";

function Decided() {
  const decided = useQuery({ queryKey: ["approvals", "decided"], queryFn: () => api.get<Approval[]>("/approvals") });
  const rows = (decided.data ?? []).filter((a) => a.status !== "pending");
  if (decided.isLoading) return <Spinner />;
  return (
    <Card bodyClassName="p-0">
      <ErrorBox error={decided.error} />
      <Table head={["Requested", "Action", "Permission", "Risk", "Project / task", "Decision", "Used"]}
        empty={<Empty title="No decisions yet" />}>
        {rows.map((a) => (
          <tr key={a.id}>
            <td className="whitespace-nowrap text-xs">{timeAgo(a.created_at)}</td>
            <td><div className="font-medium">{a.action}</div><div className="text-[11px] text-graphite-500">{a.reason}</div></td>
            <td className="mono text-xs">{a.permission}</td>
            <td><Badge tone={STATUS_TONE[a.risk]}>{a.risk}</Badge></td>
            <td className="text-xs">{a.project_name ?? "-"}{a.task_key && <span className="text-graphite-500"> · {a.task_key}</span>}</td>
            <td><Badge tone={STATUS_TONE[a.status]}>{a.status}</Badge> <span className="text-[11px] text-graphite-500">{a.decided_by} {timeAgo(a.decided_at)}</span></td>
            <td className="text-xs">{a.consumed ? "yes" : "no"}</td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}

function Audit() {
  const projects = useProjects();
  const [projectId, setProjectId] = useState("");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<number>();
  const audit = useQuery({
    queryKey: ["audit", projectId],
    queryFn: () => api.get<AuditEvent[]>("/audit", { project_id: projectId || undefined, limit: 1000 }),
    refetchInterval: 10000,
  });
  const names = useMemo(() => new Map((projects.data ?? []).map((p) => [p.id, p.name])), [projects.data]);
  const needle = q.trim().toLowerCase();
  const rows = (audit.data ?? []).filter((e) => !needle || `${e.actor} ${e.action} ${e.target} ${e.decision}`.toLowerCase().includes(needle));
  return (
    <Card bodyClassName="p-0" title="Audit log" actions={
      <>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter" className="w-48" />
        <Select value={projectId} onChange={(e) => setProjectId(e.target.value)} className="w-52" aria-label="Project">
          <option value="">All projects and system</option>
          {(projects.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
      </>
    }>
      {audit.isLoading && <Spinner />}
      <ErrorBox error={audit.error} />
      <Table head={["Time", "Actor", "Action", "Target", "Decision", "Project"]} empty={!audit.isLoading && <Empty title="No audit events" />}>
        {rows.map((e) => (
          <Fragment key={e.id}>
            <tr onClick={() => setOpen(open === e.id ? undefined : e.id)} className="cursor-pointer hover:bg-graphite-50 dark:hover:bg-graphite-850">
              <td className="whitespace-nowrap text-xs" title={e.ts}>{clock(e.ts)}</td>
              <td className="text-xs">{e.actor}</td>
              <td className="mono text-xs">{e.action}</td>
              <td className="max-w-[320px] truncate text-xs" title={e.target}>{e.target}</td>
              <td><Badge tone={STATUS_TONE[e.decision] ?? "neutral"}>{e.decision}</Badge></td>
              <td className="text-xs">{e.project_id ? names.get(e.project_id) ?? e.project_id : "-"}</td>
            </tr>
            {open === e.id && (
              <tr><td colSpan={6}><Pre>{pretty(e.details)}</Pre></td></tr>
            )}
          </Fragment>
        ))}
      </Table>
    </Card>
  );
}

export default function Security() {
  const pending = usePendingApprovals();
  const [view, setView] = useState<View>("pending");
  const count = pending.data?.length ?? 0;
  return (
    <div className="space-y-4">
      <PageHeader title="Security and approvals"
        subtitle="Agents request permissions; the backend enforces every decision and records it in the audit log." />
      <Tabs value={view} onChange={setView} tabs={[
        { id: "pending", label: <span>Pending {count > 0 && <Badge tone="amber" className="ml-1">{count}</Badge>}</span> },
        { id: "decided", label: "Decisions" },
        { id: "audit", label: "Audit log" },
      ]} />
      {view === "pending" && (
        <div className="space-y-3">
          <Notice>
            Approving grants a single use of the requested permission for that task. Denying fails the task; retrying it later raises
            a new request.
          </Notice>
          {pending.isLoading && <Spinner />}
          <ErrorBox error={pending.error} />
          {!pending.isLoading && count === 0 && <Empty icon={<ShieldCheck className="size-6" />} title="Nothing waiting for you">
            Destructive actions, network access outside the allowlist, publishing and other sensitive operations appear here.
          </Empty>}
          {(pending.data ?? []).map((a) => <ApprovalCard key={a.id} approval={a} />)}
        </div>
      )}
      {view === "decided" && <Decided />}
      {view === "audit" && <Audit />}
    </div>
  );
}
