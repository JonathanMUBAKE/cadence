# Cadence

Outil de gestion de projet complet avec IA embarquée, inspiré du modèle d'Asana (Work Graph, AI Teammates, AI Studio).
**Node.js + Fastify + PostgreSQL** (Supabase en production, PGlite embarqué en développement) côté serveur, **React 19 + Vite + Tailwind** côté client, **Claude** pour l'IA.

## Fonctionnalités

**Gestion de projet**
- Projets avec statut, échéance, couleur et icône, sections personnalisables et modèles (Kanban, développement produit, lancement…)
- Six vues par projet : **Liste**, **Tableau** Kanban en glisser-déposer, **Calendrier**, **Chronologie** (Gantt), **Tableau de bord** (indicateurs, courbe de progression, charge par personne, priorités) et **Automatisations**
- Tâches complètes : responsable, échéance, priorité, étiquettes, sous-tâches, description, commentaires avec @mentions, historique, **pièces jointes** sur la tâche et les commentaires (25 Mo par fichier, type réel contrôlé, droits de la tâche), avec aperçu intégré (images, PDF, Word, Excel, CSV, texte) et lecture par les coéquipiers IA
- Accueil personnalisé, page « Mes tâches » groupée par échéance, boîte de réception (mentions, assignations, validations)
- Membres et rôles par projet : lecteur, commentateur, éditeur, administrateur. Les droits sont appliqués côté serveur. Supprimer une tâche ou la sortir du projet est réservé à son auteur et aux administrateurs ; supprimer une section et archiver un projet, aux administrateurs.
- Temps réel (Server-Sent Events) : tout se met à jour sans recharger la page
- Palette de commandes (⌘K), thème clair/sombre, interface entièrement utilisable sur mobile

**IA embarquée**
- **Coéquipiers IA** (Atlas, Nova) : ce sont des membres de l'équipe, avec leurs propres droits.
  - Pour les faire travailler, on peut leur assigner une tâche, les **@mentionner** dans un commentaire ou cliquer sur « Confier à… ».
  - Ils lisent le contexte (tâche, projet, membres, commentaires, souvenirs), utilisent des outils et rendent un compte rendu.
- **Validations humaines (checkpoints)** : chaque création, modification ou commentaire de l'IA attend l'accord d'un humain. On peut autoriser, refuser ou **retoucher** l'action avant qu'elle s'exécute.
- **Assistant Cadence AI** (⌘J) : questions en langage naturel sur vos projets. Il agit avec *vos* droits et ses réponses s'affichent en direct.
- **Règles IA** (façon AI Studio) : un déclencheur (tâche créée, déplacée, en retard), une consigne en langage naturel et un coéquipier pour l'appliquer.
- **Actions intelligentes** :
  - suggérer des sous-tâches ;
  - réécrire une description ;
  - rédiger un point d'avancement de projet ;
  - transformer des notes en vrac en tâches, avec relecture avant création ;
  - **importer un projet** depuis un fichier Word, Excel (formats récents et anciens), PDF, CSV ou texte : l'IA propose le projet, ses sections, tâches et sous-tâches, et rien n'est créé avant la relecture.
- **Mémoire** rattachée aux projets, et **journal** complet de chaque intervention.

**Organisation du travail** (inspirée d'Asana, Jira, Confluence et Microsoft Project)
- **Organisations multiples**, étanches entre elles : on passe de l'une à l'autre en un clic.
- **Organigramme hiérarchique** à profondeur libre : entreprise, filiale, direction, département, service, site. Chaque entité a un responsable, qui voit en lecture les projets de toute sa branche.
- **Équipes** publiques, sur demande (avec validation) ou privées, rattachées à une entité.
- **Projets** rattachés à une équipe, avec une clé (`APP-12`) et un accès « toute l'équipe » ou « privé ».
- **Photos de profil** pour les personnes et les coéquipiers IA. L'image est recadrée et allégée dans le navigateur, puis stockée en base. Seuls l'intéressé ou un administrateur peuvent la changer.

**Messagerie de l'organisation**
- Chaque organisation a son propre **serveur SMTP** et son **domaine**. Le mot de passe est chiffré en base (AES-256-GCM) et n'est jamais renvoyé par l'API.
- Une **adresse de service par niveau**, toutes sur le même domaine : `contact@` pour l'organisation, puis une adresse par entité (`ingenierie@`, `ressources-humaines@`…) et une par équipe (`equipe-mobile@`…). Chaque adresse est personnalisable, sans doublon.
- Les **notifications par e-mail** (assignation, mention, commentaire…) partent de l'adresse la plus précise : équipe du projet, sinon entité, sinon organisation. Le sujet suit la clé de tâche (`[APP-12] Titre`).
- Un bouton d'**e-mail de test**, des messages d'erreur SMTP compréhensibles et un **journal des envois**. Une panne SMTP ne bloque jamais l'action d'origine.
- **Droits effectifs** calculés en cascade : rôle dans l'organisation, adhésion explicite, appartenance à l'équipe, supervision hiérarchique, visibilité de l'équipe. Les invités ne voient que ce qui leur est partagé.

## Démarrer

```bash
npm install
npm run build
npm start                       # http://localhost:4000
```

Sans configuration, la base est un **PostgreSQL embarqué** (PGlite) stocké dans `server/data` : rien à installer. Le jeu de démonstration est créé au premier démarrage.

Développement avec rechargement à chaud : `npm run dev` lance l'API sur le port 4000 et Vite sur le port 5173.

### Héberger la base sur Supabase

1. Créez un projet sur [supabase.com](https://supabase.com).
2. Ouvrez **Project Settings → Database → Connection string**. Copiez l'URI du **Session pooler** (port 5432), avec votre mot de passe.
3. Déclarez la chaîne de connexion, appliquez les migrations, puis démarrez :
   ```bash
   export DATABASE_URL="postgresql://postgres.<ref>:<mot-de-passe>@aws-0-<région>.pooler.supabase.com:5432/postgres"
   export COOKIE_SECRET="<32 caractères aléatoires ou plus>"
   export CADENCE_SECRET_KEY="<32 autres caractères aléatoires ou plus>"
   npm run build && npm run migrate && npm start
   ```
   Les migrations s'appliquent aussi automatiquement au démarrage. Elles sont versionnées dans `server/migrations/` et n'agissent qu'une fois.
4. **Sécurité** : Supabase publie automatiquement le schéma `public` via son API REST (clé « anon »). La migration `002_rls.sql` active la sécurité au niveau des lignes (RLS) sur toutes les tables, sans aucune règle d'accès. Cette API ne renvoie donc rien, ce que vérifie un test automatique. Cadence, propriétaire des tables, n'est pas concerné. Ne partagez jamais la clé `service_role`.

Supabase héberge la base de données, pas le serveur Node.js. Le serveur se déploie sur n'importe quel hébergeur Node : Render, Railway, Fly.io, un VPS ou Docker. Les sauvegardes de la base dépendent de votre offre Supabase.

### Activer Claude

Sans clé, l'IA tourne en **mode démo** : un moteur à règles appelle les mêmes outils, ce qui permet de tester toute la chaîne (droits, validations, journal, temps réel). Pour utiliser Claude :

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm start
```

Le modèle par défaut est `claude-opus-5-5`. On peut le changer avec la variable `CADENCE_MODEL`.

| Variable | Rôle | Défaut |
|---|---|---|
| `PORT` | Port HTTP | `4000` |
| `DATABASE_URL` | Chaîne de connexion PostgreSQL (Supabase…) | PGlite embarqué |
| `DATA_DIR` | Dossier du PostgreSQL embarqué (`:memory:` pour une base éphémère) | `server/data` |
| `ANTHROPIC_API_KEY` | Active Claude | mode démo |
| `CADENCE_MODEL` | Modèle Claude | `claude-opus-5-5` |
| `HOST` | Adresse d'écoute. Toute autre valeur que l'ordinateur local exige `CADENCE_DEMO=1` | `127.0.0.1` |
| `PUBLIC_URL` | Adresse publique, utilisée dans les liens envoyés par e-mail. **Obligatoire** en production ou sur le réseau | `http://localhost:PORT` |
| `CADENCE_DEMO` | `1` : données d'exemple et connexion sans mot de passe. Usage local uniquement, refusé en production | désactivé |
| `TRUST_PROXY` | Derrière un proxy de confiance : nombre de proxys devant Cadence (`1` le plus souvent) ou leurs adresses (`10.0.0.0/8`) | désactivé |
| `SMTP_URL`, `SMTP_FROM` | Messagerie de la plateforme, **seule à envoyer les invitations et les liens de réinitialisation**. **Obligatoire** en production ou sur le réseau | aucune |
| `CADENCE_BOOTSTRAP` | `1` : réaffiche au démarrage le lien de création d'un administrateur système | désactivé |
| `COOKIE_SECRET` | Signature des sessions, 32 caractères minimum. **Obligatoire** en production ou avec `DATABASE_URL` | généré dans `server/.cadence-secret` |
| `CADENCE_SECRET_KEY` | Clé de chiffrement des secrets en base (mot de passe SMTP), 32 caractères minimum. **Obligatoire** en production ou avec `DATABASE_URL` : la changer rend les mots de passe enregistrés illisibles. | `COOKIE_SECRET`, sinon le secret local |

## Tests

```bash
npm test          # 152 tests : API, droits en cascade, hiérarchie, organisations, IA, validations, RLS, messagerie SMTP réelle, photos (Vitest)
npm run e2e       # parcours complet dans un vrai navigateur (Playwright)
```

## Architecture

```
server/src
  db.ts             accès PostgreSQL (pg pour Supabase, PGlite embarqué) et migrations
  ../migrations/    schéma SQL versionné (001 initial, 002 sécurité RLS, 003 photos et messagerie)
  services.ts       logique métier : organisations, entités, équipes, projets, tâches, droits effectifs
  auth/             mots de passe, sessions, double authentification, invitations, console système, profils
  permissions.ts    catalogue des droits cochables
  bus.ts            événements métier → temps réel, déclencheurs IA et e-mails
  mail.ts           SMTP par organisation, adresses de service par niveau, envoi des notifications
  crypto.ts         chiffrement des secrets stockés en base
  app.ts            API REST + SSE (Fastify), validation zod, front-end compilé
  ai/tools.ts       outils exposés au modèle (lecture / écriture), exécutés avec les droits de l'agent
  ai/engine.ts      boucle d'agent, checkpoints, déclencheurs, règles, actions intelligentes
  ai/provider.ts    Claude (SDK Anthropic, repli automatique en cas de refus)
  ai/demo.ts        fournisseur de démonstration sans clé
web/src
  pages/            Accueil, Mes tâches, Boîte de réception, Coéquipiers IA, Projet
  views/            Liste, Tableau, Calendrier, Chronologie, Tableau de bord, Automatisations
  components/       panneau de tâche, assistant, palette, validations, design system
```

**Principes repris d'Asana.**
1. **Contexte structuré d'abord.** L'IA part du graphe (tâche → projet → membres → historique) et traduit les questions en filtres précis, plutôt que de tout chercher.
2. **L'IA est un utilisateur comme un autre.** Elle a des adhésions et des rôles, et chaque outil vérifie ses droits.
3. **Humain dans la boucle.** Les écritures passent par une validation, sauf si une règle l'autorise explicitement. Tout est journalisé.

## Comptes et sécurité

**Premier démarrage.** Le serveur affiche un lien, valable 24 heures, pour créer l'**administrateur système**. Si l'adresse saisie correspond à un compte existant, ce compte est élevé à ce rôle. En cas de perte d'accès : `CADENCE_BOOTSTRAP=1`.

**Création des comptes.** Sur invitation par défaut : un administrateur saisit l'adresse, la personne reçoit par e-mail un lien à usage unique, valable 72 heures, et choisit son mot de passe. Un compte qui existe déjà reçoit une invitation à accepter ou refuser : personne n'entre dans une organisation sans son accord. En option (console **Administration → Inscriptions**), les visiteurs peuvent demander un accès : rien n'est ouvert avant validation, qui déclenche la même invitation.

**Protections.** Mots de passe hachés avec scrypt (paramètres OWASP) et contrôlés selon les règles du NIST ; sessions opaques dont seule l'empreinte est stockée, révocables, expirant après 7 jours d'inactivité ou 30 jours ; double authentification TOTP avec codes de secours ; verrouillage progressif des comptes et limitation par adresse IP ; réponses identiques qu'un compte existe ou non ; contrôle de l'origine des requêtes ; en-têtes CSP, HSTS, X-Frame-Options ; journal de sécurité.

**Profils et droits.** Chaque organisation crée ses profils et y coche les droits ; une exception par personne (autoriser ou refuser) l'emporte sur le profil. Le profil s'ajoute au rôle sur le projet : il faut les deux. Personne ne peut accorder un droit qu'il ne possède pas. Le catalogue des droits se trouve dans `server/src/permissions.ts`.

**Mode démo.** `CADENCE_DEMO=1` crée les données d'exemple et permet de choisir un profil sans mot de passe. Il est réservé à un usage local : le serveur refuse de démarrer ainsi en production ou sur le réseau.
