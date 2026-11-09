# P1 · Administration, audit et sécurité : plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** donner à Cadence le niveau d'administration et de sécurité d'Asana Enterprise+, plus la conservation légale, le DLP natif et la liste d'adresses IP autorisées, avec une console d'administration complète.

**Architecture :**
- La nouvelle table `organizations` porte les réglages de sécurité, dans un JSON validé par zod.
- Toute la logique d'administration passe par des services dédiés, situés dans `server/src/admin/`. Chacun vérifie un rôle d'organisation.
- Un abonné au bus écrit chaque événement métier dans un journal d'audit en chaîne de hachage SHA-256.
- Les secrets (TOTP, jetons) sont chiffrés par enveloppe, via un `KeyProvider` interchangeable.
- La connexion de démo est remplacée par de vraies sessions serveur. Elle reste disponible seulement si l'organisation est en `demo_mode`.

**Tech Stack :** Node 22 (`node:crypto`, `node:sqlite`), Fastify 5, zod 4, `openid-client` (OIDC), `@node-saml/node-saml` (SAML), React 19.

**Spec :** `docs/specs/2026-11-09-parite-asana.md` (§2.5, §3, §5)

## Global Constraints

- Mots de passe hachés avec `crypto.scrypt` : N=2^15, r=8, p=1, sel de 16 octets, format `scrypt$N$r$p$sel$hash` (base64url).
- TOTP selon la RFC 6238 : SHA-1, 6 chiffres, pas de 30 s, tolérance ±1 pas, secret de 20 octets encodé en base32.
- Chiffrement des secrets en AES-256-GCM, nonce de 12 octets. Format stocké : `v1:<kid>:<dek_chiffrée_b64>:<nonce_b64>:<texte_chiffré_b64>:<tag_b64>`.
- Hachage d'audit : `sha256(prev_hash + JSON canonique de l'événement sans hash)`. Le premier événement a pour `prev_hash` `"0".repeat(64)`.
- Valeurs par défaut de l'organisation :
  - session inactive : 12 h ; session absolue : 30 jours ;
  - mot de passe d'au moins 12 caractères ;
  - verrouillage après 10 échecs en 15 minutes ;
  - rétention d'audit de 365 jours ;
  - `demo_mode` : `true` sur une base de démonstration, `false` sinon.
- Aucun secret (mot de passe, secret TOTP, jeton, clé) dans les réponses d'API, les journaux Fastify ou les détails d'audit. Les détails d'audit passent par `redact()`.
- Rôles d'organisation, du plus fort au plus faible : `owner` > `super_admin` > `admin` > `member` > `guest`. Plus `billing` (accès facturation seulement), qui ne s'ordonne pas avec les autres.
- Interface en français. Chaque écran d'administration est utilisable à 390 px de large, en thème clair et sombre.

## Review Focus

1. **Proxy inverse** : derrière un proxy, l'IP du client vient de `X-Forwarded-For` seulement si `trust_proxy` est activé. Sinon, la liste d'IP pourrait être contournée en forgeant l'en-tête. Test dans la tâche 8.
2. **Dernier administrateur** : rétrograder, désactiver ou supprimer le dernier `owner` doit être refusé, sinon l'organisation n'a plus d'administrateur. Test dans la tâche 1.
3. **Changement de mot de passe et de 2FA** : ils doivent révoquer les autres sessions de l'utilisateur. Une personne qui se fait voler sa session s'attend à pouvoir la couper. Test dans la tâche 6.
4. **Rétention contre conservation légale** : une purge de rétention ne doit jamais supprimer un élément sous conservation légale, même si la conservation a été posée après la création de la règle de rétention. Test dans la tâche 14.
5. **Clé maîtresse révoquée (EKM)** : les lectures de secrets échouent proprement (erreur 423 avec un message clair) au lieu de planter le serveur. Le reste de l'application continue de fonctionner. Test dans la tâche 4.

---

### Task 1 : Organisation, rôles d'administration et statut des membres

**Files :**
- Create : `server/src/admin/org.ts`, `server/src/admin/org.test.ts`
- Modify : `server/src/db.ts` (tables `organizations`, `org_members` ; colonnes `users.status`, `users.deactivated_at`), `server/src/seed.ts`, `server/src/services.ts` (`listUsers` exclut les désactivés par défaut)

**Interfaces :**
- Produces :
  - `type OrgRole = "owner" | "super_admin" | "admin" | "billing" | "member" | "guest"`
  - `const OrgSettings: z.ZodType<...>` : `{ demo_mode, session_idle_minutes, session_absolute_days, password_min_length, require_2fa, sso: { mode: "off" | "optional" | "required", oidc?, saml? }, ip_allowlist: string[], trust_proxy, guest_domains: string[], guest_invites: "admins" | "members" | "off", ai: { enabled, auto_approve_allowed, agents: string[] }, apps_allowed: string[], audit_retention_days, dlp: {...} }`
  - `class OrgService { settings(): OrgSettings; updateSettings(actorId, patch): OrgSettings; role(userId): OrgRole | null; requireRole(userId, min: OrgRole): void; setRole(actorId, userId, role); deactivate(actorId, userId); reactivate(actorId, userId); members(filter): MemberRow[]; exportMembersCsv(): string }`

- [ ] **Step 1 : écrire les tests qui échouent** dans `org.test.ts` :
  - `seed crée une organisation avec Alice owner et les autres member`
  - `requireRole("u_karim", "admin") lève HttpError 403 « réservé aux administrateurs »`
  - `setRole refuse de retirer le dernier owner` : 400, message contenant « dernier propriétaire »
  - `deactivate retire l'accès : la connexion renvoie 401 et listUsers() ne contient plus le membre`
  - `updateSettings rejette session_idle_minutes = 0` : erreur zod 400
  - `exportMembersCsv` : la première ligne est `id,nom,email,role,statut,derniere_connexion`
- [ ] **Step 2 :** `npx vitest run src/admin/org.test.ts` → échoue (« OrgService is not defined »)
- [ ] **Step 3 :** implémenter `OrgService`. Une seule ligne dans `organizations` (id `org_default`), `settings` en JSON validé par `OrgSettings.parse` à chaque lecture. Chaque mutation émet `{ type: "admin.*" }` sur le bus (nouveau membre de l'union `DomainEvent`).
- [ ] **Step 4 :** relancer → tests verts ; `npm test` reste vert.
- [ ] **Step 5 :** commit `feat(admin): organisation, rôles et statut des membres`

### Task 2 : Journal d'audit en chaîne de hachage

**Files :**
- Create : `server/src/audit/log.ts`, `server/src/audit/catalog.ts`, `server/src/audit/log.test.ts`
- Modify : `server/src/db.ts` (table `audit_events`), `server/src/app.ts` (branche l'abonné), `server/src/ai/engine.ts` (événements `ai.*`)

**Interfaces :**
- Consumes : `Bus`, `OrgService.settings()`
- Produces :
  - `interface AuditEvent { gid, created_at, event_type, event_category, actor: { actor_type: "user" | "ai" | "service_account" | "connector" | "system", gid, name, email? }, resource: { resource_type, gid, name? }, context: { context_type: "web" | "api" | "scim" | "connector" | "system", client_ip?, user_agent?, session_gid? }, details, prev_hash, hash }`
  - `class AuditLog { record(e: Omit<AuditEvent, "gid" | "created_at" | "prev_hash" | "hash">): AuditEvent; query(f: AuditQuery): { data: AuditEvent[]; next_offset: string | null }; verify(): { ok: true } | { ok: false; broken_at: string }; purge(now: Date): number }`
  - `function redact(details: unknown): unknown` : remplace les clés `password`, `secret`, `token`, `code`, `key`, `authorization` par `"[masqué]"`
  - `catalog.ts` : la table `event_type` → `event_category`. Les noms sont alignés sur Asana : `user_login_succeeded`, `user_login_failed`, `user_logged_out`, `user_session_revoked`, `user_role_changed`, `user_deactivated`, `user_reactivated`, `user_invited`, `user_2fa_enabled`, `user_2fa_disabled`, `user_password_changed`, `task_created`, `task_deleted`, `task_changed`, `project_created`, `project_member_added`, `project_member_removed`, `project_member_role_changed`, `org_settings_changed`, `sso_settings_changed`, `ai_run_started`, `ai_action_approved`, `ai_action_rejected`, `dlp_incident_created`, `data_export_requested`, `legal_hold_changed`, `encryption_key_rotated`, `encryption_key_revoked`, `connector_connected`, `connector_disconnected`.

- [ ] **Step 1 : tests qui échouent** :
  - `record chaîne les hachages` : `e2.prev_hash === e1.hash` et `e1.prev_hash === "0".repeat(64)`
  - `verify détecte une modification` : après `UPDATE audit_events SET details='{}' WHERE gid=<e1>`, `verify()` renvoie `{ ok: false, broken_at: e1.gid }`
  - `redact masque les secrets imbriqués` : `{ a: { password: "x" } }` → `{ a: { password: "[masqué]" } }`
  - `query filtre par event_type, actor_gid et plage de dates, et pagine par next_offset` (25 événements avec `limit` 10 → 3 pages)
  - `un task.deleted sur le bus produit un événement task_deleted dont resource.name est le titre`
  - `purge supprime les événements plus vieux que audit_retention_days et enregistre audit_events_purged`
- [ ] **Step 2 :** lancer → échec
- [ ] **Step 3 :** implémenter. Le JSON canonique trie les clés récursivement. L'écriture se fait dans une transaction qui relit le dernier hachage (`ORDER BY rowid DESC LIMIT 1`). Pas d'UPDATE ni de DELETE hors de `purge`, et `purge` enregistre un événement de synthèse portant le hachage du dernier événement supprimé, pour que `verify()` reparte de là.
- [ ] **Step 4 :** tests verts
- [ ] **Step 5 :** commit `feat(audit): journal d'audit chaîné`

### Task 3 : API d'audit, exports et diffusion vers un SIEM

**Files :**
- Create : `server/src/audit/routes.ts`, `server/src/audit/siem.ts`, `server/src/audit/routes.test.ts`
- Modify : `server/src/app.ts`

**Interfaces :**
- Consumes : `AuditLog`, `OrgService.requireRole`
- Produces :
  - `GET /api/admin/audit-events?start_at&end_at&event_type&actor_type&actor_gid&resource_gid&limit&offset` → `{ data, next_page: { offset } | null }` (forme de l'API Asana)
  - `GET /api/admin/audit-events/export?format=csv|jsonl&...` → flux téléchargeable
  - `GET /api/admin/audit-events/verify` → résultat de `verify()`
  - `class SiemSink { constructor(cfg: { url, secret, format: "json" | "cef" }); push(e: AuditEvent): Promise<void> }` : signature `X-Cadence-Signature: sha256=<hmac>`, 5 tentatives avec attente exponentielle via la file de la tâche 2 de P2 (en attendant, un `setTimeout` borné)

- [ ] **Step 1 : tests qui échouent** :
  - `un membre reçoit 403 sur /api/admin/audit-events`
  - `un admin filtre event_type=user_login_failed et ne reçoit que ceux-là`
  - `l'export CSV a l'en-tête gid,created_at,event_type,actor_type,actor_name,resource_type,resource_name,client_ip`
  - `SiemSink signe le corps` : un serveur HTTP local recalcule le HMAC et trouve la même valeur
  - `la consultation de l'export est elle-même auditée (audit_log_exported)`
- [ ] **Step 2 → Step 5 :** échec, implémentation, tests verts, commit `feat(audit): API, export et SIEM`

### Task 4 : Chiffrement par enveloppe et clés gérées par le client (EKM)

**Files :**
- Create : `server/src/crypto/keys.ts`, `server/src/crypto/envelope.ts`, `server/src/crypto/envelope.test.ts`
- Modify : `server/src/db.ts` (table `encryption_keys` : `kid`, `provider`, `status: active | retired | revoked`, `created_at`)

**Interfaces :**
- Produces :
  - `interface KeyProvider { id: string; wrap(dek: Buffer, kid: string): Promise<Buffer>; unwrap(wrapped: Buffer, kid: string): Promise<Buffer> }`
  - `class LocalKeyProvider implements KeyProvider` : clé maîtresse `CADENCE_MASTER_KEY` (32 octets, base64). Elle est générée et écrite dans `server/.master-key` (droits 0600) seulement en `demo_mode`.
  - `class VaultTransitProvider`, `class AwsKmsProvider` : interface seulement, avec un test qui utilise un faux serveur HTTP pour Vault Transit
  - `class Envelope { seal(plain: string): Promise<string>; open(sealed: string): Promise<string>; rotate(): Promise<{ kid; resealed: number }>; revoke(kid): Promise<void> }`
  - `class KeyRevokedError extends HttpError(423, "Clé de chiffrement révoquée par l'administrateur")`

- [ ] **Step 1 : tests qui échouent** :
  - `seal puis open restitue le texte`, et deux `seal` du même texte donnent deux chaînes différentes
  - `open d'un texte altéré lève une erreur` (tag GCM)
  - `rotate re-scelle toutes les colonnes chiffrées déclarées dans SEALED_COLUMNS avec le nouveau kid`
  - `revoke : open lève KeyRevokedError (423) et GET /api/me répond toujours 200`
  - `VaultTransitProvider appelle POST /v1/transit/encrypt/<clé> avec un plaintext base64`
- [ ] **Step 2 → Step 5 :** échec, implémentation, tests verts, commit `feat(crypto): chiffrement par enveloppe et EKM`

### Task 5 : Comptes et mots de passe

**Files :**
- Create : `server/src/auth/password.ts`, `server/src/auth/password.test.ts`
- Modify : `server/src/db.ts` (`users.password_hash`, `users.failed_logins`, `users.locked_until`), `server/src/seed.ts` (mot de passe de démo `cadence-demo-2026` seulement si `demo_mode`)

**Interfaces :**
- Produces : `hashPassword(p): Promise<string>`, `verifyPassword(p, stored): Promise<boolean>` (comparaison `timingSafeEqual`), `checkPolicy(p, settings): string[]` (messages en français : longueur, présence d'une lettre et d'un chiffre, différent de l'e-mail), `class LoginGuard { attempt(email, ip): void; fail(email, ip): void; succeed(email): void }`

- [ ] **Step 1 : tests qui échouent** :
  - `hashPassword produit le format scrypt$32768$8$1$…` et `verifyPassword` est vrai pour le bon mot de passe, faux sinon
  - `checkPolicy("court", { password_min_length: 12 })` contient « au moins 12 caractères »
  - `après 10 échecs en 15 min, attempt lève 429 « Trop de tentatives, réessayez dans 15 minutes »` et un événement `user_login_failed` porte `details.locked: true`
- [ ] **Step 2 → Step 5 :** commit `feat(auth): mots de passe et verrouillage`

### Task 6 : Sessions serveur

**Files :**
- Create : `server/src/auth/sessions.ts`, `server/src/auth/sessions.test.ts`
- Modify : `server/src/app.ts` (remplace le cookie `cadence_uid` ; `POST /api/auth/login { email, password, totp? }` ; `/api/auth/users` n'existe plus qu'en `demo_mode`), `web/src/pages/Login.tsx` (formulaire e-mail et mot de passe, profils de démo seulement si `demo_mode`)

**Interfaces :**
- Produces :
  - table `sessions(id, user_id, created_at, last_seen_at, expires_at, ip, user_agent, mfa, revoked_at)`
  - `class Sessions { create(userId, ctx): { id, cookie }; touch(id, now): SessionRow | null; revoke(id, by); revokeAllForUser(userId, exceptId?); list(userId) }`
  - cookie `cadence_sid` : 32 octets aléatoires, avec `httpOnly`, `secure` (sauf en local), `sameSite=lax`. La base stocke `sha256(id)`, jamais l'id brut.
  - routes `GET /api/me/sessions`, `DELETE /api/me/sessions/:id`, `DELETE /api/admin/users/:id/sessions`

- [ ] **Step 1 : tests qui échouent** :
  - `une session inactive au-delà de session_idle_minutes renvoie 401` (horloge injectée)
  - `une session plus vieille que session_absolute_days renvoie 401 même si active`
  - `changer de mot de passe révoque les autres sessions mais garde la session courante`
  - `un admin révoque toutes les sessions d'un membre : sa requête suivante renvoie 401 ; événement user_session_revoked`
  - `la table sessions ne contient jamais l'identifiant brut du cookie`
- [ ] **Step 2 → Step 5 :** commit `feat(auth): sessions serveur révocables`

### Task 7 : Double authentification TOTP

**Files :**
- Create : `server/src/auth/totp.ts`, `server/src/auth/totp.test.ts`, `web/src/pages/Security.tsx` (« Sécurité du compte »)

**Interfaces :**
- Consumes : `Envelope` (le secret est scellé), `Sessions`
- Produces : `generateSecret(): string` (base32), `totp(secret, t): string`, `verifyTotp(secret, code, now): boolean`, `otpauthUri(email, secret): string`, codes de secours (10 codes de 10 caractères, hachés, à usage unique). Routes `POST /api/me/2fa/setup`, `POST /api/me/2fa/enable { code }`, `POST /api/me/2fa/disable { password }`.

- [ ] **Step 1 : tests qui échouent** :
  - vecteur de la RFC 6238 : secret ASCII `12345678901234567890`, t=59 → `287082`
  - `un code du pas précédent est accepté, celui d'il y a deux pas est refusé`
  - `avec require_2fa, une connexion sans code renvoie 401 { mfa_required: true }`, puis avec code → 200
  - `un code de secours ne sert qu'une fois`
  - `activer la 2FA révoque les autres sessions et produit user_2fa_enabled`
- [ ] **Step 2 → Step 5 :** commit `feat(auth): double authentification TOTP`

### Task 8 : Liste d'adresses IP autorisées

**Files :**
- Create : `server/src/auth/ip.ts`, `server/src/auth/ip.test.ts`
- Modify : `server/src/app.ts` (hook `onRequest` avant l'authentification ; `trustProxy` de Fastify piloté par `settings.trust_proxy`)

**Interfaces :**
- Produces : `parseCidr(s): Cidr`, `ipInList(ip, list: string[]): boolean` (IPv4, IPv6, IPv4 mappé `::ffff:`), `clientIp(req, trustProxy): string`

- [ ] **Step 1 : tests qui échouent** :
  - `10.0.0.0/8 contient 10.2.3.4 mais pas 11.0.0.1` ; `2001:db8::/32 contient 2001:db8::1` ; `::ffff:10.0.0.1 est dans 10.0.0.0/8`
  - `avec une liste non vide, une IP hors liste reçoit 403 « Accès refusé depuis cette adresse IP »` et l'événement `user_login_failed` porte `details.reason = "ip_not_allowed"`
  - `sans trust_proxy, X-Forwarded-For est ignoré` ; avec, la première adresse est utilisée
  - `un admin ne peut pas enregistrer une liste qui exclut sa propre IP courante` (400)
- [ ] **Step 2 → Step 5 :** commit `feat(auth): liste d'adresses IP autorisées`

### Task 9 : SSO OIDC (Google, Microsoft Entra ID, Keycloak…)

**Files :**
- Create : `server/src/auth/oidc.ts`, `server/src/auth/oidc.test.ts`

**Interfaces :**
- Consumes : `OrgSettings.sso.oidc = { issuer, client_id, client_secret_sealed, allowed_domains: string[], jit: boolean, default_role: "member" | "guest" }`
- Produces : `GET /api/auth/oidc/start` (PKCE et `state` en cookie signé de 10 min), `GET /api/auth/oidc/callback`, fonction `provisionFromClaims(claims): userId`

- [ ] **Step 1 : tests qui échouent**, avec un fournisseur OIDC simulé (serveur local qui expose discovery, JWKS et token, avec un `id_token` signé RS256 par une clé générée dans le test) :
  - `le callback avec un state invalide renvoie 400`
  - `un e-mail hors allowed_domains reçoit 403`
  - `avec jit, un nouvel utilisateur est créé avec default_role et user_provisioned_jit est audité`
  - `avec sso.mode = "required", POST /api/auth/login par mot de passe renvoie 403 « Connexion par SSO obligatoire », sauf pour les owner (accès de secours)`
- [ ] **Step 2 → Step 5 :** commit `feat(sso): OIDC`

### Task 10 : SSO SAML 2.0

**Files :**
- Create : `server/src/auth/saml.ts`, `server/src/auth/saml.test.ts`

**Interfaces :**
- Produces : `GET /api/auth/saml/metadata` (XML du fournisseur de service), `GET /api/auth/saml/start`, `POST /api/auth/saml/acs`. Les attributs `email`, `firstName` et `lastName` sont configurables.

- [ ] **Step 1 : tests qui échouent**, avec des assertions signées par un certificat de test généré :
  - `une assertion valide ouvre une session`
  - `une assertion expirée ou à signature invalide renvoie 401` et produit un événement `user_login_failed` avec `reason: "saml_invalid"`
  - `les métadonnées contiennent l'entityID et l'URL ACS configurés`
- [ ] **Step 2 → Step 5 :** commit `feat(sso): SAML 2.0`

### Task 11 : Provisionnement SCIM 2.0

**Files :**
- Create : `server/src/scim/routes.ts`, `server/src/scim/routes.test.ts`
- Modify : `server/src/db.ts` (`groups`, `group_members`, `users.external_id`)

**Interfaces :**
- Produces : `/scim/v2/Users` (GET avec `filter=userName eq "…"` et `startIndex`/`count`, POST, GET /:id, PUT, PATCH, DELETE → désactivation), `/scim/v2/Groups` (CRUD, PATCH members), `/scim/v2/ServiceProviderConfig`. Authentification par jeton `Bearer` dédié, scellé et rotatif depuis la console. Les erreurs suivent le schéma SCIM `urn:ietf:params:scim:api:messages:2.0:Error`.

- [ ] **Step 1 : tests qui échouent** :
  - `POST /Users crée un membre actif ; une seconde création avec le même userName renvoie 409`
  - `PATCH active=false désactive le membre et révoque ses sessions`
  - `GET /Users?filter=userName eq "alice@cadence.app" renvoie totalResults 1`
  - `un jeton invalide renvoie 401 au format SCIM`
  - `chaque appel est audité avec context_type "scim"`
- [ ] **Step 2 → Step 5 :** commit `feat(scim): provisionnement SCIM 2.0`

### Task 12 : Invitations et invités

**Files :**
- Create : `server/src/admin/invites.ts`, `server/src/admin/invites.test.ts`
- Modify : `server/src/services.ts` (un `guest` ne voit que les projets où il est explicitement membre et ne peut ni créer de projet ni lister les membres de l'organisation)

**Interfaces :**
- Produces : `POST /api/invites { email, role, project_ids? }` → lien à usage unique (jeton de 32 octets, sha256 en base, expiration 7 jours) ; `POST /api/invites/accept { token, name, password }`

- [ ] **Step 1 : tests qui échouent** :
  - `guest_invites = "admins" : un membre reçoit 403 en invitant`
  - `une adresse hors guest_domains reçoit 400 « Domaine non autorisé pour les invités »`
  - `un invité ne voit pas les projets dont il n'est pas membre et GET /api/users ne liste que les membres de ses projets`
  - `un jeton expiré ou déjà utilisé renvoie 410`
- [ ] **Step 2 → Step 5 :** commit `feat(admin): invitations et politique des invités`

### Task 13 : DLP natif

**Files :**
- Create : `server/src/dlp/detectors.ts`, `server/src/dlp/engine.ts`, `server/src/dlp/dlp.test.ts`
- Modify : `server/src/services.ts` (`createTask`, `updateTask` sur le titre et la description, `addComment`), `server/src/db.ts` (`dlp_incidents`)

**Interfaces :**
- Produces :
  - détecteurs `credit_card` (Luhn), `iban` (contrôle modulo 97), `fr_nir` (clé de contrôle), `email`, `api_key` (motifs `sk-`, `AKIA`, `ghp_`, `xox[bp]-`), et `custom` par expression régulière
  - `scan(text): Finding[]`
  - `class DlpEngine { enforce(actorId, field, text, ctx): string }` : selon la politique, cette méthode laisse passer en journalisant (`log`), laisse passer en avertissant l'auteur (`warn`), refuse avec une erreur 422 qui nomme le type de donnée (`block`), ou masque la donnée en `•••• 4242` (`redact`)
  - incidents consultables dans la console

- [ ] **Step 1 : tests qui échouent** :
  - `4242 4242 4242 4242 est détecté, 4242 4242 4242 4241 ne l'est pas`
  - `FR76 3000 6000 0112 3456 7890 189 est un IBAN valide`
  - `politique block sur credit_card : addComment renvoie 422 « Le commentaire contient un numéro de carte bancaire »` et un incident est créé sans le numéro en clair
  - `politique redact : le commentaire enregistré contient •••• 4242`
  - `les outils de l'IA passent par le même contrôle`, vérifié via `ToolRunner.execute("add_comment")`
- [ ] **Step 2 → Step 5 :** commit `feat(dlp): détection et politiques de données sensibles`

### Task 14 : Export, rétention, conservation légale et RGPD

**Files :**
- Create : `server/src/data/export.ts`, `server/src/data/retention.ts`, `server/src/data/data.test.ts`
- Modify : `server/src/db.ts` (`legal_holds(id, scope: org | project | user, target_id, reason, created_by, created_at, released_at)`, `retention_policies`)

**Interfaces :**
- Produces :
  - `exportOrganization(): Promise<{ path }>` : archive de fichiers JSONL par table ; les secrets sont exclus
  - `exportUser(userId)` : droit d'accès RGPD
  - `eraseUser(actorId, userId)` : anonymisation (nom « Utilisateur supprimé », e-mail vidé) ; les contenus restent mais l'auteur est anonymisé ; refusée si une conservation légale s'applique
  - `applyRetention(now): { deleted }`
  - `isOnHold(kind, id): boolean`

- [ ] **Step 1 : tests qui échouent** :
  - `applyRetention ne supprime pas les tâches d'un projet sous conservation légale posée après la politique`
  - `eraseUser sous conservation légale renvoie 409 « Données sous conservation légale »`
  - `l'export d'organisation ne contient aucune valeur password_hash, secret ou token`
  - `chaque export produit data_export_requested`
- [ ] **Step 2 → Step 5 :** commit `feat(data): export, rétention, conservation légale, RGPD`

### Task 15 : Gouvernance de l'IA et applications autorisées

**Files :**
- Modify : `server/src/ai/engine.ts`, `server/src/app.ts`
- Test : `server/src/admin/governance.test.ts`

**Interfaces :**
- Consumes : `settings.ai`, `settings.apps_allowed`
- Produces : `assertAiAllowed(agentId)`. Une règle qui demande à agir sans validation est refusée si `auto_approve_allowed` est faux. `assertAppAllowed(connectorId)` sert au plan P2.

- [ ] **Step 1 : tests qui échouent** :
  - `ai.enabled = false : POST /api/ai/chat renvoie 403 « L'IA est désactivée par votre administrateur »`
  - `un agent absent de ai.agents ne démarre pas sur assignation`, et `ai_run_blocked` est audité
  - `auto_approve_allowed = false : enregistrer une règle avec auto_approve renvoie 400`
- [ ] **Step 2 → Step 5 :** commit `feat(admin): gouvernance de l'IA`

### Task 16 : Annonces d'administration

**Files :**
- Create : `server/src/admin/announcements.ts`, test associé, `web/src/components/AnnouncementBanner.tsx`

**Interfaces :**
- Produces : `announcements(id, title, body, level: info | warning | critical, starts_at, ends_at, dismissible)` ; `GET /api/announcements/active` ; un utilisateur peut masquer une annonce pour lui-même

- [ ] **Step 1 :** tests : `une annonce hors de sa période n'est pas renvoyée` ; `une annonce masquée par un utilisateur reste visible pour les autres`
- [ ] **Step 2 → Step 5 :** commit `feat(admin): annonces`

### Task 17 : Console d'administration (interface)

**Files :**
- Create : `web/src/pages/admin/AdminLayout.tsx` et une page par section :
  - `Overview.tsx` : nombre de membres, invités, invitations et sessions actives ; incidents DLP sur 7 jours ; état de la chaîne d'audit
  - `Members.tsx` : recherche, rôle, désactivation, révocation des sessions, export CSV
  - `Security.tsx` : méthodes de connexion, SSO, 2FA, durées de session, mot de passe, liste d'IP
  - `Audit.tsx` : filtres, détail d'un événement, export, vérification de la chaîne
  - `Data.tsx` : export, rétention, conservations légales, RGPD
  - `Encryption.tsx` : clés, rotation, révocation avec confirmation renforcée
  - `Ai.tsx` : gouvernance
  - `Apps.tsx` : applications autorisées
  - `Announcements.tsx`
- Modify : `web/src/main.tsx` (routes `/admin/*`), `web/src/components/Sidebar.tsx` (lien « Administration » pour admin et plus)
- Modify : `scripts/e2e.mjs`

**Interfaces :**
- Consumes : toutes les routes `/api/admin/*` définies plus haut

- [ ] **Step 1 :** étape e2e qui échoue : Alice ouvre Administration, filtre le journal d'audit sur `user_login_succeeded` et y voit sa propre connexion ; Karim (membre) ne voit pas le lien et reçoit « Accès réservé aux administrateurs » sur `/admin`
- [ ] **Step 2 :** `npm run e2e` → échec
- [ ] **Step 3 :** implémenter les pages. Toute action destructrice (désactiver, révoquer une clé, poser ou lever une conservation légale) passe par une boîte de confirmation. Pour révoquer une clé, il faut retaper le nom de l'organisation.
- [ ] **Step 4 :** `npm run e2e` vert, et captures relues à 390 px et à 1440 px, en thème clair et sombre
- [ ] **Step 5 :** commit `feat(admin): console d'administration`

### Task 18 : Durcissement HTTP

**Files :**
- Create : `server/src/http/hardening.ts`, test associé
- Modify : `server/src/app.ts`

**Interfaces :**
- Produces :
  - en-têtes `Content-Security-Policy` (sources : soi-même et Google Fonts), `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `Strict-Transport-Security` (hors local), `Permissions-Policy` ;
  - contrôle CSRF : en-tête `Origin` ou `Sec-Fetch-Site` obligatoire sur les méthodes non sûres ;
  - limite de débit par IP et par session sur `/api/auth/*` (10/min) et sur l'API (600/min) ;
  - taille des corps limitée à 1 Mo, sauf pour les envois de fichiers (P2).

- [ ] **Step 1 :** tests : `un POST avec une Origin étrangère renvoie 403` ; `11 tentatives de connexion en une minute → 429` ; `la réponse HTML porte la CSP`
- [ ] **Step 2 → Step 5 :** commit `feat(http): en-têtes de sécurité, CSRF, limites de débit`

---

**Ordre et dépendances :**
- La tâche 1 précède tout le reste.
- La tâche 2 précède la tâche 3 et toutes celles qui auditent.
- La tâche 4 précède les tâches 7, 9 et 11, qui scellent des secrets.
- La tâche 5 précède la 6, qui précède la 7, puis les tâches 8 à 10.
- La tâche 17 vient en dernier côté interface. La tâche 18 peut se faire à tout moment après la tâche 6.
