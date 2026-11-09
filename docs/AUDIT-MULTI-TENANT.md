# Cadence — Audit multi-tenant, accès et qualité

> Audit du 9 novembre 2026 sur la branche `lot-a-authentification`, après correction des 9 failles critiques et élevées de l'audit précédent.
> Ce document liste les constats et leur correction. **Aucune correction n'a encore été appliquée.**
> Cadre : frontières de confiance (Stripe), modèle de menace (Cloudflare), verbes et attributs (IBM), isolation des tenants (Microsoft).

## Verdict

**Cadence n'est pas prêt pour plusieurs organisations clientes.** Le cloisonnement des données métier résiste à toutes les attaques directes. La faiblesse se situe ailleurs : **le compte utilisateur est global, et une organisation peut agir dessus.**

| Gravité | Nombre | Constats |
| --- | --- | --- |
| Critique | 1 | T-01 |
| Élevé | 5 | T-02, T-03, A-01, A-02, R-01 |
| Moyen | 15 | T-04, R-02 à R-07, S-01 à S-08 |
| Faible | 6 | T-05, R-08, S-09 à S-12 |
| Qualité | 12 | Q-01 à Q-12 |

| Référentiel | Appréciation | Pourquoi |
| --- | --- | --- |
| Stripe : frontières de confiance | Partiel | Les identifiants métier sont validés, sauf l'identité globale (T-01, T-02) et une position de tâche (T-05). |
| Cloudflare : menace et périphérie | Insuffisant | Le corps des requêtes anonymes est lu avant le contrôle de session (A-01), et il n'y a aucune limite de débit (A-02). |
| IBM : verbes et attributs | Partiel | Un profil sans aucun droit reste bloqué partout, sauf pour rejoindre une équipe (R-01). Un GET écrit en base (R-02). |
| Microsoft : isolation des tenants | Partiel | Aucune fuite constatée, mais l'isolation repose uniquement sur le code applicatif (T-03). |

### Méthode

- **110 routes privées × 7 variantes de profil**, avec de vrais identifiants et des corps valides. Chaque profil dispose d'une instance neuve. Résultats en annexe A.
- **Scénarios d'attaque** ciblés sur serveur HTTP réel lorsque le comportement réseau compte.
- **Inspection statique** des 295 requêtes SQL, du schéma, de la complexité, de la duplication et de l'historique Git.

| Profil | Réalisation |
| --- | --- |
| P1 Anonyme | Aucun cookie |
| P2a Lecteur strict | Profil personnalisé sans aucun droit, rôle `viewer` sur le projet |
| P2b Lecteur membre | Profil système Membre, rôle `viewer` sur le projet |
| P2c Lecteur invité | Profil système Invité, rôle `viewer` sur le projet |
| P3 Propriétaire externe | Propriétaire d'une organisation B, avec les identifiants réels de l'organisation A |
| P4a / P4b | Propriétaire / administrateur de l'organisation A |

### Limites

- Tout a tourné sur PGlite, qui exécute les requêtes quasiment en série : les courses de S-05 ne sont pas reproductibles ici et restent établies par lecture du code.
- Supabase réel, SMTP réel et Claude réel n'ont pas été utilisés. L'IA a été remplacée par un fournisseur de démonstration ou simulé.
- La matrice tourne en mode démo, où `POST /api/orgs` est ouvert à tous. Hors démo, seul l'administrateur système peut créer une organisation (test existant). Le « P3 » suppose donc un administrateur d'organisation existant.
- `GET /api/events` n'est pas dans la matrice, car le flux reste ouvert. Son isolation est prouvée par le scénario F1 ; le rejet anonyme vient du même contrôle que les autres routes (lecture du code).
- L'interface web n'a pas fait l'objet d'un test d'intrusion.

### Suivi des corrections

**Lot 1 corrigé** (Q-02, T-01, T-02, A-01, R-01), avec les choix D1, D2 et D4 proposés. La suite passe à 203 tests et la matrice de l'annexe A compte désormais 113 routes.

| ID | Avant | Après (scénario rejoué) |
| --- | --- | --- |
| T-01 | L'attaquant devient administrateur de l'organisation A | Aucun lien reçu, activation 400, connexion 401, aucun rattachement |
| T-02 | Compte ajouté, photo supprimée, adresse obtenue | 404 sur le compte et l'agent, photo intacte, adresse non obtenue |
| A-01 | Aucune réponse avant la fin du corps | 401 en 9 ms, 16 Mo côté serveur pour 12 envois de 25 Mo |
| R-01 | `viewer` devenu `editor` | Reste `viewer`, création refusée ; `teams.join` exigé |

**Limites restantes du lot 1.**
- En usage local sans SMTP, le lien d'une adresse inconnue reste affiché à l'administrateur : aucune preuve d'adresse n'y est possible. Le démarrage en production ou sur le réseau exige désormais `SMTP_URL`.
- Les agents IA restent ceux des données de démonstration : ils ne peuvent plus changer d'organisation, mais la création d'agents par organisation relève du lot D4 du plan de travail.
- Les profils personnalisés existants ne reçoivent pas `teams.join` : il faut le cocher. Les profils système l'obtiennent par la migration 009.
- Le volume d'invitations par organisation est désormais plafonné (A-02) ; leur contenu reste libre (nom de l'organisation et de la personne).

**Lots 2 à 5 corrigés**, sauf ce qui suit. La suite compte 261 tests, et `matrice.test.ts` rejoue le contrat d'accès à chaque exécution. Les numéros de ligne cités dans ce document datent d'avant le formatage automatique du code.

| Reste à faire | Pourquoi ce n'est pas fait | Quand |
| --- | --- | --- |
| Politiques RLS par organisation (fin de T-03) | Exige un vrai Supabase et un rôle applicatif distinct : invérifiable ici, risque de couper l'accès. La base bloque déjà les liens entre organisations. | À la mise en place de Supabase |
| Plusieurs serveurs en parallèle (Q-08) | Temps réel, limites et validations IA vivent en mémoire d'un seul serveur. | Avant de dépasser un serveur |
| Découpage de `Services` et des fonctions complexes (Q-03, Q-04) | Gros refactoring sans bénéfice visible ; plus sûr à mener seul, zone par zone. | Chantier dédié |
| Suppression logique et clés d'idempotence (fin de Q-09) | Évolution du modèle de données et de l'interface. | Chantier dédié |

**Écart avec les corrections prévues.** R-02 : la lecture des adresses de service reste ouverte aux membres, car l'interface des équipes les affiche ; seule l'écriture pendant un GET est supprimée. S-07 : la 2FA obligatoire et le blocage des SMTP internes ne s'appliquent qu'aux serveurs en HTTPS, pour ne pas bloquer un usage local. Q-05 : Biome remplace ESLint et Prettier, qui dépendent d'une API absente de TypeScript 7.

---

## 1. Architecture multi-tenant

### 1.1 D'où vient l'organisation ?

| Question | Réponse |
| --- | --- |
| Identité | Jeton de session opaque de 256 bits, recherché par empreinte en base à chaque requête. Solide. |
| Organisation active | Cookie signé `cadence_org`, **revalidé à chaque requête** contre les adhésions en base ([app.ts:109](../server/src/app.ts)). |
| URL ou corps modifiables ? | Non pour les routes d'organisation. Un `org_id` dans le corps est ignoré (B1). |
| Cookie falsifié | Rejeté : signature fausse ou valeur brute (B3). |
| Point faible | Repli silencieux sur la première organisation (T-04). |

### 1.2 Ce qui a résisté

| Attaque du profil 3 | Résultat |
| --- | --- |
| 110 routes sur les objets de l'organisation A | Aucun accès aux données de A (403/404). Les seuls succès viennent de T-02. |
| `?project_id=`, `?assignee=`, `?task_id=` vers A | 403 ou liste vide |
| Recherche par texte ou par clé de tâche de A | 0 résultat |
| Validation, annulation ou lecture d'une exécution IA de A | 403 |
| Marquer lue une notification d'une autre personne | Sans effet |
| Références croisées : parent, section, assigné, équipe, entité, responsable, règle, import | Refusées, 16 cas sur 17 (voir T-05) |
| Temps réel : activité de A observée depuis B | Seul `hello` reçu |
| Assignation de masse (`org_id`, `owner_id`, `task_seq`) | Champs ignorés |
| Injection SQL | Toutes les requêtes sont paramétrées ; les colonnes dynamiques viennent de listes fixes |

### 1.3 Failles

#### T-01 · Critique · Pré-appropriation d'un compte par une autre organisation

**Scénario reproduit.** L'administrateur d'une organisation B invite `directrice@client.test`, une adresse encore inconnue de Cadence. Il obtient le lien, car aucun SMTP ne l'a envoyé, puis active le compte avec son propre mot de passe. Plus tard, l'organisation A invite la même adresse comme **Administrateur**.

**Résultat.** Réponse `already_active: true`, aucune vérification. L'attaquant se connecte : `Nova Mobile:admin`, 4 projets lisibles.

**Cause.** L'adresse e-mail n'est jamais prouvée par son titulaire, et un compte existant est rattaché sans son accord ([provisioning.ts:122](../server/src/auth/provisioning.ts)).

**Contre-argument.** « Il faut être administrateur d'une organisation. » C'est justement le modèle de menace d'un produit multi-tenant : chaque client est un attaquant potentiel pour les autres.

#### T-02 · Élevé · Ajout forcé d'un compte d'une autre organisation

**Reproduit (B4).** `PUT /api/org/members/:userId` accepte n'importe quel identifiant de compte ([services.ts:270](../server/src/services.ts)). Depuis B, sans aucun lien avec la victime :

- l'adresse e-mail de la victime est obtenue ;
- sa photo, visible dans toutes ses organisations, est supprimée ([services.ts:164](../server/src/services.ts)) ;
- le coéquipier IA partagé `ai_atlas` est rattaché à B et sa photo modifiée pour tous les tenants.

L'invitation par e-mail produit le même rattachement. Elle révèle aussi si un compte existe.

#### T-03 · Élevé · Isolation purement applicative

La base ne protège aucune frontière entre organisations :

| Mesure | Valeur |
| --- | --- |
| Tables métier sans `org_id` | 12 : `tasks`, `sections`, `comments`, `attachments`, `memberships`, `team_members`, `team_requests`, `ai_steps`, `ai_approvals`, `ai_rules`, `ai_memories`, `avatars` |
| Clés étrangères composites incluant l'organisation | 0 sur 45 |
| Politiques RLS | 0 sur 30 tables |
| Requêtes SQL sur tables métier sans clause d'organisation, de projet ou d'utilisateur | 114 sur 295, dont 9 dans les données de démonstration |
| Tâche rattachée directement à la section d'une autre organisation | Acceptée par la base (G3) |
| Projet rattaché à l'équipe d'une autre organisation | Acceptée par la base (G3) |

**Nuance.** RLS activé sans politique bloque bien les rôles non propriétaires, par exemple l'API de données de Supabase. Mais le serveur se connecte en propriétaire et passe outre. Ce n'est donc pas une isolation par tenant.

**Conséquence.** Le schéma est « autoriser d'abord, puis agir par identifiant global » (`UPDATE … WHERE id = $1`). Aucune fuite n'existe aujourd'hui, mais un seul contrôle oublié sur 55 serait une fuite inter-tenants, sans seconde barrière.

#### T-04 · Moyen · Repli silencieux sur une autre organisation

**Reproduit (B5).** Une personne retirée de son organisation active, puis une requête `POST /api/teams` : réponse 200, **l'équipe est créée dans l'autre organisation**, sans erreur ([app.ts:109](../server/src/app.ts)). Un onglet resté ouvert écrit donc dans le mauvais tenant. Il faut un refus explicite.

#### T-05 · Faible · Lecture de la position d'une tâche étrangère

**Reproduit (B2).** `POST /api/tasks/:id/move` avec `after_id` d'une tâche de A : la position de cette tâche est lue et utilisée ([services.ts:863](../server/src/services.ts)). Fuite minime, mais c'est le seul identifiant client non vérifié.

---

## 2. Qualité du code et dette technique

| Mesure | Valeur | Lecture |
| --- | --- | --- |
| Fonctions | 1 135 | |
| Complexité cyclomatique > 10 / > 20 | 58 / 7 | Concentré sur quelques fonctions |
| Pire fonction | `updateTask`, complexité 39 | Seuil usuel : 10 |
| Duplication (blocs de 80 jetons) | 0,33 % | Très bon |
| Classe `Services` | 84 méthodes | Responsabilité unique non respectée |
| Lignes de plus de 160 caractères | 933 | Relecture difficile |
| ESLint, Prettier, CI | Absents | 6 `eslint-disable` sans ESLint installé |
| Tests d'interface | 0 pour 5 444 lignes | |
| Tests serveur | 183, tous au vert | |

**Gestion des erreurs.** Saine sur l'API : sur 14 entrées hostiles, aucune réponse ne révèle SQL, chemin ou pile d'exécution. Deux réserves : S-09 et Q-11.

| ID | Gravité | Constat | Où |
| --- | --- | --- | --- |
| Q-01 | Élevé | Autorisation à déclarer à la main : 55 appels répartis dans 8 fichiers, sans refus par défaut. C'est la cause de H2, R-03 et R-02. | `requirePerm`, `projectPerm` |
| Q-02 | Élevé | **37 fichiers non commités**, dont toute l'authentification et ses correctifs. Une panne de disque les perd. | Branche |
| Q-03 | Moyen | `Services` regroupe 84 méthodes de domaines différents. | [services.ts](../server/src/services.ts) |
| Q-04 | Moyen | Fonctions trop complexes : `updateTask` 39, `execute` 30, `DrawerBody` 29. | [services.ts](../server/src/services.ts), [tools.ts](../server/src/ai/tools.ts), [TaskDrawer.tsx](../web/src/components/TaskDrawer.tsx) |
| Q-05 | Moyen | Ni lint, ni formatage, ni intégration continue. | Racine |
| Q-06 | Moyen | Requêtes N+1 : 22 requêtes pour un commentaire, 14 pour ouvrir une tâche, une requête par membre et par projet. Le temps réel ajoute une requête par événement et par connexion. | `addComment`, `listProjects`, `route` |
| Q-07 | Moyen | 21 clés étrangères sans index, dont `tasks.section_id`, `memberships.user_id`, `ai_runs.org_id`. | Migrations |
| Q-08 | Moyen | Bus d'événements et validations IA en mémoire : un seul serveur possible. | [bus.ts](../server/src/bus.ts), [engine.ts](../server/src/ai/engine.ts) |
| Q-09 | Moyen | Traçabilité non immuable : suppression d'un projet = suppression de son historique ([services.ts:623](../server/src/services.ts)). Suppressions définitives, aucune clé d'idempotence sur les POST. | |
| Q-10 | Moyen | Opérations en plusieurs écritures hors transaction : `invite`, `activate`, `addComment`. | [provisioning.ts](../server/src/auth/provisioning.ts) |
| Q-11 | Faible | L'erreur brute d'un outil IA est stockée, renvoyée au modèle et visible dans le détail d'une exécution. | [engine.ts](../server/src/ai/engine.ts) |
| Q-12 | Faible | Fermeture du serveur : des exécutions IA démarrent après la fermeture de la base (constaté). Code mort : `void role` ([services.ts:419](../server/src/services.ts)), `.map((u) => u)` ([services.ts:620](../server/src/services.ts)). | |

---

## 3. Sécurité des accès et invariants

### 3.1 Résultats de la matrice

| Profil | Attendu | Constaté |
| --- | --- | --- |
| P1 Anonyme | 401 | **110 sur 110 refusées.** Mais voir A-01 : le refus arrive trop tard. |
| P2a Lecteur strict | 403 sur toute écriture | Une seule écriture métier acceptée : rejoindre une équipe (R-01). |
| P2b Lecteur membre | 403 sur toute écriture | 6 écritures acceptées au niveau organisation (R-01, R-07). |
| P2c Lecteur invité | 403 sur toute écriture | Assistant IA uniquement (`ai.assistant`). |
| P3 Propriétaire externe | 403/404 | Aucun accès aux données de A. Une brèche : T-02. |
| P4 Propriétaire, administrateur | 2xx | Conforme. Écarts normaux : pas de photo existante (404), seul l'auteur modifie un commentaire. |
| Tous | Aucune erreur 500 | 0 sur la matrice. |

### 3.2 Surface anonyme

#### A-01 · Élevé · Le corps est lu avant le contrôle de session

Le contrôle est un `preHandler`, qui s'exécute **après** la lecture du corps ([app.ts:134](../server/src/app.ts)).

**Reproduit sur un vrai serveur.** Un anonyme envoie 1 Ko sur 20 Mo annoncés : aucune réponse tant que le corps n'est pas complet. 12 envois anonymes de 25 Mo finissent tous en 401, après mise en mémoire de leur contenu, soit jusqu'à 300 Mo côté serveur. Quelques requêtes sans compte suffisent à faire tomber une petite instance. *Correction : le chiffre de 831 Mo publié d'abord incluait le client de test, qui tournait dans le même processus.*

#### A-02 · Élevé · Aucune limite de débit ni de quota

**Reproduit (E2).** 400 lectures et **25 appels IA simultanés** acceptés depuis une seule session. Chaque appel IA peut consommer jusqu'à 12 tours de modèle, donc un coût direct. S'y ajoutent l'absence de `requestTimeout` ([app.ts:59](../server/src/app.ts)) et de plafond de connexions temps réel.

### 3.3 Rôles et verbes

#### R-01 · Élevé · Un lecteur explicite devient éditeur tout seul

**Reproduit (C1).** Hugo est `viewer` explicite d'un projet : création de tâche refusée (403). Il appelle `POST /api/teams/:id/join` sur l'équipe publique du projet : 200, puis création acceptée, **rôle effectif `editor`**.

**Cause.** `ACCESS_SQL` prend le **maximum** des sources ([services.ts:75](../server/src/services.ts)), et `joinTeam` n'exige aucun droit ([services.ts:453](../server/src/services.ts)). Un rôle explicite n'est donc jamais un plafond.

#### Autres constats

| ID | Gravité | Constat | Preuve | Où |
| --- | --- | --- | --- | --- |
| R-02 | Moyen | Un GET écrit en base, et lit sans `org.mail`. Un profil sans droit a créé 15 lignes. | C3 | [mail.ts:131](../server/src/mail.ts) |
| R-03 | Moyen | Sans `tasks.comment`, on peut encore modifier et supprimer ses commentaires. | F11 | [services.ts:966](../server/src/services.ts) |
| R-04 | Moyen | Un administrateur peut retirer un autre administrateur. | B3 | [access.ts:106](../server/src/auth/access.ts), [services.ts:270](../server/src/services.ts) |
| R-05 | Moyen | Un projet archivé reste modifiable. | C2 | `require` |
| R-06 | Moyen | Un coéquipier IA n'est pas limité par le droit `ai.delegate` pour les règles : une règle automatique s'exécute quel que soit le profil de la personne qui crée la tâche. Choix à confirmer. | Lecture | [engine.ts](../server/src/ai/engine.ts) |
| R-07 | Moyen | Aucun profil système « Lecture seule ». Le rôle `viewer` ne limite que le projet : un Membre lecteur crée projets, équipes et imports. | P2b | [permissions.ts](../server/src/permissions.ts) |
| R-08 | Faible | `DELETE …/projects/:id/ai/rules/:ruleId` ignore le `:id` de l'adresse. Sans impact : les droits portent sur la règle. | Lecture | [app.ts:347](../server/src/app.ts) |

### 3.4 Entrées, secrets et configuration

| ID | Gravité | Constat | Preuve | Où |
| --- | --- | --- | --- | --- |
| S-01 | Moyen | Hôte SMTP libre : le serveur se connecte à `127.0.0.1` et au réseau interne (SSRF). | Audit précédent | [mail.ts:88](../server/src/mail.ts) |
| S-02 | Moyen | Certificat non vérifié vers Supabase (`rejectUnauthorized: false`). | Lecture | [db.ts:72](../server/src/db.ts) |
| S-03 | Moyen | `Secure` et HSTS dépendent de `NODE_ENV=production`. Sur le réseau sans cette variable, ni HTTPS ni cookie sécurisé ne sont exigés. | Lecture | [app.ts:54](../server/src/app.ts), [secrets.ts:52](../server/src/secrets.ts) |
| S-04 | Moyen | Un lien de réinitialisation reste valable après un changement de mot de passe. | C1 audit précédent | [service.ts:159](../server/src/auth/service.ts) |
| S-05 | Moyen | Consommation non atomique : code de secours, code TOTP, décision IA. Deux requêtes simultanées peuvent réussir sur PostgreSQL réel. | Lecture | [service.ts:125](../server/src/auth/service.ts), [engine.ts:309](../server/src/ai/engine.ts) |
| S-06 | Moyen | `auto_approve` supprime la validation humaine sur toutes les écritures, y compris face à une injection dans une pièce jointe. | Lecture | [engine.ts:247](../server/src/ai/engine.ts) |
| S-07 | Moyen | 2FA facultative pour les administrateurs ; la désactiver ne demande que le mot de passe. | Lecture | [service.ts:188](../server/src/auth/service.ts) |
| S-08 | Moyen | Validation incomplète : `color`, `icon`, `headline`, `summary`, `risks`, `domains` sans borne. 500 Ko acceptés comme couleur. | E1 | [app.ts:197](../server/src/app.ts), [app.ts:212](../server/src/app.ts), [app.ts:232](../server/src/app.ts) |
| S-09 | Faible | Caractère NUL ou numéro de tâche géant : erreur 500 au lieu de 400 (sans fuite d'information). `%` agit comme joker de recherche. | E1 | Routes, `listTasks` |
| S-10 | Faible | Clé dérivée par SHA-256 simple, sans rotation possible ; ancien secret public encore accepté en déchiffrement ; codes de secours hachés sans sel. | Lecture | [crypto.ts](../server/src/crypto.ts) |
| S-11 | Faible | Journaux de sécurité et tentatives jamais purgés ; adresses saisies stockées telles quelles. | Lecture | [service.ts](../server/src/auth/service.ts) |
| S-12 | Faible | Avec un SMTP réel, `forgot` attend l'envoi : la durée révèle si un compte existe. | Lecture | [provisioning.ts](../server/src/auth/provisioning.ts) |

**Bons points vérifiés.** Aucun secret dans les 14 commits de l'historique (seul un exemple du README). `.env` et `.cadence-secret` sont ignorés par Git. Mots de passe SMTP et secrets 2FA chiffrés. Démarrage refusé en cas de configuration dangereuse. Jetons et sessions stockés sous forme d'empreinte. Aucun `dangerouslySetInnerHTML` ; photos SVG refusées ; pièces jointes en bac à sable.

---

## 4. Structures de correction

Effort : **S** moins d'une demi-journée, **M** une à deux journées, **L** plusieurs jours. Chaque correction commence par un test qui échoue.

### Lot 1 — Bloquant avant toute ouverture à plusieurs clients

| ID | Correction | Test attendu | Effort |
| --- | --- | --- | --- |
| Q-02 | Commiter le travail en cours, découpé par sujet. | `git status` vide | S |
| T-01 | Table `org_invitations` (organisation, adresse, profil). Rattachement uniquement après **acceptation par le titulaire**. Adresse prouvée par un lien envoyé via le SMTP de la plateforme ; le lien n'est plus jamais affiché à un administrateur d'organisation. | Le scénario T-01 finit sans accès à A | L |
| T-02 | `setOrgMember` n'agit que sur un membre existant : 404 sinon, sans ajout. Photo modifiable seulement par la personne elle-même, agents IA créés par organisation. | Scénario B4 : 404, photo intacte | M |
| A-01 | Déplacer le contrôle de session en `onRequest` sur le périmètre privé. | Réponse 401 avant la fin du corps | S |
| R-01 | Rôle explicite = plafond. `joinTeam` soumis à un droit `teams.join`. | Scénario C1 : 403 après adhésion | M |

### Lot 2 — Barrières de défense

| ID | Correction | Test attendu | Effort |
| --- | --- | --- | --- |
| A-02 | Limites par session, par IP et par organisation ; quota IA ; `requestTimeout` ; plafond de connexions temps réel. | Au-delà du seuil : 429 | M |
| T-03 | `org_id NOT NULL` sur les tables métier listées en T-03 (hors `avatars`, rattachée au compte), clés étrangères composites `(org_id, id)`, politiques RLS avec `FORCE`, rôle applicatif non propriétaire, `SET LOCAL app.org_id` par transaction. | Scénario G3 refusé par la base ; requête sans contexte = 0 ligne | L |
| T-04 | Organisation demandée mais invalide : 409 explicite, sans repli. | Scénario B5 : 409 | S |
| Q-01 | Déclaration de droit obligatoire par route, refus par défaut, matrice de l'annexe A rejouée à chaque test. | Route sans droit déclaré = échec | M |

### Lot 3 — Invariants d'accès

| ID | Correction | Test attendu | Effort |
| --- | --- | --- | --- |
| R-02 | Créer les adresses sur événement ; GET sans écriture et soumis à `org.mail`. | Aucune écriture pendant un GET | S |
| R-03 | Exiger `tasks.comment` pour modifier et supprimer. | F11 : 403 | S |
| R-04 | Rang strict : pas d'action sur un pair, sauf propriétaire. | B3 : 403 | S |
| R-05 | Refuser toute écriture sur un projet archivé. | C2 : 409 | S |
| R-06, S-06 | Exclure les actions destructrices d'`auto_approve` ; plafonner par règle. | Injection : validation demandée | M |
| R-07 | Ajouter le profil système « Lecture seule ». | Matrice P2 : 0 écriture | S |
| T-05 | Vérifier que `before_id` et `after_id` sont dans le même projet. | B2 : 400 | S |
| R-08 | Vérifier la cohérence du `:id` de l'adresse. | Projet incohérent : 404 | S |

### Lot 4 — Authentification et configuration

| ID | Correction | Test attendu | Effort |
| --- | --- | --- | --- |
| S-04 | Annuler les liens de réinitialisation au changement de mot de passe. | Ancien lien : 400 | S |
| S-05 | Consommation atomique par `UPDATE … WHERE … RETURNING`. | Une seule réussite, testée sur PostgreSQL réel | S |
| S-07 | 2FA obligatoire pour les administrateurs ; code requis pour la désactiver. | Accès admin sans 2FA refusé | M |
| S-01 | Interdire les adresses privées, y compris après résolution DNS. | `127.0.0.1` : 400 | S |
| S-02 | Vérifier le certificat Supabase. | Certificat invalide : échec | S |
| S-03 | Exiger HTTPS dans `PUBLIC_URL` dès que le serveur est exposé. | Démarrage refusé | S |
| S-08, S-09 | Bornes sur tous les champs, refus du NUL, numéro de tâche borné, échappement de `%` et `_`. | Fuzz : aucune erreur 500 | S |
| S-10 à S-12 | HKDF et identifiant de clé, retrait de l'ancien secret, codes salés, purge planifiée, envoi `forgot` en arrière-plan. | Tests unitaires | M |

### Lot 5 — Dette et robustesse

| ID | Correction | Effort |
| --- | --- | --- |
| Q-05 | ESLint, Prettier, CI : typage, tests, audit des dépendances | S |
| Q-03, Q-04 | Découper `Services` par domaine, découper `updateTask` et `execute` | L |
| Q-06, Q-07 | Index manquants, requêtes groupées, cache des droits pour le temps réel | M |
| Q-08 | Bus et validations IA via PostgreSQL `LISTEN/NOTIFY` ou Redis | L |
| Q-09 | Journal en ajout seul, suppression logique, clés d'idempotence | M |
| Q-10 | Transactions sur les opérations à plusieurs écritures | S |
| Q-11, Q-12 | Messages d'outil assainis, fermeture ordonnée, code mort retiré | S |

### Décisions à prendre avant correction

| N° | Question | Proposition |
| --- | --- | --- |
| D1 | T-01 : l'affichage du lien à l'administrateur disparaît. Sans SMTP plateforme, comment inviter ? | SMTP plateforme obligatoire hors mode local |
| D2 | R-01 : un rôle explicite doit-il toujours plafonner les droits d'équipe ? | Oui |
| D3 | T-03 : migration complète du schéma maintenant ou par étapes ? | Par étapes : `org_id` et clés composites, puis RLS |
| D4 | T-02 : un compte peut-il appartenir à plusieurs organisations ? Les agents IA restent-ils partagés ? | Plusieurs organisations oui, sur acceptation ; agents créés par organisation |
| D5 | R-04 : un administrateur peut-il agir sur un autre administrateur ? | Non, propriétaire uniquement |
| D6 | R-06 : une règle IA suit-elle le droit de la personne qui la déclenche, ou de celle qui l'a créée ? | Celle qui l'a créée, droit vérifié à chaque exécution |

---

## Annexe A — Matrice complète

Codes HTTP réels. `P2a` lecteur strict, `P2b` lecteur membre, `P2c` lecteur invité, `P3` propriétaire externe, `P4a` propriétaire, `P4b` administrateur.

- Les routes `/api/org/*` agissent sur l'organisation de la session : pour P3, un 200 ou 400 porte sur l'organisation B, sauf T-02.
- `POST /api/orgs` n'est ouvert qu'en mode démo.
- Les routes `/api/admin/*` sont réservées à l'administrateur système : 403 attendu pour tous ces profils.
- Les routes de compte personnel (mot de passe, 2FA) renvoient 400 parce que le test envoie volontairement un mot de passe ou un code faux.

| Route | P1 | P2a | P2b | P2c | P3 | P4a | P4b |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `GET /api/me` | 401 | 200 | 200 | 200 | 200 | 200 | 200 |
| `GET /api/users` | 401 | 200 | 200 | 200 | 200 | 200 | 200 |
| `PUT /api/users/:id/avatar` | 401 | 403 | 403 | 403 | 403 | 403 | 403 |
| `DELETE /api/users/:id/avatar` | 401 | 403 | 403 | 403 | 403 | 403 | 403 |
| `GET /api/avatars/:id` | 401 | 404 | 404 | 404 | 404 | 404 | 404 |
| `GET /api/org/mail` | 401 | 403 | 403 | 403 | 200 | 200 | 200 |
| `PUT /api/org/mail` | 401 | 403 | 403 | 403 | 200 | 200 | 200 |
| `POST /api/org/mail/test` | 401 | 403 | 403 | 403 | 200 | 200 | 200 |
| `GET /api/org/mail/log` | 401 | 403 | 403 | 403 | 200 | 200 | 200 |
| `GET /api/org/mail/addresses` | 401 | 200 | 200 | 403 | 200 | 200 | 200 |
| `PATCH /api/org/mail/addresses/:id` | 401 | 403 | 403 | 403 | 404 | 200 | 200 |
| `POST /api/orgs` | 401 | 200 | 200 | 200 | 200 | 200 | 200 |
| `POST /api/orgs/:id/switch` | 401 | 200 | 200 | 200 | 403 | 200 | 200 |
| `PATCH /api/org` | 401 | 403 | 403 | 403 | 200 | 200 | 200 |
| `PUT /api/org/members/:userId` | 401 | 403 | 403 | 403 | 404 | 200 | 200 |
| `PUT /api/org/members/:userId/unit` | 401 | 403 | 403 | 403 | 200 | 200 | 200 |
| `GET /api/org/units` | 401 | 200 | 200 | 403 | 200 | 200 | 200 |
| `POST /api/org/units` | 401 | 403 | 403 | 403 | 200 | 200 | 200 |
| `PATCH /api/units/:id` | 401 | 403 | 403 | 403 | 403 | 200 | 200 |
| `DELETE /api/units/:id` | 401 | 403 | 403 | 403 | 403 | 200 | 200 |
| `GET /api/teams` | 401 | 200 | 200 | 200 | 200 | 200 | 200 |
| `POST /api/teams` | 401 | 403 | 200 | 403 | 200 | 200 | 200 |
| `GET /api/teams/:id` | 401 | 200 | 200 | 403 | 403 | 200 | 200 |
| `PATCH /api/teams/:id` | 401 | 403 | 403 | 403 | 403 | 200 | 200 |
| `PUT /api/teams/:id/members/:userId` | 401 | 403 | 403 | 403 | 403 | 200 | 200 |
| `POST /api/teams/:id/join` | 401 | 403 | 200 | 403 | 403 | 200 | 200 |
| `POST /api/team-requests/:id` | 401 | 403 | 403 | 403 | 403 | 200 | 200 |
| `GET /api/projects` | 401 | 200 | 200 | 200 | 200 | 200 | 200 |
| `POST /api/projects` | 401 | 403 | 200 | 403 | 200 | 200 | 200 |
| `GET /api/projects/:id` | 401 | 200 | 200 | 200 | 403 | 200 | 200 |
| `PATCH /api/projects/:id` | 401 | 403 | 403 | 403 | 403 | 200 | 200 |
| `DELETE /api/projects/:id` | 401 | 403 | 403 | 403 | 403 | 200 | 200 |
| `PUT /api/projects/:id/members/:userId` | 401 | 403 | 403 | 403 | 403 | 200 | 200 |
| `GET /api/projects/:id/tasks` | 401 | 200 | 200 | 200 | 403 | 200 | 200 |
| `GET /api/projects/:id/stats` | 401 | 200 | 200 | 200 | 403 | 200 | 200 |
| `GET /api/projects/:id/activity` | 401 | 200 | 200 | 200 | 403 | 200 | 200 |
| `GET /api/projects/:id/updates` | 401 | 200 | 200 | 200 | 403 | 200 | 200 |
| `POST /api/projects/:id/updates` | 401 | 403 | 403 | 403 | 403 | 200 | 200 |
| `POST /api/projects/:id/sections` | 401 | 403 | 403 | 403 | 403 | 200 | 200 |
| `PATCH /api/sections/:id` | 401 | 403 | 403 | 403 | 403 | 200 | 200 |
| `POST /api/sections/:id/move` | 401 | 403 | 403 | 403 | 403 | 200 | 200 |
| `DELETE /api/sections/:id` | 401 | 403 | 403 | 403 | 403 | 200 | 200 |
| `GET /api/tasks` | 401 | 200 | 200 | 200 | 200 | 200 | 200 |
| `POST /api/tasks` | 401 | 403 | 403 | 403 | 403 | 200 | 200 |
| `POST /api/projects/:id/tasks/bulk` | 401 | 403 | 403 | 403 | 403 | 200 | 200 |
| `GET /api/tasks/:id` | 401 | 200 | 200 | 200 | 403 | 200 | 200 |
| `PATCH /api/tasks/:id` | 401 | 403 | 403 | 403 | 403 | 200 | 200 |
| `POST /api/tasks/:id/move` | 401 | 403 | 403 | 403 | 403 | 200 | 200 |
| `POST /api/tasks/:id/duplicate` | 401 | 403 | 403 | 403 | 403 | 200 | 200 |
| `POST /api/tasks/:id/move-project` | 401 | 403 | 403 | 403 | 403 | 200 | 200 |
| `DELETE /api/tasks/:id` | 401 | 403 | 403 | 403 | 403 | 200 | 200 |
| `POST /api/tasks/:id/comments` | 401 | 403 | 403 | 403 | 403 | 200 | 200 |
| `PATCH /api/comments/:id` | 401 | 403 | 403 | 403 | 403 | 200 | 403 |
| `DELETE /api/comments/:id` | 401 | 403 | 403 | 403 | 403 | 200 | 200 |
| `POST /api/tasks/:id/attachments` | 401 | 403 | 403 | 403 | 403 | 200 | 200 |
| `GET /api/attachments/:id` | 401 | 200 | 200 | 200 | 403 | 200 | 200 |
| `GET /api/attachments/:id/preview` | 401 | 200 | 200 | 200 | 403 | 200 | 200 |
| `POST /api/comments/:id/attachments` | 401 | 403 | 403 | 403 | 403 | 200 | 200 |
| `DELETE /api/attachments/:id` | 401 | 403 | 403 | 403 | 403 | 200 | 200 |
| `POST /api/import/analyze` | 401 | 403 | 200 | 403 | 200 | 200 | 200 |
| `POST /api/import/create` | 401 | 403 | 200 | 403 | 200 | 200 | 200 |
| `GET /api/notifications` | 401 | 200 | 200 | 200 | 200 | 200 | 200 |
| `POST /api/notifications/read` | 401 | 200 | 200 | 200 | 200 | 200 | 200 |
| `GET /api/search` | 401 | 200 | 200 | 200 | 200 | 200 | 200 |
| `GET /api/ai/status` | 401 | 200 | 200 | 200 | 200 | 200 | 200 |
| `GET /api/ai/agents` | 401 | 200 | 200 | 200 | 200 | 200 | 200 |
| `POST /api/tasks/:id/ai/run` | 401 | 403 | 403 | 403 | 403 | 200 | 200 |
| `POST /api/ai/chat` | 401 | 403 | 200 | 200 | 200 | 200 | 200 |
| `GET /api/ai/runs` | 401 | 200 | 200 | 200 | 200 | 200 | 200 |
| `GET /api/ai/runs/:id` | 401 | 200 | 200 | 200 | 403 | 200 | 200 |
| `POST /api/ai/runs/:id/cancel` | 401 | 403 | 403 | 403 | 403 | 200 | 200 |
| `GET /api/ai/approvals` | 401 | 200 | 200 | 200 | 200 | 200 | 200 |
| `POST /api/ai/approvals/:id` | 401 | 403 | 403 | 403 | 403 | 200 | 200 |
| `POST /api/tasks/:id/ai/subtasks` | 401 | 403 | 403 | 403 | 403 | 200 | 200 |
| `POST /api/tasks/:id/ai/description` | 401 | 403 | 403 | 403 | 403 | 200 | 200 |
| `POST /api/projects/:id/ai/status` | 401 | 403 | 403 | 403 | 403 | 200 | 200 |
| `POST /api/projects/:id/ai/parse` | 401 | 403 | 403 | 403 | 403 | 200 | 200 |
| `GET /api/projects/:id/ai/rules` | 401 | 200 | 200 | 200 | 403 | 200 | 200 |
| `POST /api/projects/:id/ai/rules` | 401 | 403 | 403 | 403 | 403 | 200 | 200 |
| `DELETE /api/projects/:id/ai/rules/:ruleId` | 401 | 403 | 403 | 403 | 403 | 200 | 200 |
| `GET /api/auth/sessions` | 401 | 200 | 200 | 200 | 200 | 200 | 200 |
| `DELETE /api/auth/sessions/:id` | 401 | 200 | 200 | 200 | 200 | 200 | 200 |
| `POST /api/auth/password` | 401 | 400 | 400 | 400 | 400 | 400 | 400 |
| `POST /api/auth/mfa/setup` | 401 | 200 | 200 | 200 | 200 | 200 | 200 |
| `POST /api/auth/mfa/confirm` | 401 | 400 | 400 | 400 | 400 | 400 | 400 |
| `POST /api/auth/mfa/disable` | 401 | 400 | 400 | 400 | 400 | 400 | 400 |
| `GET /api/org/invitations` | 401 | 403 | 403 | 403 | 200 | 200 | 200 |
| `POST /api/org/invitations` | 401 | 403 | 403 | 403 | 400 | 200 | 200 |
| `POST /api/org/invitations/:id/resend` | 401 | 403 | 403 | 403 | 404 | 200 | 200 |
| `DELETE /api/org/invitations/:id` | 401 | 403 | 403 | 403 | 404 | 200 | 200 |
| `GET /api/invitations` | 401 | 200 | 200 | 200 | 200 | 200 | 200 |
| `POST /api/invitations/:id/accept` | 401 | 404 | 404 | 404 | 404 | 404 | 404 |
| `POST /api/invitations/:id/decline` | 401 | 404 | 404 | 404 | 404 | 404 | 404 |
| `GET /api/org/permissions` | 401 | 200 | 200 | 200 | 200 | 200 | 200 |
| `GET /api/org/profiles` | 401 | 403 | 403 | 403 | 200 | 200 | 200 |
| `POST /api/org/profiles` | 401 | 403 | 403 | 403 | 200 | 200 | 200 |
| `PATCH /api/org/profiles/:id` | 401 | 403 | 403 | 403 | 400 | 200 | 200 |
| `DELETE /api/org/profiles/:id` | 401 | 403 | 403 | 403 | 400 | 200 | 200 |
| `PUT /api/org/members/:userId/profile` | 401 | 403 | 403 | 403 | 404 | 200 | 200 |
| `GET /api/org/members/:userId/access` | 401 | 403 | 403 | 403 | 404 | 200 | 200 |
| `PUT /api/org/members/:userId/permissions` | 401 | 403 | 403 | 403 | 404 | 200 | 200 |
| `GET /api/admin/users` | 401 | 403 | 403 | 403 | 403 | 403 | 403 |
| `GET /api/admin/orgs` | 401 | 403 | 403 | 403 | 403 | 403 | 403 |
| `GET /api/admin/events` | 401 | 403 | 403 | 403 | 403 | 403 | 403 |
| `GET /api/admin/settings` | 401 | 403 | 403 | 403 | 403 | 403 | 403 |
| `PATCH /api/admin/settings` | 401 | 403 | 403 | 403 | 403 | 403 | 403 |
| `POST /api/admin/users/:id/approve` | 401 | 403 | 403 | 403 | 403 | 403 | 403 |
| `POST /api/admin/users/:id/reject` | 401 | 403 | 403 | 403 | 403 | 403 | 403 |
| `POST /api/admin/users/:id/suspend` | 401 | 403 | 403 | 403 | 403 | 403 | 403 |
| `POST /api/admin/users/:id/reactivate` | 401 | 403 | 403 | 403 | 403 | 403 | 403 |
| `POST /api/admin/users/:id/revoke-sessions` | 401 | 403 | 403 | 403 | 403 | 403 | 403 |
| `POST /api/admin/users/:id/reset` | 401 | 403 | 403 | 403 | 403 | 403 | 403 |
| `PUT /api/admin/users/:id/platform-role` | 401 | 403 | 403 | 403 | 403 | 403 | 403 |
