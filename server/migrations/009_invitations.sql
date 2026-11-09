-- Une invitation ne rattache plus personne : le titulaire de l'adresse doit l'accepter.
CREATE TABLE org_invitations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  profile_id TEXT NOT NULL REFERENCES access_profiles(id) ON DELETE CASCADE,
  invited_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_account BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  decided_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX org_invitations_pending ON org_invitations (org_id, email) WHERE status = 'pending';
CREATE INDEX org_invitations_email ON org_invitations (email) WHERE status = 'pending';
ALTER TABLE org_invitations ENABLE ROW LEVEL SECURITY;

ALTER TABLE auth_tokens ADD COLUMN invitation_id TEXT REFERENCES org_invitations(id) ON DELETE CASCADE;

-- Les comptes déjà invités quittent les organisations jusqu'à leur activation ; leurs anciens liens sont annulés.
INSERT INTO org_invitations (id, org_id, email, name, profile_id, created_account, expires_at)
  SELECT 'inv_' || u.id || '_' || om.org_id, om.org_id, lower(u.email), u.name, om.profile_id, TRUE, now() + interval '72 hours'
  FROM org_members om JOIN users u ON u.id = om.user_id
  WHERE u.status = 'invited' AND u.email IS NOT NULL AND om.profile_id IS NOT NULL;
DELETE FROM org_members om USING users u WHERE u.id = om.user_id AND u.status = 'invited';
UPDATE auth_tokens SET used_at = now() WHERE kind = 'invite' AND used_at IS NULL;

-- Nouveau droit : les profils système qui permettaient de rejoindre une équipe le conservent.
UPDATE access_profiles SET permissions = permissions || '["teams.join"]'::jsonb
  WHERE is_system AND base_role <> 'guest' AND NOT permissions ? 'teams.join';
