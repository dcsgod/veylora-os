import type { Artifact, FileContent, FileEntry, GitCommit } from "@veylora/contracts";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Download, File, FileCode, Folder, FolderCode, GitCommitHorizontal, Package } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { CodeViewer } from "../components/CodeViewer";
import { ProjectPicker, useCurrentProjectId } from "../components/Shell";
import { Badge, Button, Card, cx, Empty, ErrorBox, PageHeader, Spinner, Tabs } from "../components/ui";
import { api } from "../lib/api";
import { bytes, languageFor, timeAgo } from "../lib/format";
import { useApp } from "../store";

type View = "files" | "history" | "artifacts";
const PANEL = "h-[calc(100vh-210px)] min-h-[360px]";

interface TreeNode { name: string; path: string; size?: number; children?: TreeNode[] }

function buildTree(files: FileEntry[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", children: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join("/");
      if (i === parts.length - 1) {
        node.children!.push({ name: part, path, size: f.size });
        return;
      }
      let dir = node.children!.find((c) => c.children && c.name === part);
      if (!dir) {
        dir = { name: part, path, children: [] };
        node.children!.push(dir);
      }
      node = dir;
    });
  }
  const sort = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => Number(Boolean(b.children)) - Number(Boolean(a.children)) || a.name.localeCompare(b.name));
    nodes.forEach((n) => n.children && sort(n.children));
  };
  sort(root.children!);
  return root.children!;
}

function Tree({ nodes, depth, open, toggle, selected, onSelect }:
  { nodes: TreeNode[]; depth: number; open: Set<string>; toggle(p: string): void; selected?: string; onSelect(p: string): void }) {
  return (
    <>
      {nodes.map((n) => (
        <div key={n.path}>
          <button onClick={() => (n.children ? toggle(n.path) : onSelect(n.path))} style={{ paddingLeft: 8 + depth * 14 }}
            className={cx("flex w-full items-center gap-1.5 rounded py-1 pr-2 text-left text-xs hover:bg-graphite-100 dark:hover:bg-graphite-800",
              selected === n.path && "bg-accent-50 text-accent-800 dark:bg-accent-500/15 dark:text-accent-200")}>
            {n.children ? (open.has(n.path) ? <ChevronDown className="size-3 shrink-0" /> : <ChevronRight className="size-3 shrink-0" />)
                        : <span className="w-3 shrink-0" />}
            {n.children ? <Folder className="size-3.5 shrink-0 text-graphite-400" /> : <File className="size-3.5 shrink-0 text-graphite-400" />}
            <span className="truncate">{n.name}</span>
          </button>
          {n.children && open.has(n.path) && (
            <Tree nodes={n.children} depth={depth + 1} open={open} toggle={toggle} selected={selected} onSelect={onSelect} />
          )}
        </div>
      ))}
    </>
  );
}

function FilesView({ projectId }: { projectId: string }) {
  const files = useQuery({ queryKey: ["files", projectId], queryFn: () => api.get<FileEntry[]>(`/projects/${projectId}/files`), retry: false });
  const [selected, setSelected] = useState<string>();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const tree = useMemo(() => buildTree(files.data ?? []), [files.data]);
  const content = useQuery({
    queryKey: ["files", projectId, selected],
    queryFn: () => api.get<FileContent>(`/projects/${projectId}/file`, { path: selected }),
    enabled: Boolean(selected),
    retry: false,
  });
  useEffect(() => {
    setSelected(undefined);
    setOpen(new Set());
  }, [projectId]);
  const toggle = (p: string) => setOpen((s) => {
    const next = new Set(s);
    if (next.has(p)) next.delete(p);
    else next.add(p);
    return next;
  });
  if (files.isLoading) return <Spinner />;
  if (files.error) return <Empty icon={<FolderCode className="size-6" />} title="No repository yet">The workspace repository is created when the plan starts running.</Empty>;
  return (
    <div className={cx("grid grid-cols-[260px_1fr] gap-3", PANEL)}>
      <Card bodyClassName="p-1.5 h-full overflow-auto" className="min-h-0 overflow-hidden">
        {tree.length === 0 ? <div className="p-3 text-xs text-graphite-500">The repository is empty.</div>
          : <Tree nodes={tree} depth={0} open={open} toggle={toggle} selected={selected} onSelect={setSelected} />}
      </Card>
      <Card className="flex min-h-0 flex-col overflow-hidden" bodyClassName="min-h-0 flex-1 p-0"
        title={selected ? <span className="mono text-xs">{selected}</span> : "Select a file"}
        actions={content.data && <span className="text-[11px] text-graphite-500">{bytes(content.data.size)}</span>}>
        {!selected ? <Empty icon={<FileCode className="size-6" />} title="Choose a file from the tree">Files are shown read-only.</Empty>
          : content.isLoading ? <Spinner />
          : content.error ? <div className="p-4"><ErrorBox error={content.error} /></div>
          : content.data?.binary ? <Empty title="Binary file">This file is not displayed.</Empty>
          : <CodeViewer value={content.data?.content ?? ""} lang={languageFor(selected)} path={`file:///${projectId}/${selected}`} />}
      </Card>
    </div>
  );
}

function HistoryView({ projectId }: { projectId: string }) {
  const log = useQuery({ queryKey: ["git", projectId], queryFn: () => api.get<GitCommit[]>(`/projects/${projectId}/git/log`), retry: false });
  const [commit, setCommit] = useState<string>();
  const show = useQuery({
    queryKey: ["git", projectId, commit],
    queryFn: () => api.text(`/projects/${projectId}/git/show/${commit}`),
    enabled: Boolean(commit),
  });
  useEffect(() => setCommit(undefined), [projectId]);
  if (log.isLoading) return <Spinner />;
  if (log.error) return <Empty icon={<GitCommitHorizontal className="size-6" />} title="No repository yet" />;
  return (
    <div className={cx("grid grid-cols-[380px_1fr] gap-3", PANEL)}>
      <Card bodyClassName="p-0 h-full overflow-auto" className="min-h-0 overflow-hidden">
        {(log.data ?? []).length === 0 && <div className="p-3 text-xs text-graphite-500">No commits yet.</div>}
        <ul className="divide-y divide-graphite-100 dark:divide-graphite-800">
          {(log.data ?? []).map((c) => (
            <li key={c.commit}>
              <button onClick={() => setCommit(c.commit)}
                className={cx("w-full px-3 py-2 text-left hover:bg-graphite-50 dark:hover:bg-graphite-850",
                  commit === c.commit && "bg-accent-50 dark:bg-accent-500/10")}>
                <div className="truncate text-xs font-medium">{c.subject}</div>
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-graphite-500">
                  <span className="mono">{c.commit.slice(0, 8)}</span><span>{c.author}</span><span>{timeAgo(c.date)}</span>
                  {c.refs && c.refs.split(", ").map((r) => <Badge key={r} tone="blue">{r.replace("HEAD -> ", "")}</Badge>)}
                </div>
              </button>
            </li>
          ))}
        </ul>
      </Card>
      <Card className="flex min-h-0 flex-col overflow-hidden" bodyClassName="min-h-0 flex-1 p-0"
        title={commit ? <span className="mono text-xs">{commit.slice(0, 12)}</span> : "Select a commit"}>
        {!commit ? <Empty title="Choose a commit to see its diff" />
          : show.isLoading ? <Spinner />
          : show.error ? <div className="p-4"><ErrorBox error={show.error} /></div>
          : <CodeViewer value={show.data ?? ""} lang="plaintext" path={`git:///${projectId}/${commit}`} />}
      </Card>
    </div>
  );
}

function ArtifactBody({ artifact }: { artifact: Artifact }) {
  const textual = /^(text\/|application\/json|application\/javascript|image\/svg\+xml)/.test(artifact.mime);
  const image = artifact.mime === "image/png" || artifact.mime === "image/jpeg";
  const text = useQuery({
    queryKey: ["artifact-content", artifact.id],
    queryFn: () => api.text(`/artifacts/${artifact.id}/content`),
    enabled: textual,
  });
  const [imageUrl, setImageUrl] = useState<string>();
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    if (!image) return;
    let url: string | undefined;
    let alive = true;
    api.blob(`/artifacts/${artifact.id}/content`).then((b) => {
      url = URL.createObjectURL(b);
      if (alive) setImageUrl(url);
    }, setError);
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
      setImageUrl(undefined);
    };
  }, [artifact.id, image]);
  const download = async () => {
    try {
      const blob = await api.blob(`/artifacts/${artifact.id}/content`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = artifact.name.split("/").pop() || "artifact";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(e);
    }
  };
  if (textual) {
    if (text.isLoading) return <Spinner />;
    if (text.error) return <div className="p-4"><ErrorBox error={text.error} /></div>;
    return <CodeViewer value={text.data ?? ""} lang={artifact.mime === "application/json" ? "json" : languageFor(artifact.name)}
      path={`artifact:///${artifact.id}/${artifact.name}`} />;
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 overflow-auto p-4">
      <ErrorBox error={error} />
      {image ? (imageUrl ? <img src={imageUrl} alt={artifact.name} className="max-h-full max-w-full rounded border border-graphite-200 dark:border-graphite-700" /> : <Spinner />)
             : <Empty title="Binary artifact">This artifact is not rendered in the app.</Empty>}
      <Button size="sm" icon={<Download className="size-3.5" />} onClick={download}>Save a copy</Button>
    </div>
  );
}

function ArtifactsView({ projectId }: { projectId: string }) {
  const route = useApp((s) => s.route);
  const artifacts = useQuery({ queryKey: ["artifacts", projectId], queryFn: () => api.get<Artifact[]>(`/projects/${projectId}/artifacts`) });
  const [selected, setSelected] = useState<string | undefined>(route.artifactId);
  useEffect(() => setSelected(route.artifactId), [route.artifactId, projectId]);
  const current = artifacts.data?.find((a) => a.id === selected);
  if (artifacts.isLoading) return <Spinner />;
  return (
    <div className={cx("grid grid-cols-[340px_1fr] gap-3", PANEL)}>
      <Card bodyClassName="p-0 h-full overflow-auto" className="min-h-0 overflow-hidden">
        <ErrorBox error={artifacts.error} />
        {(artifacts.data ?? []).length === 0 && <div className="p-3 text-xs text-graphite-500">No artifacts recorded yet.</div>}
        <ul className="divide-y divide-graphite-100 dark:divide-graphite-800">
          {(artifacts.data ?? []).map((a) => (
            <li key={a.id}>
              <button onClick={() => setSelected(a.id)}
                className={cx("w-full px-3 py-2 text-left hover:bg-graphite-50 dark:hover:bg-graphite-850", selected === a.id && "bg-accent-50 dark:bg-accent-500/10")}>
                <div className="truncate text-xs font-medium">{a.name}</div>
                <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-graphite-500">
                  <Badge>{a.kind}</Badge><span>{bytes(a.size)}</span><span>{timeAgo(a.created_at)}</span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      </Card>
      <Card className="flex min-h-0 flex-col overflow-hidden" bodyClassName="min-h-0 flex-1 p-0"
        title={current ? <span className="text-xs">{current.name}</span> : "Select an artifact"}
        actions={current && <span className="mono text-[11px] text-graphite-500" title="SHA-256">{current.sha256.slice(0, 12)} · {current.mime}</span>}>
        {current ? <ArtifactBody artifact={current} /> : <Empty icon={<Package className="size-6" />} title="Choose an artifact">
          Reports, logs, screenshots and generated documents produced by agents.</Empty>}
      </Card>
    </div>
  );
}

export default function Explorer() {
  const route = useApp((s) => s.route);
  const projectId = useCurrentProjectId();
  const [view, setView] = useState<View>(route.artifactId ? "artifacts" : "files");
  useEffect(() => {
    if (route.artifactId) setView("artifacts");
  }, [route.artifactId]);
  return (
    <div>
      <PageHeader title="Code explorer" subtitle="Browse the generated repository, its history and recorded artifacts. Everything is read-only."
        actions={<ProjectPicker screen="explorer" />} />
      {!projectId ? <Empty icon={<FolderCode className="size-6" />} title="No projects yet">Create a project from Home first.</Empty> : (
        <div className="space-y-3">
          <Tabs value={view} onChange={setView} tabs={[
            { id: "files", label: "Files" }, { id: "history", label: "History" }, { id: "artifacts", label: "Artifacts" },
          ]} />
          {view === "files" && <FilesView projectId={projectId} />}
          {view === "history" && <HistoryView projectId={projectId} />}
          {view === "artifacts" && <ArtifactsView projectId={projectId} />}
        </div>
      )}
    </div>
  );
}
