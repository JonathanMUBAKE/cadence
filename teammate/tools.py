"""Outils exposés au LLM. Chaque appel s'exécute AU NOM de l'agent (ses droits)."""

from __future__ import annotations

import json

from .work_graph import PermissionDenied, WorkGraph

READ_TOOLS = [
    {
        "name": "search_tasks",
        "description": (
            "Recherche des tâches dans le Work Graph avec des filtres structurés. "
            "Traduis la demande en filtres (projet, assigné, terminé, en retard, texte) "
            "plutôt que de tout lister. Ne renvoie que ce que tu as le droit de voir."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "project_id": {"type": "string"},
                "assignee_id": {"type": "string"},
                "completed": {"type": "boolean"},
                "overdue": {"type": "boolean", "description": "Non terminées et échéance dépassée"},
                "text": {"type": "string", "description": "Mot-clé dans le nom ou les notes"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 50},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "get_task",
        "description": "Détail d'une tâche avec son projet, l'objectif, ses sous-tâches et ses commentaires.",
        "input_schema": {
            "type": "object",
            "properties": {"task_id": {"type": "string"}},
            "required": ["task_id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "list_users",
        "description": "Liste des membres (id, nom) pour savoir à qui assigner ou qui mentionner.",
        "input_schema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
]

WRITE_TOOLS = [
    {
        "name": "add_comment",
        "description": "Publie un commentaire sur une tâche (visible par l'équipe).",
        "input_schema": {
            "type": "object",
            "properties": {"task_id": {"type": "string"}, "body": {"type": "string"}},
            "required": ["task_id", "body"],
            "additionalProperties": False,
        },
    },
    {
        "name": "create_task",
        "description": "Crée une tâche ou une sous-tâche (parent_id) dans un projet.",
        "input_schema": {
            "type": "object",
            "properties": {
                "project_id": {"type": "string"},
                "name": {"type": "string"},
                "notes": {"type": "string"},
                "assignee_id": {"type": "string"},
                "due_on": {"type": "string", "description": "AAAA-MM-JJ"},
                "parent_id": {"type": "string"},
            },
            "required": ["project_id", "name"],
            "additionalProperties": False,
        },
    },
    {
        "name": "update_task",
        "description": "Modifie une tâche : nom, notes, assigné, échéance, ou la marque terminée.",
        "input_schema": {
            "type": "object",
            "properties": {
                "task_id": {"type": "string"},
                "name": {"type": "string"},
                "notes": {"type": "string"},
                "assignee_id": {"type": "string"},
                "due_on": {"type": "string"},
                "completed": {"type": "boolean"},
            },
            "required": ["task_id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "remember",
        "description": (
            "Enregistre une information durable utile pour les prochaines fois "
            "(préférence d'équipe, décision, convention), rattachée à un projet ou une tâche."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "object_type": {"type": "string", "enum": ["project", "task"]},
                "object_id": {"type": "string"},
                "content": {"type": "string"},
            },
            "required": ["object_type", "object_id", "content"],
            "additionalProperties": False,
        },
    },
]

WRITE_TOOL_NAMES = {t["name"] for t in WRITE_TOOLS}


def execute(graph: WorkGraph, actor: str, name: str, args: dict) -> tuple[str, bool]:
    """Exécute un outil. Renvoie (contenu JSON, is_error)."""
    try:
        if name == "search_tasks":
            result = graph.search_tasks(actor, **args)
        elif name == "get_task":
            result = graph.get_task(actor, args["task_id"])
        elif name == "list_users":
            result = graph.list_users()
        elif name == "add_comment":
            result = graph.add_comment(actor, args["task_id"], args["body"])
        elif name == "create_task":
            result = graph.create_task(actor, **args)
        elif name == "update_task":
            result = graph.update_task(actor, **args)
        elif name == "remember":
            result = graph.add_memory(actor, args["object_type"], args["object_id"], args["content"])
        else:
            return f"Outil inconnu : {name}", True
        return json.dumps(result, ensure_ascii=False, default=str), False
    except PermissionDenied as e:
        return f"Accès refusé : {e}", True
    except (KeyError, TypeError, ValueError) as e:
        return f"Erreur : {e}", True
