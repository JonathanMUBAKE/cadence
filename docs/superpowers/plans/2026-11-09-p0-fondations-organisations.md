# P0 · Fondations : PostgreSQL, organisations et hiérarchie (plan d'implémentation)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** porter Cadence sur PostgreSQL (Supabase en production, PGlite en test) et organiser le travail en organisations → entités hiérarchiques → équipes → projets, avec des droits effectifs calculés en cascade.

**Architecture :**
- `server/src/db.ts` expose une interface asynchrone `Db` : `query`, `one`, `exec` et `tx`. Deux implémentations :
  - `PgDb`, sur le `Pool` de `pg`, pour Supabase ;
  - `PgliteDb`, avec PostgreSQL embarqué, pour les tests et la démo.
- Les migrations sont des fichiers SQL versionnés, suivis dans la table `schema_migrations`.
- Tous les services deviennent `async`.
- Le rôle effectif d'un utilisateur sur un projet est calculé par une seule requête SQL : la plus forte de cinq sources (rôle d'organisation, adhésion explicite, appartenance à l'équipe, supervision hiérarchique, équipe publique).

**Tech Stack :** PostgreSQL 15+ (Supabase), `pg` 8, `@electric-sql/pglite` 0.5, Fastify 5, React 19.

**Spec :** `docs/specs/2026-11-09-parite-asana.md` (§1.4, §3)

## Global Constraints
- Le même SQL tourne sur PGlite et sur Supabase. On n'utilise ni extension ni fonctionnalité propre à Supabase.
- Les dates calendaires sont en `date` (renvoyées en `AAAA-MM-JJ`), les horodatages en `timestamptz` (renvoyés en ISO 8601), les listes en `jsonb`.
- Clé de projet : `^[A-Z][A-Z0-9]{1,9}$`, unique dans l'organisation. Les numéros de tâche sont attribués par projet, dans une transaction.
- Rangs des rôles : `viewer` 1 < `commenter` 2 < `editor` 3 < `admin` 4. Le rôle effectif est le maximum de ces sources :
  - `owner` ou `admin` de l'organisation → `admin` ;
  - adhésion explicite au projet → son rôle ;
  - accès « équipe » : chef d'équipe → `admin`, membre de l'équipe → `editor` ;
  - responsable d'une entité ancêtre (ou égale) de celle de l'équipe → `viewer` ;
  - équipe publique avec accès « équipe », et membre non invité de l'organisation → `viewer`.
- Un invité (`guest`) n'obtient de droits que par adhésion explicite.

## Review Focus
1. **Cycle dans la hiérarchie** : déplacer une entité sous l'une de ses descendantes doit être refusé (400), sinon la requête récursive tourne sans fin.
2. **Fuite entre organisations** : une recherche, une liste d'utilisateurs ou un outil de l'IA ne doit jamais renvoyer un objet d'une autre organisation, même si l'identifiant est connu.
3. **Équipe privée** : un responsable d'entité voit les projets de sa branche, mais jamais ceux d'une équipe privée dont il n'est pas membre.
4. **Numéros de tâche concurrents** : deux créations simultanées dans un projet ne doivent pas obtenir le même numéro.
5. **Suppression d'une entité non vide** : refusée tant qu'elle a des sous-entités, des équipes ou des personnes rattachées.

### Task 1 : couche PostgreSQL et migrations
Files : `server/src/db.ts`, `server/migrations/001_init.sql`
- [ ] Tests : une migration n'est appliquée qu'une fois ; `tx` annule tout en cas d'erreur ; les dates reviennent sous forme `AAAA-MM-JJ`.
- [ ] Implémentation `PgliteDb` et `PgDb`, choisie par `DATABASE_URL` (absent = PGlite, en mémoire ou dans `DATA_DIR`).

### Task 2 : services asynchrones, organisations, entités, équipes, droits effectifs
Files : `server/src/services.ts`, `server/src/org.ts`
- [ ] Tests :
  - rôle effectif pour chaque source ;
  - cycle d'entités refusé ;
  - équipe privée invisible au responsable d'entité ;
  - isolation entre organisations ;
  - clés `APP-12` et numérotation par projet ;
  - demande d'adhésion à une équipe « sur demande ».

### Task 3 : IA, seed et API sur la nouvelle base
Files : `server/src/ai/*.ts`, `server/src/seed.ts`, `server/src/app.ts`
- [ ] Les 23 tests existants repassent, adaptés à l'asynchrone et aux clés de tâche.

### Task 4 : interface
Files :
- `web/src/components/Sidebar.tsx` : sélecteur d'organisation, projets groupés par équipe ;
- `web/src/pages/Organization.tsx` : organigramme des entités, avec édition ;
- `web/src/pages/Team.tsx` ;
- `web/src/components/dialogs.tsx` : création de projet avec équipe, clé et accès.
- [ ] Étapes e2e : changer d'organisation, ouvrir l'organigramme, créer une entité enfant, rejoindre une équipe.

### Task 5 : déploiement sur Supabase
Files : `README.md`, `.env.example`
- [ ] Documentation : `DATABASE_URL` (pooler en mode session), commande `npm run migrate`, et sauvegarde.
