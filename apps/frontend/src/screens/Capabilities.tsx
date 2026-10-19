import type { Capability, CapabilityResolution, Repository, Trust } from "@veylora/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderOpen, GitBranch, Plus, RefreshCw, ScanSearch, Search } from "lucide-react";
import { useState } from "react";
import { Badge, Button, Card, Drawer, Empty, ErrorBox, Input, KV, Notice, PageHeader, Pre, Select, Spinner, StatusBadge, Table, Tabs,
         Toggle } from "../components/ui";
import { api } from "../lib/api";
import { bridge } from "../lib/bridge";
import { pretty, timeAgo } from "../lib/format";

function Resolution({ r }: { r: Partial<CapabilityResolution> }) {
  if (!r.status) return <span className="text-graphite-500">Not checked yet.</span>;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2"><StatusBadge status={r.status} /><span className="text-[11px] text-graphite-500">{r.method} · {timeAgo(r.checked_at)}</span></div>
      {(r.problems ?? []).map((p) => <div key={p} className="text-xs text-red-600">{p}</div>)}
      {(r.warnings ?? []).map((w) => <div key={w} className="text-xs text-amber-700 dark:text-amber-300">{w}</div>)}
      {(r.dependencies ?? []).length > 0 && (
        <Table head={["Dependency", "Kind", "Required", "Result"]}>
          {r.dependencies!.map((d) => (
            <tr key={`${d.kind}:${d.name}`}>
              <td className="mono">{d.name}{d.version ? ` ${d.version}` : ""}</td>
              <td>{d.kind}</td>
              <td>{d.optional ? "optional" : "required"}</td>
              <td><Badge tone={d.ok ? "green" : d.optional ? "amber" : "red"}>{d.ok ? "ok" : "missing"}</Badge> <span className="text-[11px] text-graphite-500">{d.detail}</span></td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}

function CapabilityDetail({ id, onClose }: { id?: string; onClose(): void }) {
  const client = useQueryClient();
  const cap = useQuery({ queryKey: ["capability", id], queryFn: () => api.get<Capability>(`/capabilities/${id}`), enabled: Boolean(id) });
  const done = () => {
    void client.invalidateQueries({ queryKey: ["capability", id] });
    void client.invalidateQueries({ queryKey: ["capabilities"] });
  };
  const resolve = useMutation({ mutationFn: () => api.post<CapabilityResolution>(`/capabilities/${id}/resolve`), onSettled: done });
  const enable = useMutation({ mutationFn: (enabled: boolean) => api.post(`/capabilities/${id}/enable`, { enabled }), onSettled: done });
  const trust = useMutation({ mutationFn: (t: Trust) => api.post(`/capabilities/${id}/trust`, { trust: t }), onSettled: done });
  const c = cap.data;
  return (
    <Drawer open={Boolean(id)} onClose={onClose} title={c ? `${c.name} ${c.version}` : "Capability"} width="w-[680px]">
      {cap.isLoading && <Spinner />}
      <ErrorBox error={cap.error} />
      {c && (
        <div className="space-y-5">
          <p>{c.description}</p>
          <div className="flex flex-wrap items-center gap-3">
            <Toggle checked={Boolean(c.enabled)} onChange={(v) => enable.mutate(v)} label={c.enabled ? "Enabled" : "Disabled"} />
            <Select value={c.trust} onChange={(e) => trust.mutate(e.target.value as Trust)} className="w-40" aria-label="Trust">
              <option value="untrusted">untrusted</option><option value="reviewed">reviewed</option><option value="trusted">trusted</option>
            </Select>
            <Button icon={<RefreshCw className="size-3.5" />} loading={resolve.isPending} onClick={() => resolve.mutate()}>Check dependencies</Button>
          </div>
          <ErrorBox error={enable.error ?? trust.error ?? resolve.error} />
          <KV items={[
            ["Slug", <span className="mono">{c.slug}</span>], ["Kind", c.kind], ["Install status", <StatusBadge status={c.install_status} />],
            ["Permissions", (c.manifest.permissions ?? []).map((p) => <Badge key={p} className="mono mr-1">{p}</Badge>)],
          ]} />
          <div>
            <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-graphite-500">Verification</h4>
            <Resolution r={resolve.data ?? c.verification} />
          </div>
          <div>
            <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-graphite-500">Manifest</h4>
            <Pre>{pretty(c.manifest)}</Pre>
          </div>
        </div>
      )}
    </Drawer>
  );
}

function CapabilitiesTab() {
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<string>();
  const caps = useQuery({ queryKey: ["capabilities", q], queryFn: () => api.get<Capability[]>("/capabilities", { q }) });
  return (
    <>
      <div className="relative mb-3 w-72">
        <Search className="absolute left-2.5 top-2 size-4 text-graphite-400" />
        <Input placeholder="Search capabilities" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" />
      </div>
      <Card bodyClassName="p-0">
        {caps.isLoading ? <Spinner /> : (
          <Table head={["Capability", "Kind", "Version", "Status", "Trust", "Enabled"]} empty={<Empty title="No capabilities match" />}>
            {(caps.data ?? []).map((c) => (
              <tr key={c.id} className="cursor-pointer hover:bg-graphite-50 dark:hover:bg-graphite-850" onClick={() => setSelected(c.id)}>
                <td><div className="font-medium">{c.name}</div><div className="line-clamp-1 text-[11px] text-graphite-500">{c.description}</div></td>
                <td><Badge>{c.kind}</Badge></td>
                <td className="mono">{c.version}</td>
                <td><StatusBadge status={c.verification?.status ?? c.install_status} /></td>
                <td><StatusBadge status={c.trust} /></td>
                <td>{c.enabled ? <Badge tone="green">on</Badge> : <Badge>off</Badge>}</td>
              </tr>
            ))}
          </Table>
        )}
        <ErrorBox error={caps.error} />
      </Card>
      <CapabilityDetail id={selected} onClose={() => setSelected(undefined)} />
    </>
  );
}

function RepositoryDetail({ id, onClose }: { id?: string; onClose(): void }) {
  const client = useQueryClient();
  const [q, setQ] = useState("");
  const repo = useQuery({ queryKey: ["repository", id], queryFn: () => api.get<Repository>(`/repositories/${id}`), enabled: Boolean(id) });
  const symbols = useQuery({
    queryKey: ["symbols", id, q], queryFn: () => api.get<{ symbol: string; kind: string; path: string; line: number }[]>(`/repositories/${id}/symbols`, { q }),
    enabled: Boolean(id && repo.data?.local_path),
  });
  const done = () => {
    void client.invalidateQueries({ queryKey: ["repository", id] });
    void client.invalidateQueries({ queryKey: ["repositories"] });
    void client.invalidateQueries({ queryKey: ["capabilities"] });
  };
  const analyze = useMutation({ mutationFn: () => api.post<Repository>(`/repositories/${id}/analyze`), onSettled: done });
  const propose = useMutation({ mutationFn: () => api.post<Record<string, unknown>>(`/repositories/${id}/propose-capability`), onSettled: done });
  const r = repo.data;
  return (
    <Drawer open={Boolean(id)} onClose={onClose} title={r?.full_name ?? "Repository"} width="w-[720px]">
      {repo.isLoading && <Spinner />}
      <ErrorBox error={repo.error} />
      {r && (
        <div className="space-y-5">
          {r.description && <p>{r.description}</p>}
          <div className="flex flex-wrap gap-2">
            {r.provider === "github" && (
              <Button icon={<ScanSearch className="size-3.5" />} loading={analyze.isPending} onClick={() => analyze.mutate()}>
                {r.analysis?.evidence ? "Re-analyse" : "Analyse metadata"}
              </Button>
            )}
            <Button icon={<Plus className="size-3.5" />} loading={propose.isPending} onClick={() => propose.mutate()}>Propose capability</Button>
          </div>
          <ErrorBox error={analyze.error ?? propose.error} />
          {propose.data && <Notice>Capability proposal registered (disabled, untrusted) — review it in the Capabilities tab.</Notice>}
          <KV items={[
            ["Provider", r.provider], ["Status", <StatusBadge status={r.status} />], ["Role", r.role],
            ["License", r.license ?? "unknown"], ["Default branch", r.default_branch], ["Head commit", r.head_commit ? <span className="mono">{r.head_commit.slice(0, 12)}</span> : "-"],
            ["Stars", r.stars], ["Last push", timeAgo(r.pushed_at)], ["Archived", r.archived === null ? "-" : r.archived ? "yes" : "no"],
            ["Local path", r.local_path ? <span className="mono">{r.local_path}</span> : "not cloned"], ["Topics", r.topics.join(", ") || "-"],
          ]} />
          {r.analysis?.verification_note && <Notice tone="amber">{r.analysis.verification_note}</Notice>}
          {r.analysis?.languages && (
            <div className="flex flex-wrap gap-1">{r.analysis.languages.map(([l, n]) => <Badge key={l}>{l}: {n}</Badge>)}</div>
          )}
          {r.analysis?.evidence && (
            <Table head={["Claim", "Evidence level", "Source"]}>
              {r.analysis.evidence.map((e, i) => (
                <tr key={i}><td>{e.claim}</td><td><Badge tone={e.level === "verified" ? "green" : e.level === "static" ? "blue" : "amber"}>{e.level}</Badge></td>
                  <td className="mono break-all text-[11px]">{e.source}</td></tr>
              ))}
            </Table>
          )}
          {r.local_path && (
            <div>
              <div className="mb-2 flex items-center gap-2">
                <h4 className="text-[11px] font-semibold uppercase tracking-wide text-graphite-500">Symbols (static index)</h4>
                <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter" className="w-48" />
              </div>
              <Table head={["Symbol", "Kind", "Location"]} empty={<div className="p-3 text-graphite-500">No symbols.</div>}>
                {(symbols.data ?? []).map((s, i) => (
                  <tr key={i}><td className="mono">{s.symbol}</td><td>{s.kind}</td><td className="mono text-[11px]">{s.path}:{s.line}</td></tr>
                ))}
              </Table>
            </div>
          )}
          {r.analysis && Object.keys(r.analysis).length > 0 && (
            <details><summary className="cursor-pointer text-xs text-graphite-500">Raw analysis</summary><Pre className="mt-2">{pretty(r.analysis)}</Pre></details>
          )}
        </div>
      )}
    </Drawer>
  );
}

function RepositoriesTab() {
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [selected, setSelected] = useState<string>();
  const repos = useQuery({ queryKey: ["repositories"], queryFn: () => api.get<Repository[]>("/repositories") });
  const done = () => void client.invalidateQueries({ queryKey: ["repositories"] });
  const add = useMutation({ mutationFn: () => api.post<Repository>("/repositories", { full_name: name }), onSuccess: (r) => { done(); setName(""); setSelected(r.id); } });
  const local = useMutation({ mutationFn: (p: string) => api.post<Repository>("/repositories/local", { path: p }), onSuccess: (r) => { done(); setSelected(r.id); } });
  const pick = async () => {
    const p = bridge ? await bridge.selectDirectory() : path.trim();
    if (p) local.mutate(p);
  };
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input placeholder="owner/repository" value={name} onChange={(e) => setName(e.target.value)} className="w-64" />
        <Button icon={<GitBranch className="size-3.5" />} disabled={!name.includes("/")} loading={add.isPending} onClick={() => add.mutate()}>Add GitHub repository</Button>
        {!bridge && <Input placeholder="Local folder path" value={path} onChange={(e) => setPath(e.target.value)} className="w-64" />}
        <Button icon={<FolderOpen className="size-3.5" />} loading={local.isPending} onClick={() => void pick()}>Index local folder</Button>
      </div>
      <div className="mb-3 space-y-2">
        <Notice>Repositories are capability evidence. Veylora reads GitHub metadata and the file tree through the API; it does not clone or execute anything unless a
          task needs it and you approve. Local indexing is a static scan of a folder you choose.</Notice>
        <ErrorBox error={add.error ?? local.error} />
      </div>
      <Card bodyClassName="p-0">
        {repos.isLoading ? <Spinner /> : (
          <Table head={["Repository", "Provider", "Status", "License", "Stars", "Role"]} empty={<Empty title="No repositories" />}>
            {(repos.data ?? []).map((r) => (
              <tr key={r.id} className="cursor-pointer hover:bg-graphite-50 dark:hover:bg-graphite-850" onClick={() => setSelected(r.id)}>
                <td><div className="font-medium">{r.full_name}{r.seeded ? <Badge tone="blue" className="ml-2">seeded</Badge> : null}</div>
                  <div className="line-clamp-1 text-[11px] text-graphite-500">{r.description}</div></td>
                <td>{r.provider}</td><td><StatusBadge status={r.status} /></td><td>{r.license ?? "-"}</td><td>{r.stars ?? "-"}</td><td>{r.role ?? "-"}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <RepositoryDetail id={selected} onClose={() => setSelected(undefined)} />
    </>
  );
}

function ReaTab() {
  const rea = useQuery({ queryKey: ["rea"], queryFn: () => api.get<Record<string, unknown>>("/rea/status") });
  if (rea.isLoading) return <Spinner label="Probing REA" />;
  const s = rea.data ?? {};
  return (
    <Card title="REA (morluto/rea) adapter">
      <ErrorBox error={rea.error} />
      <div className="space-y-3">
        <KV items={[
          ["Installed", s.installed ? <Badge tone="green">yes</Badge> : <Badge tone="amber">not found</Badge>],
          ["Path", s.path ? <span className="mono">{String(s.path)}</span> : "-"],
          ["Version", s.version ? String(s.version) : "-"],
          ["Interfaces", Array.isArray(s.interfaces) && s.interfaces.length ? s.interfaces.join(", ") : "-"],
          ["Inspect template", s.inspect_template ? <span className="mono">{(s.inspect_template as string[]).join(" ")}</span> : "not configured"],
          ["Detail", String(s.detail ?? "")],
        ]} />
        <Notice tone="amber">REA is optional. Inspection runs only on targets you own or are authorised to analyse, always requires an approval, and uses the
          argument template you configure in Settings. Veylora does not guess REA's command-line interface.</Notice>
        {typeof s.help_excerpt === "string" && s.help_excerpt && <Pre>{s.help_excerpt}</Pre>}
      </div>
    </Card>
  );
}

export default function Capabilities() {
  const [tab, setTab] = useState<"capabilities" | "repositories" | "rea">("capabilities");
  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader title="Capability Marketplace" subtitle="What this machine can actually do, verified against installed runtimes, and the repositories that back it." />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: "capabilities", label: "Capabilities" }, { id: "repositories", label: "Repositories" }, { id: "rea", label: "REA" }]} />
      <div className="mt-4">
        {tab === "capabilities" && <CapabilitiesTab />}
        {tab === "repositories" && <RepositoriesTab />}
        {tab === "rea" && <ReaTab />}
      </div>
    </div>
  );
}
