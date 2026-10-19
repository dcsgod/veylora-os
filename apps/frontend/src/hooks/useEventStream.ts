import type { VeyloraEvent } from "@veylora/contracts";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { openEventStream } from "../lib/events";
import { useApp } from "../store";

function keysFor(e: VeyloraEvent): unknown[][] {
  const pid = e.project_id ?? undefined;
  const project = pid ? [["project", pid], ["plan", pid], ["projects"]] : [["projects"]];
  const [domain] = e.type.split(".");
  switch (domain) {
    case "task":
    case "agent":
      return [...project, ["task", pid], ["executions", pid], ["tests", pid], ["artifacts", pid], ["files", pid], ["git", pid], ["resources"]];
    case "plan":
    case "spec":
      return [...project, ["spec", pid]];
    case "project":
      return [...project, ["executions", pid], ["previews", pid]];
    case "approval":
      return [...project, ["approvals"], ["task", pid], ["audit"]];
    case "artifact":
      return [["artifacts", pid], ["files", pid], ["git", pid], ["task", pid]];
    case "preview":
      return [["project", pid], ["previews", pid]];
    case "models":
      return [["models"], ["providers"]];
    case "skills":
      return [["skills"], ["skill-categories"]];
    case "scheduler":
      return project;
    default:
      return [];
  }
}

function invalidator(client: QueryClient) {
  const pending = new Map<string, unknown[]>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (e: VeyloraEvent) => {
    for (const key of keysFor(e)) pending.set(JSON.stringify(key), key);
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      const keys = [...pending.values()];
      pending.clear();
      for (const queryKey of keys) void client.invalidateQueries({ queryKey: queryKey.filter((k) => k !== undefined) });
    }, 250);
  };
}

/** One application-wide stream; screens read live events from the store and refetch through query invalidation. */
export function useEventStream() {
  const client = useQueryClient();
  const connected = useApp((s) => s.connected);
  const pushEvent = useApp((s) => s.pushEvent);
  const setStreamConnected = useApp((s) => s.setStreamConnected);

  useEffect(() => {
    if (!connected) return;
    const invalidate = invalidator(client);
    let first = true;
    const handle = openEventStream(
      (e) => {
        pushEvent(e);
        invalidate(e);
      },
      (ok) => {
        setStreamConnected(ok);
        if (ok && !first) void client.invalidateQueries();
        first = false;
      },
    );
    return () => handle.close();
  }, [connected, client, pushEvent, setStreamConnected]);
}
