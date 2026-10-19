import type { Approval, Project } from "@veylora/contracts";
import { useQuery } from "@tanstack/react-query";
import { Bot, Cpu, FolderCode, House, Monitor, Moon, Puzzle, Settings, ShieldCheck, Sparkles, Sun, Workflow } from "lucide-react";
import type { ReactNode } from "react";
import { api } from "../lib/api";
import { bridge } from "../lib/bridge";
import { type Screen, type Theme, useApp } from "../store";
import { Logo } from "./Logo";
import { Select, cx } from "./ui";

const NAV: { screen: Screen; label: string; icon: ReactNode }[] = [
  { screen: "home", label: "Home", icon: <House className="size-4" /> },
  { screen: "studio", label: "Project Studio", icon: <Workflow className="size-4" /> },
  { screen: "agents", label: "Agent Ops", icon: <Bot className="size-4" /> },
  { screen: "skills", label: "Skill Marketplace", icon: <Sparkles className="size-4" /> },
  { screen: "capabilities", label: "Capabilities", icon: <Puzzle className="size-4" /> },
  { screen: "models", label: "Model Studio", icon: <Cpu className="size-4" /> },
  { screen: "explorer", label: "Code & Artifacts", icon: <FolderCode className="size-4" /> },
  { screen: "security", label: "Security", icon: <ShieldCheck className="size-4" /> },
  { screen: "settings", label: "Settings", icon: <Settings className="size-4" /> },
];

const THEMES: { id: Theme; icon: ReactNode; label: string }[] = [
  { id: "light", icon: <Sun className="size-3.5" />, label: "Light" },
  { id: "dark", icon: <Moon className="size-3.5" />, label: "Dark" },
  { id: "system", icon: <Monitor className="size-3.5" />, label: "System" },
];

export function usePendingApprovals() {
  return useQuery({ queryKey: ["approvals", "pending"], queryFn: () => api.get<Approval[]>("/approvals", { status: "pending" }) });
}

export function useProjects() {
  return useQuery({ queryKey: ["projects"], queryFn: () => api.get<Project[]>("/projects") });
}

/** Resolves which project a project-scoped screen should show. */
export function useCurrentProjectId(): string | undefined {
  const route = useApp((s) => s.route);
  const last = useApp((s) => s.lastProjectId);
  const projects = useProjects();
  return route.projectId ?? last ?? projects.data?.[0]?.id;
}

export function ProjectPicker({ screen }: { screen: Screen }) {
  const projects = useProjects();
  const current = useCurrentProjectId();
  const navigate = useApp((s) => s.navigate);
  if (!projects.data?.length) return null;
  return (
    <Select value={current ?? ""} onChange={(e) => navigate({ screen, projectId: e.target.value })} className="w-64" aria-label="Project">
      {projects.data.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
    </Select>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const route = useApp((s) => s.route);
  const navigate = useApp((s) => s.navigate);
  const theme = useApp((s) => s.theme);
  const setTheme = useApp((s) => s.setTheme);
  const streamConnected = useApp((s) => s.streamConnected);
  const approvals = usePendingApprovals();
  const pending = approvals.data?.length ?? 0;
  const mac = bridge?.platform === "darwin";

  return (
    <div className="flex h-full">
      <aside className="flex w-56 shrink-0 flex-col border-r border-graphite-200 bg-white dark:border-graphite-800 dark:bg-graphite-900">
        <div className={cx("drag-region flex items-center gap-2 px-4", mac ? "h-16 pt-5" : "h-12")}>
          <Logo />
          <div className="leading-tight">
            <div className="text-[13px] font-semibold">Veylora OS</div>
            <div className="text-[10px] text-graphite-500">From intent to working systems.</div>
          </div>
        </div>
        <nav className="flex-1 space-y-0.5 overflow-auto px-2 py-2">
          {NAV.map((item) => {
            const active = route.screen === item.screen;
            return (
              <button key={item.screen} onClick={() => navigate({ screen: item.screen, projectId: route.projectId })}
                className={cx("flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors",
                  active ? "bg-accent-50 font-medium text-accent-800 dark:bg-accent-500/15 dark:text-accent-200"
                         : "text-graphite-600 hover:bg-graphite-100 dark:text-graphite-300 dark:hover:bg-graphite-800")}>
                {item.icon}
                <span className="flex-1">{item.label}</span>
                {item.screen === "security" && pending > 0 && (
                  <span className="rounded-full bg-amber-500 px-1.5 text-[10px] font-semibold text-white">{pending}</span>
                )}
              </button>
            );
          })}
        </nav>
        <div className="space-y-2 border-t border-graphite-200 p-3 dark:border-graphite-800">
          <div className="flex items-center gap-2 text-[11px] text-graphite-500" title="Live event stream from the local backend">
            <span className={cx("size-2 rounded-full", streamConnected ? "bg-emerald-500" : "bg-amber-500")} />
            {streamConnected ? "Live: local backend" : "Reconnecting event stream"}
          </div>
          <div className="flex rounded-md bg-graphite-100 p-0.5 dark:bg-graphite-800" role="radiogroup" aria-label="Theme">
            {THEMES.map((t) => (
              <button key={t.id} role="radio" aria-checked={theme === t.id} title={t.label} onClick={() => setTheme(t.id)}
                className={cx("flex flex-1 items-center justify-center rounded py-1",
                  theme === t.id ? "bg-white shadow-sm dark:bg-graphite-700" : "text-graphite-500")}>
                {t.icon}
              </button>
            ))}
          </div>
        </div>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="drag-region h-3 shrink-0" />
        <div className="min-h-0 flex-1 overflow-auto px-6 pb-8 pt-3">{children}</div>
      </main>
    </div>
  );
}
