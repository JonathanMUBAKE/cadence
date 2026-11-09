-- Compteur d'échecs de la double authentification, par compte : une nouvelle connexion ne le remet pas à zéro.
ALTER TABLE users ADD COLUMN mfa_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN mfa_locked_until TIMESTAMPTZ;
