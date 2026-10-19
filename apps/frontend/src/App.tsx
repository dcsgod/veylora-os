import { RotateCw } from "lucide-react";
import { lazy, Suspense, useEffect } from "react";
import { Shell } from "./components/Shell";
import { Logo } from "./components/Logo";
import { Button, Spinner } from "./components/ui";
import { useEventStream } from "./hooks/useEventStream";
import { health, setConnection } from "./lib/api";
import { bridge, isDesktop, resolveConnection } from "./lib/bridge";
import { useApp } from "./store";
import { Home } from "./screens/Home";

const ProjectStudio = lazy(() => import("./screens/ProjectStudio"));
const AgentOps = lazy(() => import("./screens/AgentOps"));
const Skills = lazy(() => import("./screens/Skills"));
const Capabilities = lazy(() => import("./screens/Capabilities"));
const Models = lazy(() => import("./screens/Models"));
const Explorer = lazy(() => import("./screens/Explorer"));
const Security = lazy(() => import("./screens/Security"));
const SettingsScreen = lazy(() => import("./screens/Settings"));

function useBackendConnection() {
  const setConnected = useApp((s) => s.setConnected);
  const setBackend = useApp((s) => s.setBackend);

  useEffect(() => {
    let cancelled = false;
    let attempt = 0;

    async function connect() {
      const conn = await resolveConnection();
      if (!conn) {
        setBackend({
          state: "failed",
          detail: isDesktop ? "The desktop shell did not provide a backend connection."
            : "Browser mode needs VITE_VEYLORA_API and VITE_VEYLORA_TOKEN (see CONTRIBUTING.md).",
        });
        return;
      }
      while (!cancelled) {
        if (await health(conn.apiBase)) {
          setConnection(conn);
          setBackend({ state: "ready" });
          setConnected(true);
          return;
        }
        attempt += 1;
        await new Promise((r) => setTimeout(r, Math.min(400 * attempt, 3000)));
      }
    }

    const off = bridge?.onBackendStatus((status) => {
      setBackend(status);
      if (status.state === "ready") void connect();
      else if (status.state !== "starting") setConnected(false);
    });
    void connect();
    return () => {
      cancelled = true;
      off?.();
    };
  }, [setBackend, setConnected]);
}

function Splash() {
  const backend = useApp((s) => s.backend);
  const failed = backend.state === "failed" || backend.state === "exited";
  return (
    <div className="drag-region flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
      <Logo size={44} />
      <div>
        <div className="text-lg font-semibold">Veylora OS</div>
        <div className="text-graphite-500">From intent to working systems.</div>
      </div>
      {failed ? (
        <div className="no-drag flex max-w-lg flex-col items-center gap-3">
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-left text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
            <div className="font-medium">Local backend is not running</div>
            <div className="mt-1 whitespace-pre-wrap text-xs">{backend.detail ?? "No details were reported."}</div>
          </div>
          {bridge && <Button variant="primary" icon={<RotateCw className="size-3.5" />} onClick={() => void bridge!.restartBackend()}>Restart backend</Button>}
        </div>
      ) : (
        <Spinner label="Starting local backend" />
      )}
    </div>
  );
}

function Screen() {
  const screen = useApp((s) => s.route.screen);
  switch (screen) {
    case "home": return <Home />;
    case "studio": return <ProjectStudio />;
    case "agents": return <AgentOps />;
    case "skills": return <Skills />;
    case "capabilities": return <Capabilities />;
    case "models": return <Models />;
    case "explorer": return <Explorer />;
    case "security": return <Security />;
    case "settings": return <SettingsScreen />;
  }
}

export function App() {
  useBackendConnection();
  useEventStream();
  const connected = useApp((s) => s.connected);
  if (!connected) return <Splash />;
  return (
    <Shell>
      <Suspense fallback={<Spinner />}>
        <Screen />
      </Suspense>
    </Shell>
  );
}
