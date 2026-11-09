-- Une pièce jointe peut appartenir à un commentaire : elle disparaît avec lui
ALTER TABLE attachments ADD COLUMN comment_id TEXT REFERENCES comments(id) ON DELETE CASCADE;
CREATE INDEX idx_attachments_comment ON attachments(comment_id);
