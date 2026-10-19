import type { Approval } from "@veylora/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, ShieldAlert, X } from "lucide-react";
import { api } from "../lib/api";
import { timeAgo } from "../lib/format";
import { Badge, Button, ErrorBox, StatusBadge, cx } from "./ui";

export function useDecide() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, approve }: { id: string; approve: boolean }) => api.post<Approval>(`/approvals/${id}/decide`, { approve }),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ["approvals"] });
      void client.invalidateQueries({ queryKey: ["project"] });
      void client.invalidateQueries({ queryKey: ["task"] });
    },
  });
}

export function ApprovalCard({ approval, compact }: { approval: Approval; compact?: boolean }) {
  const decide = useDecide();
  const pending = approval.status === "pending";
  return (
    <div className={cx("rounded-lg border p-3", pending ? "border-amber-300 bg-amber-50/60 dark:border-amber-500/40 dark:bg-amber-500/5"
                                                       : "border-graphite-200 dark:border-graphite-800")}>
      <div className="flex items-start gap-3">
        <ShieldAlert className={cx("mt-0.5 size-4 shrink-0", pending ? "text-amber-600" : "text-graphite-400")} />
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium">{approval.action}</span>
            <Badge tone="neutral" className="mono">{approval.permission}</Badge>
            <StatusBadge status={approval.risk} />
            {!pending && <StatusBadge status={approval.status} />}
          </div>
          <div className="text-xs text-graphite-600 dark:text-graphite-400">
            Requested by <b>{approval.agent_role.replaceAll("_", " ")}</b>
            {approval.task_key && <> for task <span className="mono">{approval.task_key}</span></>}
            {!compact && approval.project_name && <> in {approval.project_name}</>} · {timeAgo(approval.created_at)}
          </div>
          {approval.targets.length > 0 && (
            <ul className="mono space-y-0.5 text-[11px] text-graphite-700 dark:text-graphite-300">
              {approval.targets.map((t) => <li key={t} className="break-all">{t}</li>)}
            </ul>
          )}
          {approval.reason && <div className="text-xs">{approval.reason}</div>}
          {!pending && approval.decided_at && (
            <div className="text-[11px] text-graphite-500">
              {approval.status} by {approval.decided_by ?? "user"} {timeAgo(approval.decided_at)}{approval.consumed ? " · used" : ""}
            </div>
          )}
          <ErrorBox error={decide.error} />
        </div>
        {pending && (
          <div className="flex shrink-0 gap-1.5">
            <Button size="sm" variant="danger" icon={<X className="size-3.5" />} loading={decide.isPending && decide.variables?.approve === false}
              disabled={decide.isPending} onClick={() => decide.mutate({ id: approval.id, approve: false })}>Deny</Button>
            <Button size="sm" variant="primary" icon={<Check className="size-3.5" />} loading={decide.isPending && decide.variables?.approve === true}
              disabled={decide.isPending} onClick={() => decide.mutate({ id: approval.id, approve: true })}>Approve once</Button>
          </div>
        )}
      </div>
    </div>
  );
}
