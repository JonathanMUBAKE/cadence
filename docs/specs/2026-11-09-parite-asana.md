# Cadence : spécification de parité avec Asana (toutes offres) et extensions

> Spécification de référence. Elle décrit **comment Asana fonctionne**, liste **toutes ses fonctionnalités jusqu'à Enterprise+**, indique où en est Cadence pour chacune, et ajoute ce qu'Asana n'a pas mais que nous voulons : connecteurs Nextcloud, Jitsi, Mattermost et IMAP, conservation légale, DLP natif.
> Chaque chantier fait l'objet d'un plan d'implémentation séparé dans `docs/superpowers/plans/`.

**Sources** : recherche web du 9 novembre 2026 (pages publiques d'Asana, documentation développeurs, guides de partenaires). Les sources tierces se contredisent parfois sur le palier exact d'une fonction ; dans ce cas, le palier indiqué est le plus probable et marqué « ? ». Asana.com n'était pas accessible depuis l'environnement de développement : les pages officielles ont été lues via les résultats de recherche.

---

## 1. Comment Asana fonctionne

### 1.1 Le Work Graph

Tout Asana repose sur un modèle de données unique, le **Work Graph**. Ce modèle relie :
- les objets de travail : tâches, sous-tâches, projets, portefeuilles et objectifs ;
- les personnes et les équipes qui y travaillent ;
- les échanges : commentaires et pièces jointes.

Trois principes en découlent :
- **Une tâche peut vivre dans plusieurs projets** (multi-homing) : il n'y a pas de copie, c'est le même objet partout.
- **La hiérarchie stratégique remonte jusqu'aux objectifs** : une tâche appartient à un projet, le projet à un portefeuille, le portefeuille sert un objectif. Les objectifs de l'entreprise se déclinent en objectifs d'équipe.
- **Les métadonnées sont partagées** : les champs personnalisés sont définis une fois dans une bibliothèque et réutilisés dans les projets et portefeuilles.

### 1.2 L'IA (Asana AI, AI Studio, AI Teammates)

- **Contexte d'abord** : l'IA part du Work Graph plutôt que d'une base vectorielle. Une question est traduite en filtres structurés (périmètre, dates, statut), la base filtre, puis le modèle trie et résume.
- **AI Teammates** : ce sont des agents qu'on assigne comme des collègues. Ils ont leurs propres droits dans le graphe, une mémoire rattachée aux objets, et des *checkpoints* : un humain valide ou corrige une action avant qu'elle soit exécutée.
- **AI Studio (Smart workflows)** : des règles sans code, de la forme déclencheur, conditions puis actions, avec des étapes IA écrites en langage naturel. Leur consommation est mesurée en crédits selon l'offre.
- **Autres fonctions IA** : chat sur le travail, résumés, points d'avancement générés, champs intelligents, rédaction.
- **Gouvernance** : les administrateurs choisissent les données accessibles à l'IA, les équipes qui y ont droit et le budget de crédits.

### 1.3 Les paliers

Prix publics annuels, par utilisateur et par mois :

| Offre | Prix | Ce qui la caractérise |
|---|---|---|
| Personal | gratuit | listes, tableau, calendrier, équipe très réduite |
| Starter | ~10,99 $ | chronologie (Gantt), tableaux de bord, formulaires, champs personnalisés, règles, invités illimités |
| Advanced | ~24,99 $ | objectifs, portefeuilles, charge de travail, validations et relecture d'épreuves, suivi du temps, formules, reporting élargi |
| Enterprise | sur devis | SAML, SCIM, planification de capacité ?, licences lecture seule, contrôle des invitations d'invités, administration avancée |
| Enterprise+ | sur devis | API du journal d'audit (pour un SIEM), intégration DLP (Netskope), résidence des données, clés de chiffrement gérées par le client (EKM), conformité HIPAA, rétention avancée |

---

## 2. Catalogue fonctionnel et état de Cadence

Légende de la colonne Cadence :
- **Fait** : implémenté et testé ;
- **Partiel** : une partie existe ;
- **À faire** : rien n'existe encore.

### 2.1 Travail : tâches et projets

| Fonctionnalité | Palier Asana | Cadence | Chantier |
|---|---|---|---|
| Tâches, sous-tâches, responsable, échéance, description | Personal | Fait | — |
| Date de début, heures précises d'échéance | Personal | Partiel (date de début sans heure) | P3 |
| Commentaires, @mentions, « j'aime » | Personal | Partiel (pas de « j'aime ») | P3 |
| Abonnés (collaborateurs) d'une tâche | Personal | À faire | P3 |
| Pièces jointes (envoi et liens cloud) | Personal | À faire | P2 |
| Tâches récurrentes | Personal | À faire | P3 |
| Multi-homing (une tâche dans plusieurs projets) | Personal | À faire | P3 |
| Types de tâche : jalon, validation | Starter / Advanced | À faire | P3 |
| Dépendances (bloquée par, bloque) et décalage automatique des dates | Starter | À faire | P3 |
| Champs personnalisés (texte, nombre, liste, multi-choix, date, personne, devise, %) et bibliothèque | Starter | À faire | P3 |
| Champs formule | Advanced | À faire | P3 |
| Sections, vues Liste, Tableau, Calendrier | Personal | Fait | — |
| Vue Chronologie / Gantt | Starter | Partiel (lecture seule, pas de dépendances) | P3 |
| Modèles de projet, duplication | Starter | Partiel (modèles de sections seulement) | P3 |
| Note de projet (brief) et ressources clés | Starter | À faire | P3 |
| Points d'avancement de projet | Starter | Fait (avec génération IA) | — |
| Messages de projet et d'équipe | Personal | À faire | P3 |
| Équipes et pages d'équipe | Personal | À faire | P3 |
| Invités | Personal | À faire | P1 |
| Licences lecture seule | Enterprise | Partiel (rôle lecteur par projet) | P1 |
| Mes tâches, Boîte de réception | Personal | Fait | — |
| Recherche avancée, recherches enregistrées | Starter | Partiel (recherche simple) | P3 |
| Modification en masse | Starter | À faire | P3 |
| Préférences de notification | Personal | À faire | P2 |

### 2.2 Automatisation

| Fonctionnalité | Palier Asana | Cadence | Chantier |
|---|---|---|---|
| Règles : déclencheur, conditions, branches, actions, variables | Starter | Partiel (règles IA seulement) | P4 |
| Bundles (lots de règles, champs et sections réutilisables) | Advanced | À faire | P4 |
| Formulaires (logique de branchement, lien public, création de tâche) | Starter | À faire | P4 |
| Workflow builder (étapes de travail) | Starter | À faire | P4 |
| Déclencheur par requête web entrante | Advanced | À faire | P4 |
| Quotas d'actions par offre | — | À faire | P4 |

### 2.3 Stratégie, ressources et reporting

| Fonctionnalité | Palier Asana | Cadence | Chantier |
|---|---|---|---|
| Portefeuilles (imbriqués, champs, statuts, chronologie) | Advanced | À faire | P5 |
| Objectifs (OKR, sous-objectifs, progression automatique, points d'étape) | Advanced | À faire | P5 |
| Charge de travail (effort, capacité par personne) | Advanced | Partiel (charge par personne au tableau de bord) | P5 |
| Planification de capacité (postes provisoires, allocations) | Enterprise ? | À faire | P5 |
| Suivi du temps (estimé, réel, feuilles de temps) | Advanced | À faire | P5 |
| Tableaux de bord personnalisables et reporting universel (tous objets) | Starter / Advanced | Partiel (tableau de bord fixe par projet) | P5 |
| Validations formelles (approuver, demander des changements, refuser) | Advanced | Partiel (validations des actions IA) | P5 |
| Relecture d'épreuves (annotations sur image et PDF) | Advanced | À faire | P5 |

### 2.4 IA

| Fonctionnalité | Palier Asana | Cadence | Chantier |
|---|---|---|---|
| Coéquipiers IA assignables, avec droits, mémoire et checkpoints | Advanced+ | Fait | — |
| Chat IA sur le travail | Starter+ | Fait | — |
| Smart workflows / AI Studio (étapes IA dans les règles) | Starter+ (crédits) | Partiel (règles IA) | P4 |
| Résumés, points d'avancement, sous-tâches, rédaction | Starter+ | Fait | — |
| Champs intelligents (classement automatique d'un champ) | Advanced | À faire | P6 |
| Crédits IA et quotas par offre ou équipe | tous | À faire | P6 |
| Gouvernance IA (activation par équipe, données accessibles, journal) | Enterprise | Partiel (journal des interventions) | P1 + P6 |
| Agents agissant dans les outils connectés (Google, Microsoft, Slack) | Enterprise ? | À faire | P2 + P6 |
| Serveur MCP exposant Cadence à Claude et à d'autres agents | (Asana propose un MCP) | À faire | P6 |

### 2.5 Administration, sécurité et conformité

| Fonctionnalité | Palier Asana | Cadence | Chantier |
|---|---|---|---|
| Console d'administration (membres, équipes, invités, licences) | Starter+ | À faire | P1 |
| Rôles d'administration (super admin, admin, propriétaire de facturation) | Enterprise | À faire | P1 |
| Rôles personnalisés (RBAC fin) | Enterprise | À faire | P7 |
| Désactivation et réactivation de membres, export CSV | Starter+ | À faire | P1 |
| Comptes, mots de passe, politique de mot de passe | — | À faire (connexion de démo) | P1 |
| Double authentification (TOTP), obligation par organisation | Starter+ | À faire | P1 |
| Google SSO, SAML 2.0, OIDC | Enterprise | À faire | P1 |
| Provisionnement SCIM 2.0 | Enterprise | À faire | P1 |
| Durée de session, révocation des sessions | Enterprise | À faire | P1 |
| Liste d'adresses IP autorisées | (extension Cadence) | À faire | P1 |
| Contrôle des invitations d'invités (domaines autorisés) | Enterprise | À faire | P1 |
| Gestion des applications et connecteurs autorisés | Enterprise | À faire | P1 + P2 |
| Journal d'audit et API compatible SIEM (rétention de 90 jours chez Asana) | Enterprise+ | Partiel (journal d'activité et des actions IA) | P1 |
| Intégration DLP (Netskope chez Asana) | Enterprise+ | À faire (DLP natif) | P1 |
| Clés de chiffrement gérées par le client (EKM) | Enterprise+ | À faire | P1 |
| Résidence des données | Enterprise+ | À faire (choix de région au déploiement) | P7 |
| HIPAA | Enterprise+ | Hors code : processus et contrats ; le chiffrement, l'audit et la rétention P1 en sont les prérequis techniques | — |
| Sécurité mobile (biométrie, captures d'écran, Intune) | Enterprise | À faire (PWA d'abord) | P7 |
| Annonces d'administration | Enterprise | À faire | P1 |
| Export des données, rétention, conservation légale, effacement RGPD | (extension Cadence) | À faire | P1 |
| Comptes de service, jetons personnels, applications OAuth (dont la lecture de l'API d'audit par jeton) | Enterprise+ | À faire (P1 fournit la diffusion vers un SIEM par webhook signé) | P7 |

### 2.6 Intégrations et connecteurs

Asana propose Slack, Microsoft Teams, Zoom, Google Drive, OneDrive, Dropbox, Box, Gmail et Outlook. Nous ajoutons les équivalents souverains ou libres.

| Catégorie | Connecteurs | Fonctions | Chantier |
|---|---|---|---|
| Messagerie instantanée | Slack, Microsoft Teams, Google Chat, Mattermost, Rocket.Chat | Publier les événements d'un projet dans un canal ; créer une tâche depuis un message (commande `/cadence`) ; aperçu enrichi des liens ; valider ou refuser une action IA depuis la messagerie | P2 |
| Visioconférence | Zoom, Microsoft Teams, Google Meet, Webex, Jitsi, BigBlueButton | Planifier une réunion depuis une tâche ou un projet ; rattacher l'enregistrement et la transcription ; extraire par IA les actions de la réunion pour en faire des tâches | P2 |
| Stockage de fichiers | Nextcloud (WebDAV, OCS), OneDrive / SharePoint (Graph), Google Drive, Dropbox, Box | Joindre un fichier cloud, avec versions ; créer un dossier par projet ; envoyer une pièce jointe vers un dossier par règle ; aperçus | P2 |
| E-mail | SMTP, IMAP, Gmail API, Microsoft Graph Mail, webhooks entrants (Mailgun, Postmark, SendGrid) | Notifications et résumé quotidien ; adresse e-mail par projet qui crée des tâches ; réponse par e-mail qui devient un commentaire ; convertir un e-mail en tâche | P2 |
| Calendrier | Flux ICS, Google Calendar, Outlook, CalDAV | Échéances dans le calendrier ; créneaux de réunion | P2 |
| Plateforme | API REST publique, webhooks sortants, OAuth | Compatibilité Zapier, Make et n8n | P7 |

---

## 3. Architecture cible

1. **Une organisation, une instance**. Le modèle `organizations` arrive en P1, mono-locataire d'abord. Le multi-locataire viendra en P7 avec Postgres.
2. **Tout passe par les services**. Chaque action est exécutée au nom d'un acteur (humain, IA, compte de service, connecteur ou système). Les droits sont vérifiés et un événement est émis sur le bus. Le journal d'audit, le temps réel, les règles et les connecteurs s'abonnent au bus.
3. **Journal d'audit en chaîne de hachage**. Chaque événement contient le hachage du précédent : une modification a posteriori est donc détectable. L'export se fait au format de l'API d'audit d'Asana (filtres `start_at`, `end_at`, `event_type`, `actor_*`, `resource_*`) pour être compatible avec un SIEM.
4. **Secrets chiffrés par enveloppe**. Une clé de chiffrement par donnée, elle-même chiffrée par une clé maîtresse. La clé maîtresse vient d'un fournisseur de clés : clé locale, HashiCorp Vault Transit ou AWS KMS. C'est la base de l'EKM : révoquer la clé maîtresse rend les secrets illisibles.
5. **Connecteurs par définition déclarative** et 5 briques communes, décrites dans le plan P2 :
   - un courtier OAuth2 avec PKCE ;
   - un coffre de jetons chiffrés ;
   - une file de tâches persistante avec reprises ;
   - des webhooks entrants signés ;
   - un client HTTP qui journalise chaque appel.
6. **IA** : chaque outil exposé à l'IA reste soumis aux droits et aux checkpoints. Les connecteurs deviennent de nouveaux outils, comme « publier dans Slack » ou « créer une réunion ».

---

## 4. Feuille de route

| Chantier | Contenu | Plan |
|---|---|---|
| **P1 · Administration, audit et sécurité** | organisation, rôles d'administration, comptes et mots de passe, double authentification, sessions, liste IP, SSO OIDC et SAML, SCIM, journal d'audit chaîné et export SIEM, DLP, chiffrement par enveloppe et EKM, export, rétention, conservation légale, RGPD, annonces, console d'administration | `docs/superpowers/plans/2026-11-09-p1-administration-audit-securite.md` |
| **P2 · Connecteurs** | cadre commun (courtier OAuth, coffre de jetons, file de tâches, webhooks, catalogue administrable), pièces jointes, messagerie, visioconférence, stockage, e-mail, calendrier | `docs/superpowers/plans/2026-11-09-p2-connecteurs.md` |
| P3 · Parité travail | champs personnalisés et formules, dépendances et décalage automatique, multi-homing, jalons, tâches récurrentes, abonnés, « j'aime », modèles complets, note de projet, messages, équipes, invités, recherche avancée, modification en masse | à écrire au démarrage de P3 |
| P4 · Automatisation | constructeur de règles avec branches et variables, bundles, formulaires publics avec branchement, workflow builder, déclencheur web entrant, quotas | à écrire |
| P5 · Stratégie et ressources | portefeuilles, objectifs OKR, charge de travail et effort, planification de capacité, suivi du temps, tableaux de bord personnalisables, validations formelles, relecture d'épreuves | à écrire |
| P6 · IA avancée | champs intelligents, crédits et quotas, gouvernance fine, agents agissant via les connecteurs, serveur MCP, évaluation de la qualité des agents | à écrire |
| P7 · Plateforme | API publique et OAuth, webhooks sortants, PWA hors ligne et sécurité mobile, multilingue, Postgres et multi-locataire, résidence des données, observabilité, sauvegardes | à écrire |

Les chantiers sont livrés dans cet ordre, sauf décision contraire : la sécurité d'abord, car SSO, audit et chiffrement conditionnent les connecteurs, qui manipulent des jetons tiers.

## 5. Exigences transverses

- Node.js 22 ou plus, TypeScript strict, Fastify 5, React 19. Pas de dépendance native à compiler, sauf si elle est justifiée dans le plan.
- Chaque action d'écriture produit un événement d'audit. Aucun secret ne doit apparaître en clair dans la base, les journaux ou les réponses d'API.
- Chaque fonctionnalité est livrée avec des tests Vitest (API) et, si elle a une interface, une étape dans `scripts/e2e.mjs`.
- Interface en français, utilisable sur mobile, en thème clair et sombre. Le système de design existant est celui de `web/src/styles.css`.
- Les connecteurs sont testés sans réseau, avec des serveurs simulés (`undici` MockAgent ou serveur HTTP local). Les identifiants réels ne sont fournis qu'en configuration.
