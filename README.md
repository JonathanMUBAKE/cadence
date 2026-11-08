# Prototype : une IA embarquée façon Asana

Un petit projet Python qui reprend les idées de l'IA d'Asana (AI Teammates, AI Studio) :
un agent IA qui est un **membre de l'équipe** dans un outil de gestion de projet. Il
lit le graphe de travail, agit avec ses propres droits, demande une validation
avant d'écrire et journalise tout ce qu'il fait.

## Comment fonctionne l'IA d'Asana (ce qu'on en sait publiquement)

| Brique Asana | Rôle | Dans ce prototype |
|---|---|---|
| **Work Graph** | Modèle de données qui relie tâches, projets, objectifs, personnes. C'est la *source de contexte* de l'IA : Asana a commencé par lui, pas par une base vectorielle. | `teammate/work_graph.py` (SQLite) |
| **Récupération « filtrer d'abord »** | Le LLM traduit la question (« tâches en retard du projet X ») en **filtres structurés**. La base filtre, puis on trie et on résume avant d'appeler le LLM final. | outil `search_tasks` avec filtres |
| **AI Teammates** | Agents qu'on **assigne à une tâche** comme un collègue. Ils montrent leur démarche et acceptent des retours. | `AITeammate.work_on_task`, `run_inbox` |
| **Checkpoints** | Un humain valide ou ajuste une action avant qu'elle soit exécutée. | `approver` sur chaque outil d'écriture |
| **Contrôles / permissions** | L'agent a des droits explicites dans le graphe, comme un utilisateur. Les admins choisissent les données accessibles. | `memberships` + `PermissionDenied` |
| **Mémoire** | Chaque souvenir est rattaché à un objet du graphe (projet, document). Ce lien sert à le retrouver et à appliquer les droits. | table `memories`, outil `remember` |
| **Transparence** | On voit où l'IA intervient et ce qu'elle a fait. | `audit_log` + compte rendu publié en commentaire |
| **AI Studio (Smart workflows)** | Règles no-code *déclencheur → conditions → actions*, avec des étapes IA écrites en langage naturel. | `run_inbox` sert de déclencheur (à étendre) |

## Architecture

```
 Déclencheur (tâche assignée à l'IA, règle, @mention)
        │
        ▼
 Construction du contexte ── Work Graph : tâche + projet + objectif
        │                    + sous-tâches + commentaires + mémoires
        ▼                    (filtré par les DROITS de l'agent)
 Boucle agent (LLM + outils)
   ├─ outils de lecture  : search_tasks, get_task, list_users      → exécution directe
   └─ outils d'écriture  : add_comment, create_task, update_task,  → CHECKPOINT humain
                           remember                                   puis exécution
        │
        ▼
 Journal d'audit + compte rendu publié sur la tâche (transparence)
```

## Lancer

```bash
pip install anthropic pytest
export ANTHROPIC_API_KEY=...        # ou `ant auth login`

python main.py run                  # Atlas traite ses tâches, vous validez chaque écriture
python main.py run --auto           # validation automatique
python main.py ask "Quelles tâches sont en retard et pourquoi ?" --as alice
python main.py ask "Résume le projet RH" --as bob   # → accès refusé, Bob n'est pas membre

python -m pytest -q                 # tests hors ligne (pas d'appel API)
```

## Pistes pour aller plus loin

1. **Déclencheurs événementiels** : webhooks « tâche assignée à l'IA » ou « @atlas dans un
   commentaire » au lieu de `run_inbox`.
2. **Smart workflows à la AI Studio** : stocker des règles `{trigger, conditions, instructions IA, actions autorisées}` et faire tourner l'agent avec seulement ces outils.
3. **Politiques de checkpoint** : valider automatiquement les actions à faible risque
   (commentaire) et demander une validation pour les autres (réassigner, clôturer).
4. **Plus de contexte** : recherche plein texte ou embeddings sur les documents joints, en
   gardant le filtrage par droits **avant** la recherche.
5. **Interface** : afficher les étapes de l'agent en direct (streaming) dans la tâche.
