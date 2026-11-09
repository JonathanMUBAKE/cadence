-- Photos de profil (stockées en base : fonctionne aussi sur Supabase sans stockage de fichiers)
CREATE TABLE avatars (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  mime TEXT NOT NULL,
  data BYTEA NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE users ADD COLUMN avatar_version INTEGER NOT NULL DEFAULT 0;

-- Adresses de service : un domaine par organisation, une adresse par niveau (organisation, entité, équipe)
CREATE TABLE service_addresses (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  local_part TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('org','unit','team')),
  target_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, local_part),
  UNIQUE (org_id, target_type, target_id)
);

-- Journal des envois d'e-mails (sans le contenu)
CREATE TABLE email_log (
  id TEXT PRIMARY KEY,
  org_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  subject TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent','failed')),
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_email_log_org ON email_log(org_id, created_at DESC);

ALTER TABLE avatars ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_addresses ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_log ENABLE ROW LEVEL SECURITY;
