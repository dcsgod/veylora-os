import type { Task } from "@veylora/contracts";
import { Background, Controls, type Edge, Handle, MiniMap, type Node, type NodeProps, Position, ReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useMemo } from "react";
import { useApp } from "../store";
import { STATUS_TONE, StatusBadge, cx } from "./ui";

const BORDER: Record<string, string> = {
  neutral: "border-graphite-300 dark:border-graphite-700",
  blue: "border-accent-500",
  violet: "border-violet-500",
  green: "border-emerald-500",
  amber: "border-amber-500",
  red: "border-red-500",
};

const MINIMAP: Record<string, string> = {
  neutral: "#949ca6", blue: "#3b76f6", violet: "#8b5cf6", green: "#10b981", amber: "#f59e0b", red: "#ef4444",
};

type TaskNode = Node<{ task: Task; selected: boolean }, "task">;

function TaskCard({ data }: NodeProps<TaskNode>) {
  const { task, selected } = data;
  const tone = STATUS_TONE[task.status] ?? "neutral";
  return (
    <div className={cx("w-[230px] rounded-lg border-2 bg-white px-3 py-2 shadow-sm dark:bg-graphite-850", BORDER[tone],
      task.superseded_by && "opacity-40", selected && "ring-2 ring-accent-400 ring-offset-1 dark:ring-offset-graphite-950",
      task.status === "running" && "animate-pulse")}>
      <Handle type="target" position={Position.Left} className="!size-2 !border-0 !bg-graphite-400" />
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[12px] font-semibold" title={task.title}>{task.title}</div>
          <div className="truncate text-[10px] text-graphite-500">{task.key} · {task.role.replaceAll("_", " ")}</div>
        </div>
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-1">
        <StatusBadge status={task.status} />
        <span className="text-[10px] text-graphite-500">
          {task.attempts > 0 && `attempt ${task.attempts}/${task.max_retries + 1}`}
          {task.superseded_by && "superseded"}
        </span>
      </div>
      <Handle type="source" position={Position.Right} className="!size-2 !border-0 !bg-graphite-400" />
    </div>
  );
}

const nodeTypes = { task: TaskCard };

export function DagView({ tasks, edges, selectedId, onSelect, showSuperseded }:
  { tasks: Task[]; edges: { source: string; target: string }[]; selectedId?: string; onSelect(id: string): void; showSuperseded: boolean }) {
  const theme = useApp((s) => s.theme);
  const dark = document.documentElement.classList.contains("dark");

  const { nodes, links } = useMemo(() => {
    const visible = tasks.filter((t) => showSuperseded || !t.superseded_by);
    const ids = new Set(visible.map((t) => t.id));
    const byId = new Map(visible.map((t) => [t.id, t]));
    const nodes: TaskNode[] = visible.map((t) => ({
      id: t.id, type: "task", position: { x: t.position_x ?? 0, y: t.position_y ?? 0 },
      data: { task: t, selected: t.id === selectedId }, draggable: false, connectable: false,
    }));
    const links: Edge[] = edges.filter((e) => ids.has(e.source) && ids.has(e.target)).map((e) => {
      const live = byId.get(e.source)?.status === "running" || byId.get(e.target)?.status === "running";
      return { id: `${e.source}->${e.target}`, source: e.source, target: e.target, animated: live,
               style: { stroke: live ? "#3b76f6" : "#949ca6", strokeWidth: 1.5 } };
    });
    return { nodes, links };
  }, [tasks, edges, selectedId, showSuperseded]);

  return (
    <div className="h-full w-full" data-theme={theme}>
      <ReactFlow nodes={nodes} edges={links} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.15 }}
        nodesDraggable={false} nodesConnectable={false} elementsSelectable minZoom={0.2} maxZoom={1.6}
        colorMode={dark ? "dark" : "light"} onNodeClick={(_, n) => onSelect(n.id)} proOptions={{ hideAttribution: true }}>
        <Background gap={20} size={1} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable nodeColor={(n) => MINIMAP[STATUS_TONE[(n.data as { task: Task }).task.status] ?? "neutral"]} />
      </ReactFlow>
    </div>
  );
}
