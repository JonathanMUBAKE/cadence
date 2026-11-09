-- Profil système sans aucun droit d'écriture, pour chaque organisation existante.
INSERT INTO access_profiles (id, org_id, name, description, base_role, permissions, is_system)
  SELECT 'prf_readonly_' || id, id, 'Lecture seule', 'Consulte ce qui lui est partagé, sans rien pouvoir modifier.', 'member', '[]', TRUE FROM organizations
  ON CONFLICT DO NOTHING;
