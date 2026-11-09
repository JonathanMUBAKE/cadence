# P2 · Connecteurs : plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** relier Cadence aux outils de travail de l'équipe :
- messageries : Slack, Microsoft Teams, Google Chat, Mattermost, Rocket.Chat ;
- visioconférences : Zoom, Teams, Google Meet, Webex, Jitsi, BigBlueButton ;
- stockages : Nextcloud, OneDrive / SharePoint, Google Drive, Dropbox, Box ;
- e-mail : SMTP, IMAP, Gmail, Microsoft 365 ;
- calendriers.

Ces connecteurs sont pilotables par les humains comme par les coéquipiers IA, sous contrôle de l'administrateur.

**Architecture :** chaque connecteur est une *définition déclarative* : identifiant, catégorie, méthode d'authentification, capacités. Il implémente une ou plusieurs interfaces de catégorie : `MessagingProvider`, `MeetingProvider`, `StorageProvider`, `MailProvider`, `CalendarProvider`.

Cinq briques sont communes à tous les connecteurs :
- un coffre de connexions, aux identifiants scellés par l'`Envelope` de P1 ;
- un courtier OAuth2 avec PKCE ;
- un client HTTP qui audite chaque appel ;
- une file de tâches persistante avec reprises ;
- des webhooks entrants signés.

Les événements du bus alimentent les abonnements (« publier les nouvelles tâches de ce projet dans #produit »). Les connecteurs deviennent aussi des outils d'écriture pour l'IA, donc soumis aux checkpoints.

**Tech Stack :** Node 22 (`fetch`, `node:crypto`), Fastify 5, `nodemailer` (SMTP), `imapflow` et `mailparser` (IMAP), `undici` MockAgent pour les tests, React 19.

**Spec :** `docs/specs/2026-11-09-parite-asana.md` (§2.6, §3.5, §5)

**Prérequis P1 :** tâche 2 (journal d'audit), tâche 4 (`Envelope`), tâche 15 (`assertAppAllowed`).

## Global Constraints

- Aucun appel réseau réel dans les tests : chaque API tierce est simulée (MockAgent ou serveur HTTP local) d'après des réponses copiées de sa documentation officielle.
- Identifiants et jetons de rafraîchissement toujours scellés (`Envelope.seal`). Les réponses d'API exposent seulement `{ connected, account_label, scopes, expires_at }`.
- Chaque appel sortant produit un événement d'audit `connector_api_call` : connecteur, méthode, hôte et chemin sans paramètres, statut, durée. Jamais le corps.
- File de tâches : 6 tentatives au maximum, attente de `2^n × 1 s` plafonnée à 5 min. Un `Retry-After` reçu est respecté. Le statut `dead` est visible dans la console.
- Webhooks entrants : vérification de signature obligatoire, refus au-delà de 5 min de décalage d'horodatage, idempotence par identifiant d'événement (table `webhook_receipts`, conservée 7 jours).
- Fichiers envoyés : 50 Mo maximum par fichier. Type MIME déterminé par signature, pas par l'extension. Stockage sous `DATA_DIR/attachments/<sha256>`, chiffrement optionnel par `Envelope` si `settings.encrypt_attachments`.
- Interface en français, utilisable sur mobile, en thème clair et sombre.

## Review Focus

1. **Jeton expiré pendant une tâche de fond** : le courtier rafraîchit le jeton et rejoue l'appel une fois. Si le rafraîchissement échoue (`invalid_grant`), la connexion passe à `needs_reauth`, son propriétaire est notifié et la tâche n'est pas reprise en boucle. Tests dans les tâches 3 et 2.
2. **Message de messagerie reçu deux fois** (Slack réessaie après 3 s sans réponse) : une seule tâche doit être créée. On répond en moins de 3 s et on traite en asynchrone. Test dans la tâche 7.
3. **E-mail entrant d'un expéditeur inconnu ou usurpé** : aucune tâche n'est créée si l'expéditeur n'est pas membre du projet, ou si les en-têtes `Authentication-Results` indiquent un échec DKIM ou SPF. Le rejet est journalisé. Test dans la tâche 12.
4. **Nom de fichier hostile** (`../../etc/passwd`, caractères de contrôle, noms de 300 caractères) dans un envoi ou un chemin Nextcloud : il est assaini, et un chemin hors du dossier racine est impossible. Tests dans les tâches 5 et 10.
5. **Connecteur retiré de la liste autorisée par l'administrateur** : les abonnements et tâches en cours s'arrêtent, et les appels échouent avec un 403 explicite au lieu de continuer silencieusement. Test dans la tâche 1.

---

### Task 1 : Catalogue, définitions et coffre de connexions

**Files :**
- Create : `server/src/connectors/types.ts`, `server/src/connectors/registry.ts`, `server/src/connectors/vault.ts`, `server/src/connectors/vault.test.ts`
- Modify : `server/src/db.ts` (`connections(id, connector_id, scope: org | user | project, owner_id, project_id, account_label, credentials_sealed, scopes, status: active | needs_reauth | disabled, created_at, updated_at)`)

**Interfaces :**
- Produces :
  - `type Category = "messaging" | "meeting" | "storage" | "email" | "calendar"`
  - `interface ConnectorDefinition { id; name; category: Category[]; auth: { kind: "oauth2"; authorizeUrl; tokenUrl; scopes: string[]; pkce: boolean } | { kind: "basic" | "apikey" | "webhook_url" | "none" }; capabilities: string[]; configSchema: z.ZodType }`
  - `registry.list()`, `registry.get(id)` : 18 définitions déclarées (`slack`, `msteams`, `google_chat`, `mattermost`, `rocketchat`, `zoom`, `google_meet`, `webex`, `jitsi`, `bigbluebutton`, `nextcloud`, `onedrive`, `google_drive`, `dropbox`, `box`, `smtp`, `imap`, `gmail`, `outlook_mail`, `ics`). Pour `msteams`, la messagerie et les réunions Teams relèvent du même connecteur.
  - `class ConnectionVault { create(actorId, connectorId, scope, creds, meta): Connection; credentials(id): Promise<Creds>; update(id, creds); disable(id, reason); list(filter) }`

- [ ] **Step 1 : tests qui échouent** :
  - `credentials_sealed ne contient pas le jeton en clair` (`LIKE '%xoxb-%'` → 0 ligne)
  - `GET /api/connections ne renvoie jamais credentials ni credentials_sealed`
  - `retirer slack de apps_allowed désactive les connexions slack, et credentials() lève 403 « Connecteur désactivé par l'administrateur »`
  - `le registre déclare un schéma de configuration valide pour chaque connecteur` (parse d'un exemple par définition)
- [ ] **Step 2 → Step 5 :** échec, implémentation, tests verts, commit `feat(connectors): catalogue et coffre de connexions`

### Task 2 : File de tâches persistante

**Files :**
- Create : `server/src/jobs/queue.ts`, `server/src/jobs/queue.test.ts`
- Modify : `server/src/db.ts` (`jobs(id, kind, payload, idempotency_key UNIQUE, status: queued | running | done | failed | dead, attempts, run_at, last_error, created_at)`)

**Interfaces :**
- Produces : `class JobQueue { register(kind, handler: (payload, ctx) => Promise<void>); enqueue(kind, payload, { idempotencyKey?, runAt? }): string; start(): void; stop(): Promise<void>; tick(now): Promise<number> }`. `tick` est exposé pour les tests ; `class RetryLater extends Error { constructor(public afterMs: number) }`.

- [ ] **Step 1 : tests qui échouent** :
  - `une tâche qui échoue est reprogrammée à 1 s, puis 2 s, puis 4 s, et passe dead après 6 tentatives`
  - `RetryLater(30000) reprogramme à +30 s sans compter une tentative en plus du maximum`
  - `deux enqueue avec la même idempotencyKey ne créent qu'une tâche`
  - `au redémarrage, une tâche restée running depuis plus de 10 min repasse queued`
- [ ] **Step 2 → Step 5 :** commit `feat(jobs): file de tâches persistante`

### Task 3 : Courtier OAuth2 et client HTTP audité

**Files :**
- Create : `server/src/connectors/oauth.ts`, `server/src/connectors/http.ts`, `server/src/connectors/oauth.test.ts`

**Interfaces :**
- Consumes : `ConnectionVault`, `AuditLog`
- Produces :
  - routes `GET /api/connectors/:id/oauth/start?scope=org|user|project&project_id=` (avec `state` et `code_verifier` en cookie signé de 10 min) et `GET /api/connectors/:id/oauth/callback`
  - `class ConnectorHttp { constructor(connectionId); request(method, url, { json?, form?, headers?, raw? }): Promise<{ status; json; headers }> }` : ajoute le jeton, rafraîchit sur 401 puis rejoue une seule fois, convertit les 429 en `RetryLater`, audite
  - les secrets d'application (`client_id`, `client_secret`) se configurent par connecteur dans la console. Ils sont scellés, jamais dans le dépôt.

- [ ] **Step 1 : tests qui échouent** :
  - `start redirige vers authorizeUrl avec code_challenge_method=S256 et le state`
  - `callback avec un state inconnu renvoie 400 ; avec le bon state, échange le code et crée la connexion`
  - `sur 401, refresh puis rejeu ; un second 401 lève et ne boucle pas`
  - `refresh en invalid_grant : statut needs_reauth et notification « Reconnectez Slack »`
  - `429 avec Retry-After: 12 lève RetryLater(12000)`
  - `l'événement connector_api_call ne contient ni Authorization ni la query string`
- [ ] **Step 2 → Step 5 :** commit `feat(connectors): OAuth2 et client HTTP audité`

### Task 4 : Webhooks entrants signés

**Files :**
- Create : `server/src/connectors/webhooks.ts`, `server/src/connectors/webhooks.test.ts`

**Interfaces :**
- Produces :
  - route `POST /api/hooks/:connector/:connectionId` (corps brut conservé pour la signature)
  - `interface WebhookVerifier { verify(req, rawBody, secret): { ok: boolean; eventId?: string; challenge?: string } }`
  - vérificateurs :
    - `slack` : `v0=HMAC-SHA256("v0:" + ts + ":" + body)`, horodatage à moins de 5 min ;
    - `zoom` : `x-zm-signature`, et réponse au `endpoint.url_validation` ;
    - `msgraph` : renvoi du `validationToken` et `clientState` ;
    - `mailgun` : HMAC de `timestamp + token` ;
    - `postmark` : authentification basique ;
    - `mattermost` et `rocketchat` : jeton partagé ;
    - `generic` : `X-Cadence-Signature`
  - en sortie, un `bus.emit({ type: "connector.inbound", connector, connectionId, eventId, payload })`

- [ ] **Step 1 : tests qui échouent** :
  - `une signature Slack invalide renvoie 401 ; un horodatage vieux de 6 min renvoie 401`
  - `Zoom endpoint.url_validation renvoie { plainToken, encryptedToken }`
  - `Graph : ?validationToken=abc renvoie abc en text/plain`
  - `un même eventId reçu deux fois n'émet qu'un seul connector.inbound`
- [ ] **Step 2 → Step 5 :** commit `feat(connectors): webhooks entrants signés`

### Task 5 : Pièces jointes (envois et fichiers cloud)

**Files :**
- Create : `server/src/attachments/service.ts`, `server/src/attachments/attachments.test.ts`, `web/src/components/Attachments.tsx`
- Modify : `server/src/db.ts` (`attachments(id, task_id, kind: upload | cloud, provider, external_id, name, mime, size, sha256, url, version, created_by, created_at)`), `web/src/components/TaskDrawer.tsx` (section « Fichiers » avec glisser-déposer et sélecteur cloud)

**Interfaces :**
- Consumes : `Services.require(…, "editor")`, `DlpEngine` (noms et contenus texte), `Envelope`
- Produces :
  - `POST /api/tasks/:id/attachments` (multipart, via `@fastify/multipart`)
  - `POST /api/tasks/:id/attachments/cloud { connection_id, external_id }`
  - `GET /api/attachments/:id/download` : contrôle d'accès, `Content-Disposition: attachment`
  - `DELETE /api/attachments/:id`
  - point d'extension `scanFile(path): Promise<"clean" | "infected">` : `clamd` si `CLAMD_HOST` est défini, sinon `clean`

- [ ] **Step 1 : tests qui échouent** :
  - `un nom ../../etc/passwd est enregistré comme etc_passwd et le fichier est sous attachments/`
  - `un .exe renommé en .png est refusé (415, type réel détecté)`
  - `un fichier de 51 Mo est refusé (413)`
  - `un lecteur ne peut pas envoyer de fichier (403) mais peut le télécharger`
  - `un fichier signalé infecté par le scanner simulé est refusé et audité`
- [ ] **Step 2 → Step 5 :** commit `feat(attachments): pièces jointes et fichiers cloud`

### Task 6 : Abonnements de canaux

**Files :**
- Create : `server/src/connectors/subscriptions.ts`, `server/src/connectors/format.ts`, `server/src/connectors/subscriptions.test.ts`
- Modify : `server/src/db.ts` (`channel_subscriptions(id, project_id, connection_id, channel_ref, events: string[], created_by)`)

**Interfaces :**
- Consumes : `Bus`, `JobQueue`, `MessagingProvider.post`
- Produces :
  - `interface MessagingProvider { post(connectionId, channelRef, msg: RichMessage): Promise<{ ref }>; listChannels(connectionId): Promise<{ ref; name }[]> }`
  - `interface RichMessage { title; body; url; fields?: { label; value }[]; actions?: { id; label; style }[] }`
  - `format.ts` transforme un événement (`task.created`, `task.completed`, `comment.created`, `project.update`, `ai.approval`) en `RichMessage` en français
  - les événements émis par l'IA restent publiés, avec un libellé « par Atlas (IA) »

- [ ] **Step 1 : tests qui échouent** :
  - `un abonnement à task.completed publie un seul message quand une tâche est terminée, aucun à sa création`
  - `un abonnement d'un projet ne reçoit jamais les événements d'un autre projet`
  - `l'échec du fournisseur est repris par la file et n'empêche pas la mise à jour de la tâche`
- [ ] **Step 2 → Step 5 :** commit `feat(connectors): abonnements de canaux`

### Task 7 : Slack

**Files :**
- Create : `server/src/connectors/providers/slack.ts`, `server/src/connectors/providers/slack.test.ts`

**Interfaces :**
- Consumes : briques des tâches 1 à 4 et 6
- Produces :
  - `post` via `chat.postMessage`, en Block Kit
  - commande `/cadence` (`tâche <titre> [@personne] [demain]`, `mes tâches`, `cherche <texte>`)
  - raccourci de message « Créer une tâche Cadence »
  - interactivité : boutons Autoriser et Refuser sur les demandes de validation IA, qui appellent `AiEngine.decide`. L'utilisateur Slack est rattaché à un compte Cadence par son e-mail, via `users.info`.
  - aperçus enrichis via `link_shared` et `chat.unfurl`

- [ ] **Step 1 : tests qui échouent** :
  - `/cadence tâche Préparer la démo @Karim demain` crée la tâche assignée à Karim avec l'échéance de demain, et répond en moins de 3 s
  - `un utilisateur Slack sans compte Cadence reçoit un message éphémère « Liez votre compte Cadence »`
  - `cliquer Autoriser exécute la validation IA ; un membre sans droit d'édition reçoit un refus`
  - `le même payload d'interactivité reçu deux fois ne valide qu'une fois`
- [ ] **Step 2 → Step 5 :** commit `feat(slack): canal, commande, validations IA, aperçus`

### Task 8 : Microsoft Teams, Google Chat, Mattermost, Rocket.Chat

**Files :**
- Create : `server/src/connectors/providers/msteams.ts`, `google_chat.ts`, `mattermost.ts`, `rocketchat.ts`, et `messaging.test.ts`

**Interfaces :**
- Produces : implémentations de `MessagingProvider` :
  - Teams : Microsoft Graph `POST /teams/{id}/channels/{id}/messages` en OAuth délégué, ou URL de workflow entrant (Adaptive Card)
  - Google Chat : webhook entrant (cartes v2)
  - Mattermost et Rocket.Chat : webhook entrant, plus une commande slash à jeton partagé, avec la même syntaxe que `/cadence`

- [ ] **Step 1 :** tests : `chaque fournisseur envoie le corps attendu par sa documentation pour le même RichMessage` (instantané des requêtes simulées) ; `la commande slash Mattermost crée une tâche avec le même analyseur que Slack`
- [ ] **Step 2 → Step 5 :** commit `feat(messaging): Teams, Google Chat, Mattermost, Rocket.Chat`

### Task 9 : Visioconférence

**Files :**
- Create : `server/src/meetings/service.ts` et `server/src/meetings/providers/{zoom,msteams,google_meet,webex,jitsi,bigbluebutton}.ts`, `server/src/meetings/meetings.test.ts`, `web/src/components/MeetingButton.tsx`
- Modify : `server/src/db.ts` (`meetings(id, provider, external_id, task_id, project_id, title, starts_at, duration_min, join_url, recording_url, transcript_attachment_id, created_by)`)

**Interfaces :**
- Produces :
  - `interface MeetingProvider { create(connectionId | null, m: { title; startsAt; durationMin; attendees: string[] }): Promise<{ externalId; joinUrl }> }`
  - Jitsi : aucune authentification, salle `cadence-<uuid>` sur le serveur configuré (`meet.jit.si` par défaut)
  - BigBlueButton : appel `create` avec la somme de contrôle `sha1(apiCallName + query + secret)`
  - Zoom : `POST /users/me/meetings`, plus le webhook `recording.completed`. L'enregistrement et la transcription VTT sont alors attachés à la tâche.
  - Teams : Graph `POST /me/onlineMeetings`
  - Google Meet : Calendar `events.insert` avec `conferenceData.createRequest`
  - Webex : `POST /meetings`
  - route `POST /api/tasks/:id/meetings`
  - après réception d'une transcription, l'IA en extrait les actions (réutilise `AiEngine.parseTasks`) et propose de créer ces tâches, avec relecture

- [ ] **Step 1 : tests qui échouent** :
  - `Jitsi renvoie https://meet.jit.si/cadence-… sans connexion`
  - `la somme de contrôle BigBlueButton correspond à l'exemple de la documentation`
  - `un webhook Zoom recording.completed attache l'enregistrement et la transcription à la bonne tâche et notifie le créateur de la réunion`
  - `la transcription « Karim corrige le crash demain » produit une proposition de tâche assignée à Karim`
- [ ] **Step 2 → Step 5 :** commit `feat(meetings): visioconférences et transcription en tâches`

### Task 10 : Stockage de fichiers

**Files :**
- Create : `server/src/storage/providers/{nextcloud,onedrive,google_drive,dropbox,box}.ts`, `server/src/storage/storage.test.ts`, `web/src/components/CloudPicker.tsx`

**Interfaces :**
- Produces :
  - `interface StorageProvider { list(connId, folderRef?): Promise<Entry[]>; search(connId, q): Promise<Entry[]>; get(connId, ref): Promise<Entry>; createFolder(connId, parentRef, name): Promise<Entry>; upload(connId, folderRef, name, stream): Promise<Entry>; shareLink(connId, ref): Promise<string> }`, avec `Entry { ref; name; kind: "file" | "folder"; mime?; size?; modifiedAt; webUrl; version? }`
  - Nextcloud : WebDAV `PROPFIND` (Depth 1) et `MKCOL`/`PUT` sur `/remote.php/dav/files/<user>/` ; partages OCS `POST /ocs/v2.php/apps/files_sharing/api/v1/shares` (`OCS-APIRequest: true`) ; authentification par mot de passe d'application
  - OneDrive / SharePoint : Graph `/me/drive` et `/sites/{id}/drive`
  - Google Drive : `files.list` (avec `q` et `supportsAllDrives`), `files.create` (multipart)
  - Dropbox : `files/list_folder`, `files/upload`, `sharing/create_shared_link_with_settings`
  - Box : `folders/{id}/items`, `files/content`
  - action de règle `create_project_folder` : crée un dossier au nom du projet et l'épingle dans les ressources clés du projet

- [ ] **Step 1 : tests qui échouent** :
  - `Nextcloud : la réponse PROPFIND de la documentation est convertie en 3 Entry`, dont le dossier et le fichier avec leur taille
  - `Nextcloud : un nom contenant ../ est refusé avant tout appel réseau`
  - `Google Drive : la recherche échappe les apostrophes dans q`
  - `chaque fournisseur, pour le même scénario (lister, créer un dossier, envoyer, partager), émet les requêtes attendues` (instantanés)
- [ ] **Step 2 → Step 5 :** commit `feat(storage): Nextcloud, OneDrive, Google Drive, Dropbox, Box`

### Task 11 : E-mails sortants

**Files :**
- Create : `server/src/mail/outbound.ts`, `server/src/mail/templates.ts`, `server/src/mail/outbound.test.ts`, `web/src/pages/NotificationSettings.tsx`
- Modify : `server/src/db.ts` (`notification_prefs(user_id, channel: inapp | email | slack…, kind, mode: instant | digest | off)`)

**Interfaces :**
- Produces :
  - `class Mailer { send({ to; subject; html; text; replyTo? }) }` via `nodemailer` (SMTP) ou fournisseur API (Gmail, Graph `sendMail`)
  - modèles français : assignation, mention, validation IA en attente, résumé quotidien à 8 h, heure locale de l'utilisateur
  - en-tête `Reply-To: reply+<jeton>@<domaine>`, utilisé par la tâche 12

- [ ] **Step 1 : tests qui échouent** :
  - `une mention envoie un e-mail si la préférence est instant, aucun si off`
  - `le résumé quotidien regroupe 3 notifications en un seul e-mail, à 8 h heure de Paris` (horloge injectée, fuseau `Europe/Paris`)
  - `le HTML échappe le contenu des commentaires` (`<script>` → `&lt;script&gt;`)
- [ ] **Step 2 → Step 5 :** commit `feat(mail): notifications et résumé par e-mail`

### Task 12 : E-mails entrants (e-mail vers tâche, réponse vers commentaire)

**Files :**
- Create : `server/src/mail/inbound.ts`, `server/src/mail/imap.ts`, `server/src/mail/inbound.test.ts`

**Interfaces :**
- Consumes : `JobQueue`, webhooks (tâche 4), `Services`, `DlpEngine`, `AttachmentsService`
- Produces :
  - adresse de projet `<slug>+<jeton>@<domaine>` (le jeton est rotatif) ;
  - `handleInbound(msg: ParsedMail): { action: "task_created" | "comment_added" | "rejected"; reason? }` ;
  - relève IMAP (`imapflow`, IDLE si disponible, sinon interrogation toutes les 2 min) ;
  - webhooks Mailgun, Postmark et SendGrid ;
  - « convertir un e-mail en tâche » depuis Gmail et Outlook : recherche par API puis import d'un message choisi.

- [ ] **Step 1 : tests qui échouent** :
  - `un e-mail d'un membre à l'adresse du projet crée une tâche` : titre = sujet sans « Re: »/« TR: », description = texte, pièces jointes rattachées
  - `une réponse à reply+<jeton> ajoute un commentaire sans la citation du message précédent`
  - `un expéditeur non membre est rejeté : aucune tâche, audit inbound_mail_rejected`
  - `Authentication-Results: dkim=fail → rejeté`
  - `le même Message-ID reçu deux fois ne crée qu'une tâche`
- [ ] **Step 2 → Step 5 :** commit `feat(mail): e-mail vers tâche et réponse par e-mail`

### Task 13 : Calendrier

**Files :**
- Create : `server/src/calendar/ics.ts`, `server/src/calendar/ics.test.ts`

**Interfaces :**
- Produces :
  - `GET /api/calendar/:token.ics` : flux des tâches assignées avec échéance, et des réunions. Le jeton est personnel, rotatif et révocable dans les paramètres.
  - les événements Google et Outlook passent par les fournisseurs de réunion (tâche 9)

- [ ] **Step 1 :** tests : `le flux est un VCALENDAR valide (lignes ≤ 75 octets pliées, CRLF)` ; `une tâche terminée n'y figure plus` ; `un jeton révoqué renvoie 404`
- [ ] **Step 2 → Step 5 :** commit `feat(calendar): flux ICS personnel`

### Task 14 : Outils IA sur les connecteurs

**Files :**
- Modify : `server/src/ai/tools.ts`, `server/src/ai/engine.ts`, `server/src/ai/demo.ts`
- Test : `server/src/ai/connector-tools.test.ts`

**Interfaces :**
- Consumes : `MessagingProvider`, `MeetingProvider`, `StorageProvider`, `Mailer`, `assertAppAllowed`
- Produces : outils d'écriture `post_message { channel, text }`, `schedule_meeting { task, title, starts_at, duration_min, provider }`, `attach_cloud_file { task, connection, ref }`, `send_email { to, subject, body }`. Ils sont tous soumis aux checkpoints, avec une carte de validation qui montre le destinataire et le contenu. S'y ajoute l'outil de lecture `search_files { connection, q }`.

- [ ] **Step 1 : tests qui échouent** :
  - `send_email attend une validation et n'envoie rien en cas de refus`
  - `un agent ne peut pas utiliser une connexion personnelle d'un humain` : seules les connexions d'organisation ou de projet sont autorisées
  - `post_message vers un connecteur interdit par l'administrateur renvoie une erreur d'outil explicite au modèle`
- [ ] **Step 2 → Step 5 :** commit `feat(ai): outils connecteurs sous validation`

### Task 15 : Interface « Intégrations »

**Files :**
- Create : `web/src/pages/Integrations.tsx` (catalogue filtrable par catégorie, état de connexion, connexion et déconnexion), `web/src/views/ProjectIntegrations.tsx` (onglet de projet : abonnements de canaux, dossier cloud, adresse e-mail du projet), `web/src/pages/admin/Apps.tsx` (complété : secrets d'application, liste autorisée, tâches `dead`)
- Modify : `scripts/e2e.mjs`

- [ ] **Step 1 :** étape e2e qui échoue. Alice connecte Jitsi (sans authentification), planifie une réunion depuis une tâche et voit le lien rejoindre. Elle copie l'adresse e-mail du projet. Elle ajoute un abonnement Mattermost, avec un serveur simulé lancé par le script, et un message arrive quand elle termine une tâche.
- [ ] **Step 2 → Step 4 :** implémentation, puis `npm run e2e` vert, puis captures relues à 390 px et 1440 px en thème clair et sombre
- [ ] **Step 5 :** commit `feat(integrations): interface des connecteurs`

---

**Ordre :**
- Les tâches 1 à 4 viennent d'abord, dans l'ordre.
- Ensuite, en parallèle possible : les tâches 5 et 6, puis 7 et 8 (messagerie), 9 (réunions), 10 (stockage), 11 et 12 (e-mail), 13 (calendrier).
- La tâche 14 vient après les fournisseurs, la tâche 15 en dernier.
