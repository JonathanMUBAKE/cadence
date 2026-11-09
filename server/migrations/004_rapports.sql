-- Rapports rédigés par un coéquipier IA, à partir d'indicateurs calculés par le serveur
CREATE TABLE ai_reports (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('project','portfolio')),
  agent_id TEXT NOT NULL REFERENCES users(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  period_days INTEGER NOT NULL,
  focus TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('generating','ready','failed')),
  metrics JSONB NOT NULL,
  content JSONB,
  provider TEXT NOT NULL,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX idx_reports_project ON ai_reports(project_id, created_at DESC);
CREATE INDEX idx_reports_org ON ai_reports(org_id, created_by, created_at DESC);
ALTER TABLE ai_reports ENABLE ROW LEVEL SECURITY;
