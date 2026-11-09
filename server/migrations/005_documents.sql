-- Pièces jointes des tâches, stockées en base comme les photos (fonctionne aussi sur Supabase sans stockage objet)
CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  uploader_id TEXT NOT NULL REFERENCES users(id),
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  data BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_attachments_task ON attachments(task_id, created_at);
ALTER TABLE attachments ENABLE ROW LEVEL SECURITY;
