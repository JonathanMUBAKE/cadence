-- La base garantit elle-même qu'un objet ne référence jamais un objet d'une autre organisation.
-- L'organisation de chaque ligne vient toujours de son parent : la valeur fournie par l'appelant est ignorée.

CREATE FUNCTION org_from_project() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN SELECT org_id INTO NEW.org_id FROM projects WHERE id = NEW.project_id; RETURN NEW; END $$;
CREATE FUNCTION org_from_task() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN SELECT org_id INTO NEW.org_id FROM tasks WHERE id = NEW.task_id; RETURN NEW; END $$;
CREATE FUNCTION org_from_team() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN SELECT org_id INTO NEW.org_id FROM teams WHERE id = NEW.team_id; RETURN NEW; END $$;
CREATE FUNCTION org_from_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN SELECT org_id INTO NEW.org_id FROM ai_runs WHERE id = NEW.run_id; RETURN NEW; END $$;

ALTER TABLE sections ADD COLUMN org_id TEXT;
ALTER TABLE tasks ADD COLUMN org_id TEXT;
ALTER TABLE memberships ADD COLUMN org_id TEXT;
ALTER TABLE ai_rules ADD COLUMN org_id TEXT;
ALTER TABLE ai_memories ADD COLUMN org_id TEXT;
ALTER TABLE comments ADD COLUMN org_id TEXT;
ALTER TABLE attachments ADD COLUMN org_id TEXT;
ALTER TABLE team_members ADD COLUMN org_id TEXT;
ALTER TABLE team_requests ADD COLUMN org_id TEXT;
ALTER TABLE ai_steps ADD COLUMN org_id TEXT;
ALTER TABLE ai_approvals ADD COLUMN org_id TEXT;

UPDATE sections x SET org_id = p.org_id FROM projects p WHERE p.id = x.project_id;
UPDATE tasks x SET org_id = p.org_id FROM projects p WHERE p.id = x.project_id;
UPDATE memberships x SET org_id = p.org_id FROM projects p WHERE p.id = x.project_id;
UPDATE ai_rules x SET org_id = p.org_id FROM projects p WHERE p.id = x.project_id;
UPDATE ai_memories x SET org_id = p.org_id FROM projects p WHERE p.id = x.project_id;
UPDATE comments x SET org_id = t.org_id FROM tasks t WHERE t.id = x.task_id;
UPDATE attachments x SET org_id = t.org_id FROM tasks t WHERE t.id = x.task_id;
UPDATE team_members x SET org_id = t.org_id FROM teams t WHERE t.id = x.team_id;
UPDATE team_requests x SET org_id = t.org_id FROM teams t WHERE t.id = x.team_id;
UPDATE ai_steps x SET org_id = r.org_id FROM ai_runs r WHERE r.id = x.run_id;
UPDATE ai_approvals x SET org_id = r.org_id FROM ai_runs r WHERE r.id = x.run_id;

ALTER TABLE sections ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE tasks ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE memberships ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE ai_rules ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE comments ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE attachments ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE team_members ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE team_requests ALTER COLUMN org_id SET NOT NULL;

CREATE TRIGGER sections_org BEFORE INSERT OR UPDATE OF project_id, org_id ON sections FOR EACH ROW EXECUTE FUNCTION org_from_project();
CREATE TRIGGER tasks_org BEFORE INSERT OR UPDATE OF project_id, org_id ON tasks FOR EACH ROW EXECUTE FUNCTION org_from_project();
CREATE TRIGGER memberships_org BEFORE INSERT OR UPDATE OF project_id, org_id ON memberships FOR EACH ROW EXECUTE FUNCTION org_from_project();
CREATE TRIGGER ai_rules_org BEFORE INSERT OR UPDATE OF project_id, org_id ON ai_rules FOR EACH ROW EXECUTE FUNCTION org_from_project();
CREATE TRIGGER ai_memories_org BEFORE INSERT OR UPDATE OF project_id, org_id ON ai_memories FOR EACH ROW EXECUTE FUNCTION org_from_project();
CREATE TRIGGER comments_org BEFORE INSERT OR UPDATE OF task_id, org_id ON comments FOR EACH ROW EXECUTE FUNCTION org_from_task();
CREATE TRIGGER attachments_org BEFORE INSERT OR UPDATE OF task_id, org_id ON attachments FOR EACH ROW EXECUTE FUNCTION org_from_task();
CREATE TRIGGER team_members_org BEFORE INSERT OR UPDATE OF team_id, org_id ON team_members FOR EACH ROW EXECUTE FUNCTION org_from_team();
CREATE TRIGGER team_requests_org BEFORE INSERT OR UPDATE OF team_id, org_id ON team_requests FOR EACH ROW EXECUTE FUNCTION org_from_team();
CREATE TRIGGER ai_steps_org BEFORE INSERT OR UPDATE OF run_id, org_id ON ai_steps FOR EACH ROW EXECUTE FUNCTION org_from_run();
CREATE TRIGGER ai_approvals_org BEFORE INSERT OR UPDATE OF run_id, org_id ON ai_approvals FOR EACH ROW EXECUTE FUNCTION org_from_run();

-- Quand un projet change d'organisation (cas impossible aujourd'hui), rien ne doit diverger : l'identifiant composite l'interdit.
ALTER TABLE projects ADD CONSTRAINT projects_org_id_uq UNIQUE (org_id, id);
ALTER TABLE teams ADD CONSTRAINT teams_org_id_uq UNIQUE (org_id, id);
ALTER TABLE org_units ADD CONSTRAINT org_units_org_id_uq UNIQUE (org_id, id);
ALTER TABLE access_profiles ADD CONSTRAINT access_profiles_org_id_uq UNIQUE (org_id, id);
ALTER TABLE ai_runs ADD CONSTRAINT ai_runs_org_id_uq UNIQUE (org_id, id);
ALTER TABLE sections ADD CONSTRAINT sections_org_id_uq UNIQUE (org_id, id);
ALTER TABLE tasks ADD CONSTRAINT tasks_org_id_uq UNIQUE (org_id, id);

ALTER TABLE projects ADD CONSTRAINT projects_team_org_fk FOREIGN KEY (org_id, team_id) REFERENCES teams (org_id, id);
ALTER TABLE teams ADD CONSTRAINT teams_unit_org_fk FOREIGN KEY (org_id, unit_id) REFERENCES org_units (org_id, id);
ALTER TABLE org_units ADD CONSTRAINT org_units_parent_org_fk FOREIGN KEY (org_id, parent_id) REFERENCES org_units (org_id, id);
ALTER TABLE org_members ADD CONSTRAINT org_members_unit_org_fk FOREIGN KEY (org_id, unit_id) REFERENCES org_units (org_id, id);
ALTER TABLE org_members ADD CONSTRAINT org_members_profile_org_fk FOREIGN KEY (org_id, profile_id) REFERENCES access_profiles (org_id, id);
ALTER TABLE sections ADD CONSTRAINT sections_project_org_fk FOREIGN KEY (org_id, project_id) REFERENCES projects (org_id, id);
ALTER TABLE tasks ADD CONSTRAINT tasks_project_org_fk FOREIGN KEY (org_id, project_id) REFERENCES projects (org_id, id);
ALTER TABLE tasks ADD CONSTRAINT tasks_section_org_fk FOREIGN KEY (org_id, section_id) REFERENCES sections (org_id, id);
ALTER TABLE tasks ADD CONSTRAINT tasks_parent_org_fk FOREIGN KEY (org_id, parent_id) REFERENCES tasks (org_id, id);
ALTER TABLE memberships ADD CONSTRAINT memberships_project_org_fk FOREIGN KEY (org_id, project_id) REFERENCES projects (org_id, id);
ALTER TABLE ai_rules ADD CONSTRAINT ai_rules_project_org_fk FOREIGN KEY (org_id, project_id) REFERENCES projects (org_id, id);
ALTER TABLE ai_memories ADD CONSTRAINT ai_memories_project_org_fk FOREIGN KEY (org_id, project_id) REFERENCES projects (org_id, id);
ALTER TABLE comments ADD CONSTRAINT comments_task_org_fk FOREIGN KEY (org_id, task_id) REFERENCES tasks (org_id, id);
ALTER TABLE attachments ADD CONSTRAINT attachments_task_org_fk FOREIGN KEY (org_id, task_id) REFERENCES tasks (org_id, id);
ALTER TABLE team_members ADD CONSTRAINT team_members_team_org_fk FOREIGN KEY (org_id, team_id) REFERENCES teams (org_id, id);
ALTER TABLE team_requests ADD CONSTRAINT team_requests_team_org_fk FOREIGN KEY (org_id, team_id) REFERENCES teams (org_id, id);
ALTER TABLE ai_steps ADD CONSTRAINT ai_steps_run_org_fk FOREIGN KEY (org_id, run_id) REFERENCES ai_runs (org_id, id);
ALTER TABLE ai_approvals ADD CONSTRAINT ai_approvals_run_org_fk FOREIGN KEY (org_id, run_id) REFERENCES ai_runs (org_id, id);
