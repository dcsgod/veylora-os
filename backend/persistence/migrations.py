MIGRATIONS: list[tuple[int, str, str]] = [
    (
        1,
        "initial schema",
        """
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  request TEXT NOT NULL,
  domain TEXT NOT NULL,
  status TEXT NOT NULL,
  autonomy TEXT NOT NULL DEFAULT 'review',
  allow_hosted_inference INTEGER NOT NULL DEFAULT 0,
  source_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_projects_workspace ON projects(workspace_id, updated_at);

CREATE TABLE specifications (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  content TEXT NOT NULL,
  source TEXT NOT NULL,
  author TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, revision)
);

CREATE TABLE plan_revisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  spec_revision INTEGER NOT NULL,
  reason TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, revision)
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  plan_revision INTEGER NOT NULL,
  parent_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  key TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  task_type TEXT NOT NULL,
  phase TEXT NOT NULL,
  role TEXT NOT NULL,
  candidate_model TEXT,
  required_capabilities TEXT NOT NULL DEFAULT '[]',
  skills TEXT NOT NULL DEFAULT '[]',
  permissions TEXT NOT NULL DEFAULT '[]',
  inputs TEXT NOT NULL DEFAULT '[]',
  outputs TEXT NOT NULL DEFAULT '[]',
  acceptance TEXT NOT NULL DEFAULT '[]',
  params TEXT NOT NULL DEFAULT '{}',
  rationale TEXT NOT NULL DEFAULT '[]',
  timeout_s INTEGER NOT NULL DEFAULT 300,
  max_retries INTEGER NOT NULL DEFAULT 1,
  attempts INTEGER NOT NULL DEFAULT 0,
  depth INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  verification_status TEXT NOT NULL DEFAULT 'unverified',
  result TEXT NOT NULL DEFAULT '{}',
  last_error TEXT,
  superseded_by TEXT,
  position_x REAL,
  position_y REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  UNIQUE(project_id, key)
);
CREATE INDEX idx_tasks_project_status ON tasks(project_id, status);

CREATE TABLE task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on_id)
);
CREATE INDEX idx_task_deps_reverse ON task_dependencies(depends_on_id);

CREATE TABLE agent_executions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  model TEXT,
  route_reason TEXT,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL,
  permissions TEXT NOT NULL DEFAULT '[]',
  last_event TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  model_latency_ms INTEGER,
  error TEXT,
  correlation_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX idx_agent_exec_project ON agent_executions(project_id, started_at);
CREATE INDEX idx_agent_exec_task ON agent_executions(task_id);

CREATE TABLE model_configs (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  installed INTEGER NOT NULL DEFAULT 0,
  context_length INTEGER,
  quantization TEXT,
  family TEXT,
  parameter_size TEXT,
  size_bytes INTEGER,
  capabilities TEXT NOT NULL DEFAULT '[]',
  role_assignments TEXT NOT NULL DEFAULT '[]',
  max_concurrency INTEGER NOT NULL DEFAULT 1,
  metadata TEXT NOT NULL DEFAULT '{}',
  last_seen_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(provider, name)
);

CREATE TABLE model_outcomes (
  model_id TEXT NOT NULL REFERENCES model_configs(id) ON DELETE CASCADE,
  task_class TEXT NOT NULL,
  successes INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  total_latency_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (model_id, task_class)
);

CREATE TABLE skills (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  source_repo TEXT,
  source_path TEXT,
  source_commit TEXT,
  license TEXT,
  version TEXT,
  instructions TEXT NOT NULL,
  frontmatter TEXT NOT NULL DEFAULT '{}',
  resources TEXT NOT NULL DEFAULT '[]',
  scripts TEXT NOT NULL DEFAULT '[]',
  external_urls TEXT NOT NULL DEFAULT '[]',
  roles TEXT NOT NULL DEFAULT '[]',
  prerequisites TEXT NOT NULL DEFAULT '[]',
  validation TEXT NOT NULL DEFAULT '{}',
  trust TEXT NOT NULL DEFAULT 'untrusted',
  enabled INTEGER NOT NULL DEFAULT 0,
  origin TEXT NOT NULL DEFAULT 'imported',
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  imported_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE skills_fts USING fts5(skill_id UNINDEXED, name, description, category, tags, instructions);

CREATE TABLE project_skills (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL,
  PRIMARY KEY (project_id, skill_id)
);

CREATE TABLE skill_usage (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE capabilities (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  kind TEXT NOT NULL,
  description TEXT NOT NULL,
  manifest TEXT NOT NULL,
  trust TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  verification TEXT NOT NULL DEFAULT '{}',
  install_status TEXT NOT NULL DEFAULT 'unknown',
  repository_id TEXT,
  updated_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE capabilities_fts USING fts5(capability_id UNINDEXED, name, description, tags);

CREATE TABLE repository_sources (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  full_name TEXT NOT NULL UNIQUE,
  url TEXT,
  local_path TEXT,
  description TEXT,
  license TEXT,
  default_branch TEXT,
  head_commit TEXT,
  archived INTEGER,
  stars INTEGER,
  pushed_at TEXT,
  topics TEXT NOT NULL DEFAULT '[]',
  analysis TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  seeded INTEGER NOT NULL DEFAULT 0,
  role TEXT,
  indexed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE repo_symbols (
  repository_id TEXT NOT NULL REFERENCES repository_sources(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  symbol TEXT NOT NULL,
  kind TEXT NOT NULL,
  line INTEGER NOT NULL
);
CREATE INDEX idx_repo_symbols ON repo_symbols(repository_id, symbol);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  mime TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_artifacts_project ON artifacts(project_id, created_at);

CREATE TABLE tool_executions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  agent_execution_id TEXT,
  tool TEXT NOT NULL,
  args TEXT NOT NULL,
  idempotency_key TEXT UNIQUE,
  status TEXT NOT NULL,
  exit_code INTEGER,
  duration_ms INTEGER,
  output_excerpt TEXT,
  correlation_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_tool_exec_task ON tool_executions(task_id);

CREATE TABLE approval_requests (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  agent_role TEXT NOT NULL,
  permission TEXT NOT NULL,
  action TEXT NOT NULL,
  action_key TEXT NOT NULL,
  targets TEXT NOT NULL,
  reason TEXT NOT NULL,
  risk TEXT NOT NULL,
  status TEXT NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0,
  decided_by TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_approvals_status ON approval_requests(status, created_at);
CREATE INDEX idx_approvals_key ON approval_requests(task_id, action_key);

CREATE TABLE test_results (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  suite TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  passed INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  report TEXT NOT NULL DEFAULT '{}',
  artifact_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_test_results_project ON test_results(project_id, created_at);

CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  project_id TEXT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  decision TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_audit_ts ON audit_events(ts);

CREATE TABLE resource_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  project_id TEXT,
  task_id TEXT,
  source TEXT NOT NULL,
  cpu_percent REAL,
  rss_mb REAL,
  details TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE project_memory (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, key)
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  project_id TEXT,
  task_id TEXT,
  type TEXT NOT NULL,
  correlation_id TEXT,
  payload TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_events_project ON events(project_id, id);

CREATE TABLE previews (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  port INTEGER NOT NULL,
  status TEXT NOT NULL,
  pid INTEGER,
  log_tail TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL,
  stopped_at TEXT
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
""",
    ),
]
