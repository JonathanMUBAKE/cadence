# Cadence — Plan de travail : corrections et améliorations

> Rédigé le 9 novembre 2026, après l'audit complet du système.
> Cadence = le projet de la conversation « Asana avec IA embarquée ».
> Dépôt : https://github.com/JonathanMUBAKE/cadence — branche de référence : `main`.

Ce document est la feuille de route partagée par **tous les agents** qui travaillent sur Cadence
(session cloud et session sur l'ordinateur). Il dit quoi faire, dans quel ordre, où, et comment
vérifier que c'est fait. Cochez les cases au fil de l'eau et commitez ce fichier avec le travail.

---

## 0. Règles de travail (à lire avant tout)

1. **Toujours partir de la dernière version** : `git fetch origin && git checkout main && git pull`.
2. **Une branche par lot** : `lot-a-securite`, `lot-b-robustesse`, `lot-c-console`… Jamais de travail direct sur `main`.
3. **Tests d'abord** (TDD) : écrire le test qui échoue, puis le code. Chaque lot ajoute ses tests dans `server/src/*.test.ts`.
4. **Avant chaque commit** : `npm run typecheck` et `npm test` doivent passer (51 tests aujourd'hui, ce nombre ne doit jamais baisser).
5. **Vérifier dans un navigateur** toute modification d'interface (`npm run build && npm start`, puis http://localhost:4000).
6. **Pousser** la branche sur `origin`, puis noter dans la section « Journal » en bas de ce fichier ce qui a été fait.
7. **Langue** : interface, messages d'erreur et commits en français.
8. **Ne jamais commiter** de secret (clé API, mot de passe) : ils vont dans `.env` (ignoré par git).

Commandes utiles : `npm install` · `npm run build` · `npm start` · `npm run dev` (rechargement à chaud) ·
`npm test` · `npm run typecheck` · `npm run e2e`.

---

## 1. État au 9 novembre 2026

| Vérification | Résultat |
| --- | --- |
| Tests serveur (Vitest) | 51 / 51 réussis |
| Typage TypeScript (serveur + web) | 0 erreur |
| Audit des dépendances (`npm audit --omit=dev`) | 0 vulnérabilité |
| Parcours navigateur (Playwright) | OK, aucune erreur JavaScript |
| Claude réel (clé API) | **non testé** (mode démo seulement) |
| Supabase réel | **non testé** (PGlite, même SQL) |
| Installateur Windows `.exe` | **non produit** (nécessite `wine`) ; zip Windows produit, non testé sur Windows |

Architecture et modules : voir `README.md` (section Architecture) et le rapport complet partagé séparément.

---

## 2. Erreurs constatées

| N° | Gravité | Constat | Où | Lot |
| --- | --- | --- | --- | --- |
| E1 | **Bloquant** | Connexion **sans mot de passe** : `POST /api/auth/login {user_id}` connecte n'importe qui (vérifié : connexion en tant que Hugo, réponse 200) | `server/src/app.ts` (route `/api/auth/login`) | A |
| E2 | **Bloquant** | `GET /api/auth/users` liste **tous les utilisateurs de toutes les organisations, avec leur e-mail**, sans être connecté | `server/src/app.ts` (route `/api/auth/users`), `web/src/pages/Login.tsx` | A |
| E3 | Élevé | Aucune limite de tentatives (force brute) ni en-têtes de sécurité HTTP | `server/src/app.ts` | A |
| E4 | Élevé | Secrets par défaut si `COOKIE_SECRET` / `CADENCE_SECRET_KEY` absents : sessions falsifiables et mots de passe SMTP déchiffrables avec une valeur publique | `server/src/app.ts` l.39, `server/src/crypto.ts` | A |
| E5 | Moyen | Une **seule file d'envoi d'e-mails** pour toutes les organisations : un SMTP lent (jusqu'à 20 s) bloque les autres ; aucun nouvel essai en cas d'échec | `server/src/mail.ts` (`enqueue`) | B |
| E6 | Moyen | Le temps réel (SSE) fait une requête en base **par événement et par personne connectée** pour vérifier les droits | `server/src/app.ts` (`route`) | B |
| E7 | Faible | Adresses de service en doublon de nom : `produit-et-design@` (équipe) et `produit-et-design-2@` (entité) | `server/src/mail.ts` (`ensureAddresses`) | B |
| E8 | Faible | La recherche traite `%` et `_` comme des jokers SQL | `server/src/services.ts` l.658 | B |
| E9 | Faible | `ensureAddresses` est appelé à chaque lecture d'adresses et à chaque envoi (requêtes inutiles) | `server/src/mail.ts` | B |

---

## 3. Lots de travail, dans l'ordre

### Lot A — Sécurité bloquante (avant toute mise en ligne)

Objectif : plus personne ne peut se connecter à la place d'un autre ni lister les utilisateurs.

- [x] **A1. Vraie authentification par e-mail + mot de passe** (corrige E1)
  - Migration `004_authentification.sql` : colonne `users.password_hash`, table `sessions` (id, user_id, created_at, expires_at, ip, user_agent, revoked_at), table `login_attempts`.
  - Hachage **argon2id** (paquet `@node-rs/argon2`) ou `crypto.scrypt` natif si on veut zéro dépendance native.
  - `POST /api/auth/login {email, password}` ; message d'erreur unique « E-mail ou mot de passe incorrect » (ne pas révéler si l'e-mail existe).
  - Cookie de session = identifiant de session opaque (plus l'id utilisateur), `httpOnly`, `sameSite=lax`, `secure` en production ; déconnexion = révocation en base.
  - Les coéquipiers IA n'ont jamais de mot de passe et ne peuvent pas se connecter.
  - **Mode démo conservé** derrière `CADENCE_DEMO=1` (choix d'un profil), désactivé par défaut en production.
  - Données de démo : mot de passe commun documenté dans le README (ex. `cadence-demo`).
  - Tests : connexion OK, mauvais mot de passe → 401, IA → refus, session révoquée → 401, cookie forgé → 401.
- [x] **A2. Fermer la liste publique des utilisateurs** (corrige E2)
  - Supprimer `GET /api/auth/users` hors mode démo ; page de connexion = formulaire e-mail + mot de passe.
  - Test : `GET /api/auth/users` → 404 quand `CADENCE_DEMO` n'est pas actif.
- [ ] **A3. Limitation de débit et en-têtes** (corrige E3)
  - `@fastify/rate-limit` : 10 tentatives de connexion / 15 min par IP et par e-mail ; 300 requêtes / min par session sur l'API.
  - `@fastify/helmet` : CSP adaptée à l'interface Vite, `X-Content-Type-Options`, `Referrer-Policy`, HSTS en production.
  - Protection CSRF : vérifier l'en-tête `Origin` sur les requêtes qui modifient (POST/PUT/PATCH/DELETE).
- [x] **A4. Secrets obligatoires en production** (corrige E4)
  - Si `NODE_ENV=production` et que `COOKIE_SECRET` ou `CADENCE_SECRET_KEY` manque ou fait moins de 32 caractères → refuser de démarrer avec un message clair.
  - Documenter dans `.env.example` et le README.
- [x] **A5. Mot de passe oublié** (utilise la messagerie existante)
  - Lien à usage unique valable 30 min, envoyé depuis `contact@<domaine>` de l'organisation (ou SMTP plateforme, voir Lot C).

**Critère de fin du lot A** : les 4 failles E1–E4 ont chacune un test qui échouait avant et passe après.

### Lot B — Robustesse

- [ ] **B1. Une file d'e-mails par organisation, avec reprise** (corrige E5)
  - Table `email_queue` (statut `pending/sending/sent/failed`, `attempts`, `next_attempt_at`) ; 3 essais avec délais croissants (1 min, 5 min, 30 min) ; envois parallèles entre organisations, séquentiels au sein d'une organisation.
  - Le journal `email_log` reste la trace visible dans l'onglet Messagerie.
  - Test : un SMTP qui ne répond pas pour l'organisation A ne retarde pas l'organisation B.
- [ ] **B2. Cache des droits pour le temps réel** (corrige E6)
  - Par connexion SSE, mémoriser les projets visibles ; invalider sur `project.changed`, `org.changed`, changements d'adhésion.
- [ ] **B3. Adresses de service** (corrige E7, E9)
  - Créer les adresses à la création d'une entité ou d'une équipe (abonnement au bus), plus à chaque lecture.
  - En cas de conflit de nom, suffixer par le type (`produit-et-design-dept@`) plutôt que par un chiffre.
- [ ] **B4. Recherche** (corrige E8) : échapper `%`, `_` et `\` avant le `ILIKE`.

### Lot C — Console d'administration (socle)

Besoin exprimé : une console qui gère **plusieurs entreprises clientes** (super admin de la plateforme)
**et** l'administration interne d'une entreprise (admin d'organisation).

- [ ] **C1. Rôle plateforme** : colonne `users.platform_role` (`super_admin` | null). Le premier super admin est créé par la commande `npm run admin:create -- --email … --password …` (jamais par l'interface).
- [ ] **C2. Espace `/admin`** (interface séparée, menu latéral propre) avec deux périmètres :
  - **Super admin** : toutes les entreprises.
  - **Admin d'entreprise** : son entreprise seulement (les pages réutilisent les mêmes composants, filtrées par organisation).
- [ ] **C3. Entreprises clientes** (super admin) : liste, création (nom, domaine, premier administrateur invité par e-mail), suspension (plus de connexion possible, données conservées), réactivation, quotas (nombre d'utilisateurs, d'agents IA, appels IA/mois).
- [ ] **C4. Utilisateurs** : liste filtrable (entreprise, rôle, statut), invitation par e-mail, désactivation, réinitialisation du mot de passe, sessions actives avec révocation, changement de rôle.
- [ ] **C5. Paramètres plateforme** (super admin) : SMTP par défaut de la plateforme (utilisé quand une entreprise n'a pas le sien), clé API IA par défaut, modèle par défaut.
- [ ] **C6. Supervision** : état de la base, file d'e-mails (en attente / échecs), exécutions IA du jour (nombre, erreurs, durée), dernières erreurs serveur, nombre de connectés. Rafraîchissement automatique.

### Lot D — Agents IA configurables

Besoin exprimé : « créer un agent IA, lui donner un prompt système, un nom, des attributions, une clé API, l'attacher à une organisation et qu'il fonctionne bien ».

- [ ] **D1. Fiche agent** : nom, photo, rôle affiché, **prompt système**, modèle (par défaut `claude-opus-5-5`), température, nombre maximal d'étapes.
- [ ] **D2. Attributions** : liste des outils autorisés (lecture seule ; créer des tâches ; modifier ; commenter ; mémoriser), et « agir sans validation » limité aux règles explicites. Le moteur (`server/src/ai/engine.ts`, `tools.ts`) refuse tout outil non attribué.
- [ ] **D3. Clé API** : chiffrée avec `server/src/crypto.ts` (comme le mot de passe SMTP), jamais réaffichée. Ordre de résolution : clé de l'agent → clé de l'entreprise → clé de la plateforme → mode démo. ⚠️ Décision ouverte, voir section 4.
- [ ] **D4. Rattachement** : un agent appartient à une organisation ; ajout aux projets et équipes comme un membre.
- [ ] **D5. Bouton « Essayer l'agent »** : envoie une question de test, affiche la réponse, la durée et l'erreur éventuelle (clé invalide, quota, modèle inconnu) en clair.
- [ ] **D6. Consommation** : jetons et coût estimé par agent, par entreprise et par mois ; plafond mensuel par entreprise (lié aux quotas C3).
- Le fournisseur `server/src/ai/provider.ts` doit être instancié **par agent** (clé et modèle propres) au lieu d'un fournisseur global.

### Lot E — Audit, sécurité et journaux

- [ ] **E1. Journal d'audit unifié** : qui, quoi, quand, depuis quelle IP, sur quel objet, avant/après. Les actions existantes passent déjà par `svc.log` : le compléter (connexions, échecs de connexion, changements de rôle, configuration SMTP, clés API, suspensions).
- [ ] **E2. Écran Audit** : filtres (personne, type d'action, période, entreprise), export CSV, rétention configurable (par défaut 1 an).
- [ ] **E3. Historique des connexions** par utilisateur (date, IP, navigateur, succès/échec).
- [ ] **E4. Politiques de sécurité par entreprise** : longueur minimale du mot de passe, expiration des sessions, double authentification (TOTP) obligatoire ou non, domaines e-mail autorisés.
- [ ] **E5. Journaux techniques** consultables : e-mails (existe), exécutions IA (existe), erreurs serveur (à ajouter : table `error_log` alimentée par le gestionnaire d'erreurs de `app.ts`).

### Lot F — Documents et aperçu intégré

- [x] **F1. Pièces jointes** (stockage objet : à faire si `STORAGE_URL` est retenu) sur les tâches et les commentaires : table `attachments` (stockage en base comme les photos, ou stockage objet S3/Supabase Storage si `STORAGE_URL` est défini), 25 Mo max par fichier, contrôle du type réel du fichier.
- [ ] **F2. Aperçu intégré** dans le panneau de tâche : images, PDF (lecteur du navigateur), texte et Markdown, Word (`.docx` → HTML avec `mammoth`), Excel (`.xlsx` → tableau avec `xlsx`/SheetJS).
- [ ] **F3. Droits** : un fichier hérite des droits de sa tâche ; téléchargement journalisé.

### Lot G — Connecteurs (plus tard)

Messageries (Slack, Teams), visioconférence (Teams, Zoom, Meet), drives (Nextcloud, OneDrive, Google Drive),
réception d'e-mails sur les adresses de service pour créer des tâches. Le détail est dans
`docs/superpowers/plans/2026-11-09-p2-connecteurs.md`.

---

## 4. Décisions ouvertes (à trancher par Jonathan)

| N° | Question | Proposition par défaut |
| --- | --- | --- |
| Q1 | La clé API des agents IA vient-elle du super admin (pour tous les clients), de chaque entreprise, ou des deux ? | **Les deux** : clé plateforme par défaut, une entreprise peut fournir la sienne, un agent peut avoir la sienne |
| Q2 | Le mode démo (choix d'un profil sans mot de passe) doit-il rester disponible ? | Oui, uniquement avec `CADENCE_DEMO=1` |
| Q3 | Les pièces jointes : stockage en base ou stockage objet (Supabase Storage) ? | En base au départ, stockage objet dès que `STORAGE_URL` est défini |

Ne pas commencer le Lot D3 avant la réponse à Q1.

---

## 5. Journal

| Date | Qui | Lot | Ce qui a été fait | Branche / commit |
| --- | --- | --- | --- | --- |
| 2026-11-09 | Claude (session cloud) | — | Audit complet, rédaction de ce plan | `main` |
| 2026-11-09 | Claude (session sur l'ordinateur) | A (partiel) | A4 fait. E2 réduit : plus d'e-mail dans la liste publique. E1 contenu, pas corrigé : écoute locale par défaut, refus de démarrer sur le réseau ou en production sans `CADENCE_DEMO=1`. Un administrateur ne peut plus modifier un propriétaire. A1, A2, A3 et A5 restent à faire. | `lot-a-securite` |
| 2026-11-09 | Claude (session sur l'ordinateur) | Stabilisation | Tableau Kanban : dépôt fiable dans une colonne vide ou courte. Mentions accentuées, dates impossibles, membre inexistant, retards incohérents, plafond de 500 tâches, clés identiques entre organisations, exécutions IA orphelines ou impossibles à annuler, règles sur une section étrangère, date locale, `npm run dev` sous Windows, page d'erreur. E5 à E9 restent à faire (lot B). | `lot-a-securite` |
| 2026-11-09 | Claude (session sur l'ordinateur) | F (partiel) | Pièces jointes des tâches (F1, droits F3, images affichées). Import d'un projet depuis Word, Excel, CSV ou texte, avec relecture avant création. Puis pièces jointes des commentaires (F1), aperçu intégré (F2 : texte structuré pour Word, tableau pour Excel, pas de HTML venu d'un fichier), import des .doc, .xls et PDF, outil `read_attachment` pour les coéquipiers IA. SheetJS 0.20.3 installé depuis le CDN de l'éditeur, car la version du registre npm a des failles connues. Migrations 005 et 006 : 004 est prise par les rapports, l'authentification devra utiliser 007. | `lot-f-documents` |
| 2026-11-09 | Claude (session sur l'ordinateur) | Droits | Revue des actions sensibles. Suppression et sortie d'une tâche réservées à l'auteur et aux administrateurs ; suppression de section et archivage aux administrateurs ; actions IA payantes aux éditeurs ; cible d'une validation IA verrouillée ; annuaire limité pour les invités ; dernier responsable d'équipe protégé ; confirmations et journal complétés. Temps réel : relecture à la reconnexion. | `lot-f-documents` |
| 2026-11-09 | Claude (session sur l'ordinateur) | A | Authentification complète (A1, A2, A5 ; A3 sans @fastify/rate-limit : limites maison sur la connexion, en-têtes et contrôle d'origine). Hachage scrypt plutôt qu'argon2, sans dépendance native. Administrateur système (C1) créé par lien affiché au démarrage, sans mot de passe en ligne de commande. Profils dynamiques et exceptions par personne. Q2 tranchée : mode démo avec `CADENCE_DEMO=1`, local uniquement. Migration 007 ; les rapports (004) restent sur leur branche. | `lot-a-authentification` |
| 2026-11-09 | Claude (session sur l'ordinateur) | A (audit) | Audit de sécurité, puis correction des 3 failles critiques et 6 élevées, avec 31 tests dans `durcissement.test.ts`. Un compte en attente n'a de lien que par sa première organisation ; compte suspendu impossible à inviter, ses liens annulés. Réinitialisation uniquement par le SMTP de la plateforme. Ancienne route de rôle soumise à la règle des profils. Coéquipiers IA limités au périmètre du demandeur ; @mention et assignation soumises à `ai.delegate`. Essais de connexion comptés avant vérification, scrypt plafonné à 2 calculs, `TRUST_PROXY` en nombre de proxys. 2FA verrouillée par compte (migration 008). Jetons après le `#` des liens. Restent : 8 failles moyennes de l'audit, 2FA obligatoire pour les administrateurs, confirmation de l'adresse à la première invitation. | `lot-a-authentification` |
| 2026-11-09 | Claude (session sur l'ordinateur) | A (audit) | Audit multi-tenant : 110 routes × 7 profils, scénarios d'attaque, schéma et qualité. Constats, corrections par lots et décisions dans `docs/AUDIT-MULTI-TENANT.md`. Aucune correction appliquée à ce stade. | `lot-a-authentification` |
| 2026-11-09 | Claude (session sur l'ordinateur) | A (audit, lot 1) | Invitations avec acceptation par le titulaire, liens envoyés uniquement par le SMTP de la plateforme, obligatoire hors usage local (migration 009, table `org_invitations`). Plus d'ajout direct d'un compte à une organisation. Photo modifiable par son seul titulaire. Session contrôlée avant la lecture du corps. Rôle explicite plafond, droit `teams.join`. 20 tests dans `isolation.test.ts`. Restent les lots 2 à 5 de `docs/AUDIT-MULTI-TENANT.md`. | `lot-a-authentification` |
| 2026-11-09 | Claude (session sur l'ordinateur) | A (audit, lot 2) | Limites par IP, session, personne (IA), organisation (invitations, exécutions IA) et connexions temps réel, sans dépendance ajoutée. Organisation active périmée : 409 au lieu d'un repli. `org_id` et clés composites posés sur les tables métier, remplis par la base (migration 010). `matrice.test.ts` rejoue tout le contrat d'accès et échoue si une route n'y figure pas. Les politiques RLS par organisation restent à faire : elles exigent un environnement Supabase réel. | `lot-a-authentification` |
| 2026-11-09 | Claude (session sur l'ordinateur) | A (audit, lot 3) | Lectures sans écriture (adresses de service tenues à jour sur événement). Commentaires soumis à `tasks.comment` de bout en bout. Un administrateur n'agit plus sur un pair. Projet archivé en lecture seule. Règles IA suspendues au droit de leur créatrice et plafonnées ; la validation automatique ne couvre plus la modification d'une tâche. Profil système Lecture seule (migration 011). | `lot-a-authentification` |
