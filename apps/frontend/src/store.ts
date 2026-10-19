import type { BackendStatus, VeyloraEvent } from "@veylora/contracts";
import { create } from "zustand";

export type Screen = "home" | "studio" | "agents" | "skills" | "capabilities" | "models" | "explorer" | "security" | "settings";
export type Theme = "light" | "dark" | "system";

interface Route {
  screen: Screen;
  projectId?: string;
  taskId?: string;
  artifactId?: string;
}

interface AppState {
  route: Route;
  navigate(route: Route): void;
  theme: Theme;
  setTheme(theme: Theme): void;
  backend: BackendStatus;
  setBackend(status: BackendStatus): void;
  connected: boolean;
  setConnected(c: boolean): void;
  streamConnected: boolean;
  setStreamConnected(c: boolean): void;
  events: VeyloraEvent[];
  pushEvent(e: VeyloraEvent): void;
  lastProjectId?: string;
}

const MAX_EVENTS = 800;

export const useApp = create<AppState>((set) => ({
  route: { screen: "home" },
  navigate: (route) => set((s) => ({ route, lastProjectId: route.projectId ?? s.lastProjectId })),
  theme: (localStorage.getItem("veylora.theme") as Theme | null) ?? "system",
  setTheme: (theme) => {
    localStorage.setItem("veylora.theme", theme);
    set({ theme });
  },
  backend: { state: "starting" },
  setBackend: (backend) => set({ backend }),
  connected: false,
  setConnected: (connected) => set({ connected }),
  streamConnected: false,
  setStreamConnected: (streamConnected) => set({ streamConnected }),
  events: [],
  pushEvent: (e) =>
    set((s) => {
      if (s.events.length && s.events[s.events.length - 1].id >= e.id) return s;
      const events = s.events.length >= MAX_EVENTS ? s.events.slice(-MAX_EVENTS + 1) : s.events.slice();
      events.push(e);
      return { events };
    }),
}));

export function applyTheme(theme: Theme) {
  const dark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}
