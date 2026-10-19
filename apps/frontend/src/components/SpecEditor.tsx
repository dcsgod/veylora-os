import type { AcceptanceCriterion, Specification } from "@veylora/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, Plus, Save, Trash2, Undo2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { timeAgo } from "../lib/format";
import { Badge, Button, Card, ErrorBox, Field, Input, Notice, Pre, Select, Spinner, TextArea } from "./ui";

interface SpecResponse {
  revision: number;
  content: Specification;
  markdown: string;
  source: string;
  author: string;
  created_at: string;
  revisions: { revision: number; source: string; author: string; created_at: string }[];
}

const LISTS: [keyof Specification, string][] = [
  ["features", "Features"],
  ["entities", "Entities"],
  ["constraints", "Constraints"],
  ["assumptions", "Assumptions"],
  ["open_questions", "Open questions"],
  ["out_of_scope", "Out of scope"],
  ["targets", "Targets (repositories or paths you own or may analyse)"],
];

const EVIDENCE = ["unit_test", "browser", "review", "artifact"];

const lines = (v: string) => v.split("\n").map((l) => l.trim()).filter(Boolean);

export function SpecEditor({ projectId, locked }: { projectId: string; locked: boolean }) {
  const client = useQueryClient();
  const spec = useQuery({ queryKey: ["spec", projectId], queryFn: () => api.get<SpecResponse>(`/projects/${projectId}/spec`) });
  const [draft, setDraft] = useState<Specification | null>(null);
  const [text, setText] = useState<Record<string, string>>({});
  const [showMarkdown, setShowMarkdown] = useState(false);

  const reset = () => {
    if (!spec.data) return;
    setDraft(structuredClone(spec.data.content));
    setText(Object.fromEntries(LISTS.map(([k]) => [k, (spec.data!.content[k] as string[]).join("\n")])));
  };
  useEffect(reset, [spec.data]);

  const save = useMutation({
    mutationFn: (s: Specification) => api.put(`/projects/${projectId}/spec`, { spec: s }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["spec", projectId] });
      void client.invalidateQueries({ queryKey: ["plan", projectId] });
      void client.invalidateQueries({ queryKey: ["project", projectId] });
    },
  });

  if (spec.isLoading || !draft) return <Spinner />;
  if (spec.error) return <ErrorBox error={spec.error} />;

  const merged = (): Specification => ({ ...draft, ...Object.fromEntries(LISTS.map(([k]) => [k, lines(text[k] ?? "")])) });
  const dirty = JSON.stringify(merged()) !== JSON.stringify(spec.data!.content);
  const setAc = (i: number, patch: Partial<AcceptanceCriterion>) =>
    setDraft({ ...draft, acceptance_criteria: draft.acceptance_criteria.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  const nextId = () => {
    const n = Math.max(0, ...draft.acceptance_criteria.map((c) => Number(c.id.replace(/\D/g, "")) || 0)) + 1;
    return `AC${n}`;
  };

  return (
    <div className="grid gap-5 xl:grid-cols-[1fr_300px]">
      <div className="space-y-5">
        {locked && <Notice tone="amber">Work on this plan has started, so the specification is read-only. Create a new project to change scope.</Notice>}
        <Card title={`Specification · revision ${spec.data!.revision}`} actions={
          <>
            <Button size="sm" variant="ghost" icon={<Eye className="size-3.5" />} onClick={() => setShowMarkdown(!showMarkdown)}>
              {showMarkdown ? "Edit" : "Document"}
            </Button>
            <Button size="sm" icon={<Undo2 className="size-3.5" />} disabled={!dirty} onClick={reset}>Discard</Button>
            <Button size="sm" variant="primary" icon={<Save className="size-3.5" />} disabled={!dirty || locked}
              loading={save.isPending} onClick={() => save.mutate(merged())}>Save and re-plan</Button>
          </>
        }>
          <ErrorBox error={save.error} />
          {showMarkdown ? <Pre className="max-h-[640px]">{spec.data!.markdown}</Pre> : (
            <fieldset disabled={locked} className="space-y-4">
              <div className="flex flex-wrap gap-1.5">
                <Badge tone="blue">domain: {draft.domain.replaceAll("_", " ")}</Badge>
                {draft.blueprint && <Badge tone="violet">blueprint: {draft.blueprint}</Badge>}
                <Badge>source: {draft.source}</Badge>
              </div>
              <Field label="Title"><Input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></Field>
              <Field label="Summary"><TextArea rows={3} value={draft.summary} onChange={(e) => setDraft({ ...draft, summary: e.target.value })} /></Field>
              <div className="grid gap-4 md:grid-cols-2">
                {LISTS.map(([k, label]) => (
                  <Field key={k} label={label} hint="One per line">
                    <TextArea rows={4} value={text[k] ?? ""} onChange={(e) => setText({ ...text, [k]: e.target.value })} />
                  </Field>
                ))}
              </div>
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-medium text-graphite-600 dark:text-graphite-400">Acceptance criteria</span>
                  <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />}
                    onClick={() => setDraft({ ...draft, acceptance_criteria: [...draft.acceptance_criteria, { id: nextId(), text: "", evidence: "review" }] })}>
                    Add criterion
                  </Button>
                </div>
                <div className="space-y-2">
                  {draft.acceptance_criteria.map((c, i) => (
                    <div key={c.id} className="flex items-center gap-2">
                      <span className="mono w-10 shrink-0 text-xs text-graphite-500">{c.id}</span>
                      <Input value={c.text} onChange={(e) => setAc(i, { text: e.target.value })} />
                      <Select value={c.evidence} onChange={(e) => setAc(i, { evidence: e.target.value })} className="w-32 shrink-0" aria-label="Evidence">
                        {EVIDENCE.map((ev) => <option key={ev} value={ev}>{ev.replace("_", " ")}</option>)}
                      </Select>
                      <Button size="sm" variant="ghost" aria-label="Remove" icon={<Trash2 className="size-3.5" />}
                        onClick={() => setDraft({ ...draft, acceptance_criteria: draft.acceptance_criteria.filter((_, j) => j !== i) })} />
                    </div>
                  ))}
                </div>
              </div>
            </fieldset>
          )}
        </Card>
      </div>
      <Card title="Revisions">
        <ul className="space-y-2 text-xs">
          {[...spec.data!.revisions].reverse().map((r) => (
            <li key={r.revision} className="flex items-center justify-between gap-2">
              <span>Revision {r.revision} <span className="text-graphite-500">· {r.author} ({r.source})</span></span>
              <span className="text-graphite-500">{timeAgo(r.created_at)}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-[11px] leading-relaxed text-graphite-500">
          Saving creates a new specification revision and replaces the plan. Edits are accepted only before any task has started;
          after that, create a new project for a changed scope.
        </p>
      </Card>
    </div>
  );
}
