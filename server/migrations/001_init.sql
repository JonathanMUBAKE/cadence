-- Cadence · schéma initial PostgreSQL (Supabase en production, PGlite en test)

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE,
  title TEXT,
  avatar_color TEXT NOT NULL DEFAULT '#6E56CF',
  is_ai BOOLEAN NOT NULL DEFAULT FALSE,
  ai_role TEXT,
  ai_instructions TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Organisations (locataires) ----------------------------------------------------
CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  domains JSONB NOT NULL DEFAULT '[]',
  settings JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Entités : hiérarchie libre (entreprise, filiale, direction, département, service, site…)
CREATE TABLE org_units (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES org_units(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'Service',
  manager_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  position DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_units_org ON org_units(org_id);
CREATE INDEX idx_units_parent ON org_units(parent_id);

CREATE TABLE org_members (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','member','guest')),
  unit_id TEXT REFERENCES org_units(id) ON DELETE SET NULL,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX idx_org_members_user ON org_members(user_id);

-- Équipes ---------------------------------------------------------------------
CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  unit_id TEXT REFERENCES org_units(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','request','private')),
  color TEXT NOT NULL DEFAULT '#6E56CF',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_teams_org ON teams(org_id);

CREATE TABLE team_members (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('lead','member')),
  PRIMARY KEY (team_id, user_id)
);

CREATE TABLE team_requests (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Projets -----------------------------------------------------------------------
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
  key TEXT NOT NULL,
  task_seq INTEGER NOT NULL DEFAULT 0,
  access TEXT NOT NULL DEFAULT 'team' CHECK (access IN ('team','private')),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '#6E56CF',
  icon TEXT NOT NULL DEFAULT 'rocket',
  status TEXT NOT NULL DEFAULT 'on_track' CHECK (status IN ('on_track','at_risk','off_track','done')),
  due_on DATE,
  owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, key)
);
CREATE INDEX idx_projects_team ON projects(team_id);

CREATE TABLE memberships (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('viewer','commenter','editor','admin')),
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE sections (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position DOUBLE PRECISION NOT NULL
);
CREATE INDEX idx_sections_project ON sections(project_id);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  number INTEGER NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  section_id TEXT REFERENCES sections(id) ON DELETE SET NULL,
  parent_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  creator_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  priority TEXT NOT NULL DEFAULT 'none' CHECK (priority IN ('none','low','medium','high','urgent')),
  start_on DATE,
  due_on DATE,
  completed BOOLEAN NOT NULL DEFAULT FALSE,
  completed_at TIMESTAMPTZ,
  position DOUBLE PRECISION NOT NULL,
  tags JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, number)
);
CREATE INDEX idx_tasks_project ON tasks(project_id);
CREATE INDEX idx_tasks_assignee ON tasks(assignee_id);
CREATE INDEX idx_tasks_parent ON tasks(parent_id);

CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  ai_run_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  edited_at TIMESTAMPTZ
);
CREATE INDEX idx_comments_task ON comments(task_id);

CREATE TABLE activity (
  id TEXT PRIMARY KEY,
  org_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  project_id TEXT,
  task_id TEXT,
  actor_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  data JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_activity_task ON activity(task_id);
CREATE INDEX idx_activity_project ON activity(project_id);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  org_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  task_id TEXT,
  project_id TEXT,
  approval_id TEXT,
  actor_id TEXT,
  read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_notif_user ON notifications(user_id, read);

-- IA ------------------------------------------------------------------------------
CREATE TABLE ai_runs (
  id TEXT PRIMARY KEY,
  org_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  task_id TEXT,
  project_id TEXT,
  requested_by TEXT,
  rule_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued','running','waiting_approval','done','failed','cancelled')),
  summary TEXT,
  error TEXT,
  provider TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX idx_runs_task ON ai_runs(task_id);

CREATE TABLE ai_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES ai_runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  tool TEXT,
  input JSONB,
  output TEXT,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_steps_run ON ai_steps(run_id, seq);

CREATE TABLE ai_approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES ai_runs(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  task_id TEXT,
  project_id TEXT,
  tool TEXT NOT NULL,
  input JSONB NOT NULL,
  summary TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','expired')),
  decided_by TEXT,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ai_memories (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  object_type TEXT NOT NULL CHECK (object_type IN ('project','task')),
  object_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ai_rules (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('task_created','task_moved','task_overdue')),
  section_id TEXT,
  agent_id TEXT NOT NULL REFERENCES users(id),
  instructions TEXT NOT NULL,
  auto_approve BOOLEAN NOT NULL DEFAULT FALSE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
