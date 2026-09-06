export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  verify_command TEXT,
  profile_id TEXT,
  profile_path TEXT,
  profile_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT '',
  UNIQUE(company_id, name)
);

CREATE TABLE IF NOT EXISTS repositories (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  remote_url TEXT,
  default_branch TEXT NOT NULL DEFAULT 'main',
  role TEXT NOT NULL DEFAULT 'primary',
  profile_path TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, name)
);

CREATE TABLE IF NOT EXISTS product_areas (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  owner_persona_id TEXT REFERENCES personas(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, name)
);

CREATE TABLE IF NOT EXISTS milestones (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'planned',
  target_date TEXT,
  progress INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(project_id, name)
);

CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  milestone_id TEXT REFERENCES milestones(id) ON DELETE SET NULL,
  product_area_id TEXT REFERENCES product_areas(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'planned',
  priority INTEGER NOT NULL DEFAULT 0,
  root_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  task_tree_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  adapter_type TEXT NOT NULL,
  status TEXT NOT NULL,
  model TEXT,
  instructions_path TEXT,
  command TEXT,
  env_json TEXT NOT NULL,
  heartbeat_enabled INTEGER NOT NULL DEFAULT 1,
  heartbeat_interval_sec INTEGER NOT NULL DEFAULT 300,
  budget_limit INTEGER,
  budget_window TEXT NOT NULL DEFAULT 'monthly',
  last_heartbeat_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(company_id, name)
);

CREATE TABLE IF NOT EXISTS personas (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  stage TEXT NOT NULL,
  owned_lanes_json TEXT NOT NULL,
  preferred_adapter_type TEXT NOT NULL,
  instructions_path TEXT,
  status TEXT NOT NULL,
  budget_limit INTEGER,
  budget_window TEXT NOT NULL DEFAULT 'monthly',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(company_id, name)
);

CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL,
  root_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  source_profile_id TEXT,
  source_project_version TEXT,
  orchestra_kind TEXT NOT NULL DEFAULT 'generic',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS task_sources (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(company_id, name)
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  workflow_id TEXT REFERENCES workflows(id) ON DELETE SET NULL,
  goal_id TEXT REFERENCES goals(id) ON DELETE SET NULL,
  milestone_id TEXT REFERENCES milestones(id) ON DELETE SET NULL,
  parent_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  depends_on_task_ids_json TEXT NOT NULL DEFAULT '[]',
  persona_id TEXT REFERENCES personas(id) ON DELETE SET NULL,
  stage TEXT,
  kind TEXT NOT NULL DEFAULT 'user',
  priority INTEGER NOT NULL DEFAULT 0,
  scheduled_at TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  title TEXT NOT NULL,
  description TEXT,
  labels_json TEXT NOT NULL,
  changed_files_json TEXT NOT NULL,
  task_package_json TEXT,
  status TEXT NOT NULL,
  assigned_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  requested_adapter_type TEXT,
  lane_id TEXT,
  allowed_paths_json TEXT NOT NULL DEFAULT '[]',
  required_reading_json TEXT NOT NULL DEFAULT '[]',
  verification_commands_json TEXT NOT NULL DEFAULT '[]',
  claim_status TEXT NOT NULL DEFAULT 'unclaimed',
  claim_token TEXT,
  claim_expires_at TEXT,
  claim_owner_run_id TEXT,
  claim_owner_agent_id TEXT,
  claimed_at TEXT,
  lineage_root_id TEXT,
  lineage_parent_id TEXT,
  task_package_path TEXT,
  review_handoff_path TEXT,
  artifact_dir TEXT,
  review_required INTEGER NOT NULL DEFAULT 0,
  approval_required INTEGER NOT NULL DEFAULT 0,
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 1,
  last_error TEXT,
  blocked_reason TEXT,
  last_recovery_at TEXT,
  last_recovery_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  adapter_type TEXT,
  kind TEXT NOT NULL DEFAULT 'user',
  status TEXT NOT NULL,
  session_key TEXT,
  session_display_id TEXT,
  response_text TEXT,
  error_text TEXT,
  usage_json TEXT,
  branch_name TEXT,
  pr_number INTEGER,
  head_sha TEXT,
  verification_summary TEXT,
  wake_reason TEXT NOT NULL DEFAULT 'manual',
  heartbeat_job_id TEXT,
  worktree_path TEXT,
  manifest_path TEXT,
  review_verdict TEXT,
  promotion_record_id TEXT,
  cost_cents INTEGER,
  retry_class TEXT NOT NULL DEFAULT 'none',
  metadata_json TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS team_assignments (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  routing_reason TEXT NOT NULL,
  routing_decision_json TEXT NOT NULL DEFAULT '{}',
  artifact_paths_json TEXT NOT NULL DEFAULT '[]',
  release_reason TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_team_assignments_project_status
  ON team_assignments(project_id, status, started_at);
CREATE INDEX IF NOT EXISTS idx_team_assignments_agent_status
  ON team_assignments(agent_id, status, started_at);

CREATE TABLE IF NOT EXISTS team_artifact_claims (
  id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL REFERENCES team_assignments(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  artifact_path TEXT NOT NULL,
  status TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  released_at TEXT,
  release_reason TEXT,
  UNIQUE(assignment_id, artifact_path)
);

CREATE INDEX IF NOT EXISTS idx_team_artifact_claims_project_status
  ON team_artifact_claims(project_id, status, artifact_path);
CREATE INDEX IF NOT EXISTS idx_team_artifact_claims_assignment
  ON team_artifact_claims(assignment_id, status);

CREATE TABLE IF NOT EXISTS team_reviewer_lockouts (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  source_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  source_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  source_assignment_id TEXT REFERENCES team_assignments(id) ON DELETE SET NULL,
  locked_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  reviewer_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  reviewer_actor TEXT NOT NULL,
  artifact_path TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  cleared_at TEXT,
  cleared_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_team_reviewer_lockouts_task_status
  ON team_reviewer_lockouts(task_id, status, artifact_path);
CREATE INDEX IF NOT EXISTS idx_team_reviewer_lockouts_agent_status
  ON team_reviewer_lockouts(locked_agent_id, status, artifact_path);

CREATE TABLE IF NOT EXISTS team_mailbox_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  from_actor TEXT NOT NULL,
  to_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  artifact_paths_json TEXT NOT NULL DEFAULT '[]',
  dedupe_key TEXT UNIQUE,
  created_at TEXT NOT NULL,
  acknowledged_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_team_mailbox_messages_inbox
  ON team_mailbox_messages(to_agent_id, acknowledged_at, created_at);
CREATE INDEX IF NOT EXISTS idx_team_mailbox_messages_thread
  ON team_mailbox_messages(thread_id, created_at);

CREATE TABLE IF NOT EXISTS adapter_lane_health (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  adapter_type TEXT NOT NULL,
  lane_key TEXT NOT NULL,
  lane_label TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  cooldown_until TEXT,
  last_error TEXT,
  last_success_at TEXT,
  last_checked_at TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(company_id, adapter_type, lane_key)
);

CREATE TABLE IF NOT EXISTS runtime_leases (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  holder TEXT NOT NULL,
  lease_kind TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(company_id, scope)
);

CREATE TABLE IF NOT EXISTS run_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  data_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_run_events_run_seq ON run_events(run_id, seq);

CREATE TABLE IF NOT EXISTS review_results (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  reviewer_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  outcome TEXT NOT NULL,
  summary TEXT NOT NULL,
  findings_json TEXT NOT NULL,
  severity TEXT NOT NULL,
  changed_files_json TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  required_fixes_json TEXT NOT NULL,
  suggested_repair_prompt TEXT NOT NULL,
  promotion_recommendation TEXT NOT NULL,
  inspected_diff TEXT,
  inspected_task_prompt TEXT,
  inspected_acceptance_criteria TEXT,
  inspected_verification_output TEXT,
  inspected_architecture_rules TEXT,
  repair_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  approved_by TEXT,
  approved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_review_results_run_id ON review_results(run_id);
CREATE INDEX IF NOT EXISTS idx_review_results_task_id ON review_results(task_id);

CREATE TABLE IF NOT EXISTS director_decisions (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  profile_id TEXT,
  cycle_id TEXT NOT NULL,
  pass_index INTEGER NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL,
  dry_run INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL,
  stop_reason TEXT,
  risk_score INTEGER NOT NULL,
  risk_threshold INTEGER NOT NULL,
  quota_used INTEGER NOT NULL,
  quota_limit INTEGER NOT NULL,
  loop_limit INTEGER NOT NULL,
  input_json TEXT NOT NULL,
  result_json TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_director_decisions_project_created ON director_decisions(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_director_decisions_cycle_pass ON director_decisions(cycle_id, pass_index);

CREATE TABLE IF NOT EXISTS interpreted_commands (
  id TEXT PRIMARY KEY,
  company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  utterance TEXT NOT NULL,
  intent TEXT NOT NULL,
  status TEXT NOT NULL,
  dry_run INTEGER NOT NULL DEFAULT 0,
  yes INTEGER NOT NULL DEFAULT 0,
  structured_json TEXT NOT NULL,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_interpreted_commands_created ON interpreted_commands(created_at);
CREATE INDEX IF NOT EXISTS idx_interpreted_commands_project_created ON interpreted_commands(project_id, created_at);

CREATE TABLE IF NOT EXISTS handoffs (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_persona TEXT NOT NULL,
  target_persona TEXT NOT NULL,
  source_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  target_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  artifact_path TEXT NOT NULL,
  status TEXT NOT NULL,
  artifact_json TEXT NOT NULL,
  accepted_at TEXT,
  accepted_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_handoffs_project_status ON handoffs(project_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_handoffs_source_task ON handoffs(source_task_id);
CREATE INDEX IF NOT EXISTS idx_handoffs_target_task ON handoffs(target_task_id);

CREATE TABLE IF NOT EXISTS session_states (
  session_key TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  adapter_type TEXT NOT NULL,
  session_display_id TEXT,
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_chunks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  layer TEXT NOT NULL DEFAULT 'run_summaries',
  source_kind TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  source_path TEXT,
  audience TEXT NOT NULL,
  lifecycle_status TEXT NOT NULL DEFAULT 'ready',
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  freshness_score REAL,
  expires_at TEXT,
  compacted_at TEXT,
  superseded_by_chunk_id TEXT REFERENCES memory_chunks(id) ON DELETE SET NULL,
  provenance_json TEXT NOT NULL DEFAULT '{"sources":[],"freshness":{"recordedAt":"","score":null}}',
  retention_json TEXT NOT NULL DEFAULT '{"preserveDecisionTrace":true,"preserveRaw":true,"pinned":false,"importance":"normal"}',
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, source_kind, source_ref)
);

CREATE TABLE IF NOT EXISTS memory_embeddings (
  id TEXT PRIMARY KEY,
  chunk_id TEXT NOT NULL REFERENCES memory_chunks(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  vector_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(chunk_id, provider, model)
);

CREATE TABLE IF NOT EXISTS budget_windows (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  period_kind TEXT NOT NULL,
  period_key TEXT NOT NULL,
  usage_units INTEGER NOT NULL DEFAULT 0,
  run_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  UNIQUE(agent_id, period_kind, period_key)
);

CREATE TABLE IF NOT EXISTS approval_requests (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS task_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  data_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_events_task_created ON task_events(task_id, created_at);

CREATE TABLE IF NOT EXISTS job_specs (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL,
  source_path TEXT NOT NULL,
  cron TEXT NOT NULL,
  timezone TEXT NOT NULL,
  entry_agent TEXT,
  last_triggered_at TEXT,
  last_result TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, job_id)
);

CREATE TABLE IF NOT EXISTS job_runs (
  id TEXT PRIMARY KEY,
  job_spec_id TEXT NOT NULL REFERENCES job_specs(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  triggered_at TEXT NOT NULL,
  completed_at TEXT,
  result_summary TEXT,
  data_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS routing_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  priority INTEGER NOT NULL,
  target_adapter_type TEXT NOT NULL,
  match_type TEXT NOT NULL,
  patterns_json TEXT NOT NULL,
  is_fallback INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS promotions (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  workflow_id TEXT REFERENCES workflows(id) ON DELETE SET NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  branch_name TEXT NOT NULL,
  pr_number INTEGER,
  pr_url TEXT,
  head_sha TEXT,
  base_branch TEXT NOT NULL DEFAULT 'main',
  promotion_status TEXT NOT NULL,
  merge_method TEXT NOT NULL DEFAULT 'squash',
  last_review_sync_at TEXT,
  last_checks_sync_at TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  merged_at TEXT
);

CREATE TABLE IF NOT EXISTS releases (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  milestone_id TEXT REFERENCES milestones(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  version TEXT,
  status TEXT NOT NULL DEFAULT 'planned',
  released_at TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, name)
);

CREATE TABLE IF NOT EXISTS automations (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  cron TEXT NOT NULL,
  next_run_at TEXT,
  payload_json TEXT NOT NULL,
  last_run_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(company_id, name)
);

CREATE TABLE IF NOT EXISTS planner_runs (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  automation_id TEXT REFERENCES automations(id) ON DELETE SET NULL,
  trigger_kind TEXT NOT NULL,
  status TEXT NOT NULL,
  planner_persona_id TEXT REFERENCES personas(id) ON DELETE SET NULL,
  planner_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  adapter_type TEXT,
  snapshot_json TEXT,
  output_json TEXT,
  summary_json TEXT,
  error_text TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS planner_events (
  id TEXT PRIMARY KEY,
  planner_run_id TEXT NOT NULL REFERENCES planner_runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  data_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_planner_events_run_seq ON planner_events(planner_run_id, seq);

CREATE TABLE IF NOT EXISTS planner_artifacts (
  id TEXT PRIMARY KEY,
  planner_run_id TEXT NOT NULL REFERENCES planner_runs(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS backlog_candidates (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  value_score INTEGER NOT NULL,
  risk_score INTEGER NOT NULL,
  effort_estimate TEXT NOT NULL,
  recommended_persona TEXT,
  suggested_adapter TEXT,
  verification_command TEXT,
  dependencies_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  source_signals_json TEXT NOT NULL,
  labels_json TEXT NOT NULL,
  changed_files_json TEXT NOT NULL,
  accepted_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  duplicate_of TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_backlog_candidates_project_status ON backlog_candidates(project_id, status);

CREATE TABLE IF NOT EXISTS task_outcomes (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  lane_id TEXT,
  stage TEXT NOT NULL,
  adapter_type TEXT,
  result TEXT NOT NULL,
  reason TEXT,
  verification_passed INTEGER,
  review_verdict TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  turns INTEGER,
  cost_cents INTEGER,
  tokens_total INTEGER,
  duration_ms INTEGER,
  reflection TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_outcomes_project ON task_outcomes(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_task_outcomes_lane ON task_outcomes(project_id, lane_id);

CREATE TABLE IF NOT EXISTS prompt_variants (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  label TEXT NOT NULL,
  prompt_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'candidate',
  trials INTEGER NOT NULL DEFAULT 0,
  successes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, scope, prompt_hash)
);
`
