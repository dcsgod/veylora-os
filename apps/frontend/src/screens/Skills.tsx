import type { Skill, Trust } from "@veylora/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FolderOpen, Search, Sparkles } from "lucide-react";
import { useState } from "react";
import { Badge, Button, Card, Drawer, Empty, ErrorBox, Input, KV, Notice, PageHeader, Pre, Select, Spinner, StatusBadge, Toggle,
         cx } from "../components/ui";
import { api } from "../lib/api";
import { bridge } from "../lib/bridge";
import { timeAgo } from "../lib/format";

interface ImportResult { imported: string[]; updated: string[]; invalid: { path?: string; errors?: string[] }[] | string[] }

function useSkillMutations() {
  const client = useQueryClient();
  const done = () => {
    void client.invalidateQueries({ queryKey: ["skills"] });
    void client.invalidateQueries({ queryKey: ["skill"] });
  };
  return {
    enable: useMutation({ mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.post<Skill>(`/skills/${id}/enable`, { enabled }), onSettled: done }),
    trust: useMutation({ mutationFn: ({ id, trust }: { id: string; trust: Trust }) => api.post<Skill>(`/skills/${id}/trust`, { trust }), onSettled: done }),
  };
}

function SkillDetail({ id, onClose }: { id?: string; onClose(): void }) {
  const skill = useQuery({ queryKey: ["skill", id], queryFn: () => api.get<Skill>(`/skills/${id}`), enabled: Boolean(id) });
  const { enable, trust } = useSkillMutations();
  const s = skill.data;
  return (
    <Drawer open={Boolean(id)} onClose={onClose} title={s?.name ?? "Skill"} width="w-[680px]">
      {skill.isLoading && <Spinner />}
      <ErrorBox error={skill.error} />
      {s && (
        <div className="space-y-5">
          <p className="leading-relaxed">{s.description}</p>
          <div className="flex flex-wrap items-center gap-3">
            <Toggle checked={Boolean(s.enabled)} disabled={!s.validation.valid} onChange={(v) => enable.mutate({ id: s.id, enabled: v })}
              label={s.enabled ? "Enabled for agents" : "Disabled"} />
            <Select value={s.trust} onChange={(e) => trust.mutate({ id: s.id, trust: e.target.value as Trust })} className="w-40" aria-label="Trust">
              <option value="untrusted">untrusted</option>
              <option value="reviewed">reviewed</option>
              <option value="trusted">trusted</option>
            </Select>
          </div>
          <ErrorBox error={enable.error ?? trust.error} />
          <KV items={[
            ["Slug", <span className="mono">{s.slug}</span>],
            ["Category", s.category],
            ["Source", s.source_repo ? <span className="mono">{s.source_repo}/{s.source_path}</span> : s.origin],
            ["Commit", s.source_commit ? <span className="mono">{s.source_commit.slice(0, 12)}</span> : "-"],
            ["License", s.license ?? <span className="text-amber-700 dark:text-amber-300">not declared</span>],
            ["Version", s.version],
            ["Suggested roles", s.roles.join(", ") || "-"],
            ["Prerequisites", s.prerequisites.join(", ") || "-"],
            ["Imported", timeAgo(s.imported_at)],
            ["Usage", Object.entries(s.usage ?? {}).map(([k, v]) => `${k}: ${v}`).join(", ") || "not used yet"],
          ]} />
          {(s.validation.errors.length > 0 || s.validation.warnings.length > 0) && (
            <div className="space-y-1">
              {s.validation.errors.map((e) => <div key={e} className="text-xs text-red-600">error: {e}</div>)}
              {s.validation.warnings.map((w) => <div key={w} className="text-xs text-amber-700 dark:text-amber-300">warning: {w}</div>)}
            </div>
          )}
          {s.scripts.length > 0 && (
            <Notice tone="amber">This skill bundles {s.scripts.length} script(s). Veylora never runs skill scripts during discovery; any execution goes through the
              sandboxed runner and the permission policy.<div className="mono mt-1">{s.scripts.join(", ")}</div></Notice>
          )}
          {s.external_urls.length > 0 && (
            <div>
              <div className="mb-1 text-xs font-medium">Referenced URLs (not fetched)</div>
              <ul className="mono space-y-0.5 text-[11px] text-graphite-600 dark:text-graphite-400">{s.external_urls.map((u) => <li key={u} className="break-all">{u}</li>)}</ul>
            </div>
          )}
          <div>
            <div className="mb-1 text-xs font-medium">Instructions (shown as plain text)</div>
            <Pre className="max-h-[480px]">{s.instructions ?? ""}</Pre>
          </div>
        </div>
      )}
    </Drawer>
  );
}

export default function Skills() {
  const client = useQueryClient();
  const [q, setQ] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [enabledOnly, setEnabledOnly] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [folder, setFolder] = useState("");
  const skills = useQuery({
    queryKey: ["skills", q, category, enabledOnly],
    queryFn: () => api.get<Skill[]>("/skills", { q, category, enabled_only: enabledOnly || undefined, limit: 300 }),
  });
  const categories = useQuery({ queryKey: ["skill-categories"], queryFn: () => api.get<{ category: string; count: number }[]>("/skills/categories") });
  const { enable } = useSkillMutations();
  const imported = () => {
    void client.invalidateQueries({ queryKey: ["skills"] });
    void client.invalidateQueries({ queryKey: ["skill-categories"] });
  };
  const importCatalogue = useMutation({ mutationFn: () => api.post<ImportResult>("/skills/import", { source: "catalogue" }), onSuccess: imported });
  const importFolder = useMutation({
    mutationFn: (path: string) => api.post<ImportResult>("/skills/import", { source: "directory", path }), onSuccess: imported,
  });
  const result = importCatalogue.data ?? importFolder.data;

  const pickFolder = async () => {
    const path = bridge ? await bridge.selectDirectory() : folder.trim();
    if (path) importFolder.mutate(path);
  };

  return (
    <div className="mx-auto max-w-[1500px]">
      <PageHeader title="Skill Marketplace" subtitle="Reusable instructions agents can draw on. Skills are guidance only: they never grant permissions or run code."
        actions={
          <>
            {!bridge && <Input placeholder="Local folder path" value={folder} onChange={(e) => setFolder(e.target.value)} className="w-64" />}
            <Button icon={<FolderOpen className="size-3.5" />} loading={importFolder.isPending} onClick={() => void pickFolder()}>Import folder</Button>
            <Button variant="primary" icon={<Download className="size-3.5" />} loading={importCatalogue.isPending} onClick={() => importCatalogue.mutate()}>
              Import awesome-llm-skills
            </Button>
          </>
        } />
      <div className="mb-4 space-y-2">
        <Notice>Imported skills start as <b>untrusted</b>. Their text is treated as data, shown as plain text, scanned for invalid structure, and only offered to
          agents when you enable them. The catalogue is downloaded once as a GitHub archive (no git clone, nothing executed).</Notice>
        <ErrorBox error={importCatalogue.error ?? importFolder.error} />
        {result && (
          <Notice>Import finished: {result.imported.length} new, {result.updated.length} updated, {result.invalid.length} invalid (kept disabled).</Notice>
        )}
      </div>
      <div className="grid gap-5 lg:grid-cols-[220px_1fr]">
        <aside className="space-y-3">
          <div className="relative">
            <Search className="absolute left-2.5 top-2 size-4 text-graphite-400" />
            <Input placeholder="Search skills" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" />
          </div>
          <Toggle checked={enabledOnly} onChange={setEnabledOnly} label="Enabled only" />
          <nav className="space-y-0.5">
            <button onClick={() => setCategory(null)} className={cx("flex w-full justify-between rounded px-2 py-1 text-left text-xs",
              category === null ? "bg-accent-50 text-accent-800 dark:bg-accent-500/15 dark:text-accent-200" : "hover:bg-graphite-100 dark:hover:bg-graphite-800")}>
              <span>All categories</span>
            </button>
            {(categories.data ?? []).map((c) => (
              <button key={c.category} onClick={() => setCategory(c.category)} className={cx("flex w-full justify-between rounded px-2 py-1 text-left text-xs",
                category === c.category ? "bg-accent-50 text-accent-800 dark:bg-accent-500/15 dark:text-accent-200" : "hover:bg-graphite-100 dark:hover:bg-graphite-800")}>
                <span className="truncate">{c.category}</span><span className="text-graphite-500">{c.count}</span>
              </button>
            ))}
          </nav>
        </aside>
        <div>
          {skills.isLoading ? <Spinner /> : skills.error ? <ErrorBox error={skills.error} /> : !skills.data?.length ? (
            <Empty icon={<Sparkles className="size-6" />} title={q || category ? "No skills match" : "No skills imported yet"}>
              Import the awesome-llm-skills catalogue or a local folder of SKILL.md files.
            </Empty>
          ) : (
            <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
              {skills.data.map((s) => (
                <Card key={s.id} className="cursor-pointer transition-colors hover:border-accent-300 dark:hover:border-accent-500/50">
                  <div onClick={() => setSelected(s.id)} className="space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate font-medium">{s.name}</div>
                        <div className="text-[11px] text-graphite-500">{s.category}{s.source_repo ? ` · ${s.source_repo}` : ` · ${s.origin}`}</div>
                      </div>
                      <StatusBadge status={s.trust} />
                    </div>
                    <p className="line-clamp-3 text-xs leading-relaxed text-graphite-600 dark:text-graphite-400">{s.description}</p>
                    <div className="flex flex-wrap gap-1">
                      {!s.validation.valid && <Badge tone="red">invalid</Badge>}
                      {s.scripts.length > 0 && <Badge tone="amber">{s.scripts.length} scripts</Badge>}
                      {!s.license && <Badge tone="amber">no license</Badge>}
                      {s.tags.slice(0, 3).map((t) => <Badge key={t}>{t}</Badge>)}
                    </div>
                  </div>
                  <div className="mt-3 border-t border-graphite-100 pt-2 dark:border-graphite-800" onClick={(e) => e.stopPropagation()}>
                    <Toggle checked={Boolean(s.enabled)} disabled={!s.validation.valid || enable.isPending}
                      onChange={(v) => enable.mutate({ id: s.id, enabled: v })} label={s.enabled ? "Enabled" : "Disabled"} />
                  </div>
                </Card>
              ))}
            </div>
          )}
          <ErrorBox error={enable.error} />
        </div>
      </div>
      <SkillDetail id={selected} onClose={() => setSelected(undefined)} />
    </div>
  );
}
