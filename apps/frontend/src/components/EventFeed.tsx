import type { VeyloraEvent } from "@veylora/contracts";
import { clock } from "../lib/format";
import { Badge, type Tone } from "./ui";

const TONE: Record<string, Tone> = {
  agent: "blue", task: "neutral", approval: "amber", artifact: "violet", plan: "blue", spec: "blue",
  project: "green", preview: "violet", scheduler: "red", models: "neutral", skills: "neutral",
};

function summary(e: VeyloraEvent): string {
  const p = e.payload ?? {};
  const parts: string[] = [];
  for (const k of ["key", "title", "status", "from", "to", "role", "model", "name", "action", "reason", "error", "url", "revision"]) {
    const v = p[k];
    if (v !== undefined && v !== null && v !== "") parts.push(k === "from" ? `${v} →` : String(v));
  }
  return parts.join(" · ").slice(0, 220);
}

export function EventFeed({ events, empty = "No events yet." }: { events: VeyloraEvent[]; empty?: string }) {
  if (!events.length) return <div className="px-4 py-6 text-center text-graphite-500">{empty}</div>;
  return (
    <ul className="divide-y divide-graphite-100 text-xs dark:divide-graphite-800">
      {events.map((e) => {
        const isError = e.type.endsWith("failed") || e.type.endsWith("error");
        return (
          <li key={e.id} className="flex items-start gap-3 px-4 py-1.5">
            <span className="mono w-16 shrink-0 text-graphite-500">{clock(e.ts)}</span>
            <Badge tone={isError ? "red" : TONE[e.type.split(".")[0]] ?? "neutral"} className="mono shrink-0">{e.type}</Badge>
            <span className="min-w-0 flex-1 break-words text-graphite-700 dark:text-graphite-300">{summary(e)}</span>
          </li>
        );
      })}
    </ul>
  );
}
