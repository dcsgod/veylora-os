export const API_PREFIX = "/api/v1";

export const TASK_STATUSES = [
  "pending", "ready", "running", "verifying", "completed", "blocked", "failed", "cancelled", "waiting_for_approval",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export type ProjectStatus = "draft" | "planned" | "running" | "paused" | "completed" | "failed" | "cancelled";
export type Autonomy = "review" | "auto";
export type Trust = "untrusted" | "reviewed" | "trusted";

export interface AcceptanceCriterion { id: string; text: string; evidence: string }

export interface Specification {
  title: string;
  summary: string;
  domain: string;
  blueprint: string | null;
  features: string[];
  entities: string[];
  constraints: string[];
  acceptance_criteria: AcceptanceCriterion[];
  assumptions: string[];
  open_questions: string[];
  out_of_scope: string[];
  targets: string[];
  detection: { domain?: string; scores?: Record<string, number>; matched?: Record<string, string[]>; overridden?: boolean };
  source: string;
}

export interface Project {
  id: string;
  workspace_id: string;
  name: string;
  request: string;
  domain: string;
  status: ProjectStatus;
  autonomy: Autonomy;
  allow_hosted_inference: number;
  created_at: string;
  updated_at: string;
  scheduler_active?: boolean;
  pending_approvals?: number;
  preview?: Preview | null;
  task_counts?: Record<string, number>;
}

export interface Task {
  id: string;
  project_id: string;
  plan_revision: number;
  parent_task_id: string | null;
  key: string;
  title: string;
  description: string;
  task_type: string;
  phase: string;
  role: string;
  candidate_model: string | null;
  required_capabilities: string[];
  skills: string[];
  permissions: string[];
  inputs: string[];
  outputs: string[];
  acceptance: string[];
  params: Record<string, unknown>;
  rationale: string[];
  timeout_s: number;
  max_retries: number;
  attempts: number;
  status: TaskStatus;
  verification_status: string;
  result: Record<string, unknown>;
  last_error: string | null;
  superseded_by: string | null;
  position_x: number | null;
  position_y: number | null;
  depends_on: string[];
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface PlanRevision { id: string; revision: number; spec_revision: number; reason: string; summary: unknown; created_at: string }
export interface Plan { revisions: PlanRevision[]; tasks: Task[]; edges: { source: string; target: string }[] }

export interface AgentExecution {
  id: string;
  project_id: string;
  task_id: string;
  task_key?: string;
  task_title?: string;
  role: string;
  model: string | null;
  route_reason: string | null;
  attempt: number;
  status: string;
  permissions: string[];
  last_event: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  model_latency_ms: number | null;
  error: string | null;
  correlation_id: string;
  started_at: string;
  finished_at: string | null;
}

export interface ToolExecution {
  id: string;
  task_id: string | null;
  tool: string;
  args: unknown;
  status: string;
  exit_code: number | null;
  duration_ms: number | null;
  output_excerpt: string | null;
  created_at: string;
}

export interface Artifact {
  id: string;
  project_id: string;
  task_id: string | null;
  kind: string;
  name: string;
  rel_path: string;
  sha256: string;
  size: number;
  mime: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface Approval {
  id: string;
  project_id: string | null;
  task_id: string | null;
  task_key?: string | null;
  task_title?: string | null;
  project_name?: string | null;
  agent_role: string;
  permission: string;
  action: string;
  targets: string[];
  reason: string;
  risk: "low" | "medium" | "high" | "critical";
  status: "pending" | "approved" | "denied";
  consumed: number;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
}

export interface TaskDetail extends Task {
  executions: AgentExecution[];
  tools: ToolExecution[];
  artifacts: Artifact[];
  approvals: Approval[];
}

export interface TestResult {
  id: string;
  project_id: string;
  task_id: string | null;
  suite: string;
  kind: string;
  status: string;
  passed: number;
  failed: number;
  skipped: number;
  duration_ms: number | null;
  report: Record<string, unknown>;
  created_at: string;
}

export interface Preview { id: string; project_id: string; url: string; port: number; status: string; pid: number | null; started_at: string; stopped_at: string | null }

export interface AuditEvent { id: number; ts: string; project_id: string | null; actor: string; action: string; target: string; decision: string; details: Record<string, unknown> }

export interface VeyloraEvent {
  id: number;
  ts: string;
  project_id: string | null;
  task_id: string | null;
  type: string;
  correlation_id: string | null;
  payload: Record<string, unknown>;
}

export interface Role { id: string; title: string; description: string; model_class: string; tools: string[]; grants: Record<string, string> }

export interface ModelConfig {
  id: string;
  provider: string;
  name: string;
  enabled: number;
  installed: number;
  context_length: number | null;
  quantization: string | null;
  family: string | null;
  parameter_size: string | null;
  size_bytes: number | null;
  capabilities: string[];
  role_assignments: string[];
  max_concurrency: number;
  metadata: Record<string, unknown>;
  last_seen_at: string | null;
  outcomes: { task_class: string; successes: number; failures: number; total_latency_ms: number }[];
  provider_kind: "local" | "hosted";
  provider_connected: boolean;
}

export interface ProviderConfig {
  id: string;
  type: "ollama" | "llama_cpp" | "openai_compatible";
  url: string;
  enabled: boolean;
  max_concurrency: number;
  name?: string | null;
  api_key_env?: string | null;
}

export interface ProviderHealth {
  provider: string;
  kind: string;
  name: string;
  ok: boolean;
  detail?: string;
  version?: string;
  loaded_models: string[];
  queued: number;
  active: number;
  max_concurrency: number;
}

export interface RouteDecision {
  model_id: string | null;
  model_name: string | null;
  provider: string | null;
  task_class: string;
  complexity: string;
  reason: string;
  considered: { model_id: string; model: string; excluded?: string; score?: number; notes?: string[] }[];
}

export interface Skill {
  id: string;
  slug: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  source_repo: string | null;
  source_path: string | null;
  source_commit: string | null;
  license: string | null;
  version: string | null;
  instructions?: string;
  resources: string[];
  scripts: string[];
  external_urls: string[];
  roles: string[];
  prerequisites: string[];
  validation: { valid: boolean; errors: string[]; warnings: string[]; format?: string };
  trust: Trust;
  enabled: number;
  origin: string;
  project_id: string | null;
  imported_at: string;
  usage?: Record<string, number>;
}

export interface Capability {
  id: string;
  slug: string;
  name: string;
  version: string;
  kind: string;
  description: string;
  manifest: Record<string, unknown> & { dependencies?: { kind: string; name: string; version?: string; optional?: boolean }[]; permissions?: string[] };
  trust: Trust;
  enabled: number;
  verification: Partial<CapabilityResolution>;
  install_status: string;
  repository_id: string | null;
  updated_at: string;
}

export interface CapabilityResolution {
  slug: string;
  status: string;
  problems: string[];
  warnings: string[];
  dependencies: { kind: string; name: string; version?: string | null; optional?: boolean; ok: boolean; detail: string }[];
  checked_at: string;
  method: string;
}

export interface Repository {
  id: string;
  provider: string;
  full_name: string;
  url: string | null;
  local_path: string | null;
  description: string | null;
  license: string | null;
  default_branch: string | null;
  head_commit: string | null;
  archived: number | null;
  stars: number | null;
  pushed_at: string | null;
  topics: string[];
  analysis: Record<string, unknown> & {
    evidence?: { claim: string; level: string; source: string }[];
    languages?: [string, number][];
    verification_note?: string;
  };
  status: string;
  seeded: number;
  role: string | null;
  indexed_at: string | null;
  created_at: string;
}

export interface Settings {
  network_allowlist: string[];
  hosted_authorized: boolean;
  providers: ProviderConfig[];
  rea_executable: string | null;
  rea_inspect_args: string[] | null;
  max_parallel: number;
  theme: "light" | "dark" | "system";
  data_dir: string;
  note?: string;
}

export interface SystemInfo {
  version: string;
  platform: string;
  python: string;
  data_dir: string;
  executables: Record<string, string | null>;
  playwright_module: boolean;
  git: string | null;
  recovery: { requeued_tasks: number; paused_projects: number } | null;
  uptime_s: number;
}

export interface Resources {
  system: { cpu_percent: number; cpu_count: number; memory_total_mb: number; memory_used_percent: number };
  backend: { rss_mb: number; child_processes: number };
  scheduler: { running_tasks: number; max_parallel: number };
  models: { provider: string; queued: number; active: number }[];
}

export interface GitCommit { commit: string; author: string; date: string; refs: string; subject: string }
export interface FileEntry { path: string; size: number }
export interface FileContent { path: string; binary: boolean; size: number; content?: string }

/** Narrow bridge exposed by the Electron preload. Nothing here grants filesystem or shell access to the renderer. */
export interface DesktopBridge {
  platform: string;
  getConnection(): Promise<{ apiBase: string; token: string } | null>;
  onBackendStatus(cb: (status: BackendStatus) => void): () => void;
  restartBackend(): Promise<void>;
  openPreview(url: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  selectDirectory(): Promise<string | null>;
  getDesktopSettings(): Promise<DesktopSettings>;
  setWorkspaceMode(enabled: boolean): Promise<DesktopSettings>;
  setLaunchAtLogin(enabled: boolean): Promise<DesktopSettings>;
}

export interface BackendStatus { state: "starting" | "ready" | "exited" | "failed"; detail?: string }
export interface DesktopSettings { workspaceMode: boolean; launchAtLogin: boolean; launchAtLoginSupported: boolean; version: string }
