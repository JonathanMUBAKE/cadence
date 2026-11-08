"""Work Graph : le modèle de données relationnel qui sert de contexte à l'IA.

Comme chez Asana, tout est relié : utilisateurs <-> projets <-> tâches <-> commentaires
<-> mémoires. Un agent IA est un utilisateur comme les autres (is_ai=1) : il a des
adhésions aux projets et ne voit QUE ce que ses droits lui permettent de voir.
"""

from __future__ import annotations

import json
import sqlite3
from datetime import date, datetime, timezone

SCHEMA = """
CREATE TABLE IF NOT EXISTS users(
    id TEXT PRIMARY KEY, name TEXT NOT NULL, is_ai INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS projects(
    id TEXT PRIMARY KEY, name TEXT NOT NULL, goal TEXT);
CREATE TABLE IF NOT EXISTS memberships(
    user_id TEXT, project_id TEXT, role TEXT CHECK(role IN ('viewer','editor')),
    PRIMARY KEY(user_id, project_id));
CREATE TABLE IF NOT EXISTS tasks(
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL, notes TEXT,
    assignee_id TEXT, due_on TEXT, completed INTEGER NOT NULL DEFAULT 0, parent_id TEXT);
CREATE TABLE IF NOT EXISTS comments(
    id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, author_id TEXT, body TEXT,
    created_at TEXT);
CREATE TABLE IF NOT EXISTS memories(
    id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, object_type TEXT,
    object_id TEXT, content TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS audit_log(
    id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT, action TEXT, payload TEXT,
    status TEXT, created_at TEXT);
"""


class PermissionDenied(Exception):
    pass


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class WorkGraph:
    def __init__(self, path: str = ":memory:"):
        self.db = sqlite3.connect(path)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)

    # ------------------------------------------------------------------ droits
    def _role(self, actor: str, project_id: str) -> str | None:
        row = self.db.execute(
            "SELECT role FROM memberships WHERE user_id=? AND project_id=?",
            (actor, project_id),
        ).fetchone()
        return row["role"] if row else None

    def _require(self, actor: str, project_id: str, write: bool = False) -> None:
        role = self._role(actor, project_id)
        if role is None or (write and role != "editor"):
            raise PermissionDenied(
                f"{actor} n'a pas le droit {'d’écrire' if write else 'de lire'} "
                f"dans le projet {project_id}"
            )

    def readable_project_ids(self, actor: str) -> list[str]:
        rows = self.db.execute(
            "SELECT project_id FROM memberships WHERE user_id=?", (actor,)
        ).fetchall()
        return [r["project_id"] for r in rows]

    def _task_row(self, task_id: str) -> sqlite3.Row:
        row = self.db.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
        if row is None:
            raise KeyError(f"Tâche {task_id} introuvable")
        return row

    # ---------------------------------------------------------------- lecture
    def search_tasks(
        self,
        actor: str,
        project_id: str | None = None,
        assignee_id: str | None = None,
        completed: bool | None = None,
        overdue: bool | None = None,
        text: str | None = None,
        limit: int = 20,
    ) -> list[dict]:
        """Recherche filtrée : le LLM traduit la question en filtres structurés,
        la base fait le tri. Les filtres de permission s'appliquent toujours."""
        allowed = self.readable_project_ids(actor)
        if project_id:
            self._require(actor, project_id)
            allowed = [project_id]
        if not allowed:
            return []
        sql = f"SELECT * FROM tasks WHERE project_id IN ({','.join('?' * len(allowed))})"
        params: list = list(allowed)
        if assignee_id:
            sql += " AND assignee_id=?"
            params.append(assignee_id)
        if completed is not None:
            sql += " AND completed=?"
            params.append(int(completed))
        if overdue:
            sql += " AND completed=0 AND due_on IS NOT NULL AND due_on < ?"
            params.append(date.today().isoformat())
        if text:
            sql += " AND (name LIKE ? OR notes LIKE ?)"
            params += [f"%{text}%", f"%{text}%"]
        sql += " ORDER BY due_on IS NULL, due_on LIMIT ?"
        params.append(max(1, min(limit, 50)))
        return [dict(r) for r in self.db.execute(sql, params).fetchall()]

    def get_task(self, actor: str, task_id: str) -> dict:
        """Une tâche AVEC son voisinage dans le graphe : projet, objectif, assigné,
        sous-tâches, commentaires. C'est ce voisinage qui donne le contexte à l'IA."""
        task = dict(self._task_row(task_id))
        self._require(actor, task["project_id"])
        project = self.db.execute(
            "SELECT name, goal FROM projects WHERE id=?", (task["project_id"],)
        ).fetchone()
        task["project"] = dict(project) if project else None
        task["subtasks"] = [
            dict(r)
            for r in self.db.execute(
                "SELECT id, name, assignee_id, due_on, completed FROM tasks WHERE parent_id=?",
                (task_id,),
            )
        ]
        task["comments"] = [
            dict(r)
            for r in self.db.execute(
                "SELECT author_id, body, created_at FROM comments WHERE task_id=? ORDER BY id",
                (task_id,),
            )
        ]
        return task

    def list_users(self) -> list[dict]:
        return [dict(r) for r in self.db.execute("SELECT * FROM users")]

    # --------------------------------------------------------------- écriture
    def create_task(
        self, actor: str, project_id: str, name: str, notes: str = "",
        assignee_id: str | None = None, due_on: str | None = None,
        parent_id: str | None = None,
    ) -> dict:
        self._require(actor, project_id, write=True)
        n = self.db.execute("SELECT COUNT(*) FROM tasks").fetchone()[0]
        task_id = f"T{n + 1:03d}"
        self.db.execute(
            "INSERT INTO tasks(id, project_id, name, notes, assignee_id, due_on, parent_id)"
            " VALUES (?,?,?,?,?,?,?)",
            (task_id, project_id, name, notes, assignee_id, due_on, parent_id),
        )
        self.db.commit()
        return dict(self._task_row(task_id))

    def update_task(self, actor: str, task_id: str, **fields) -> dict:
        task = self._task_row(task_id)
        self._require(actor, task["project_id"], write=True)
        allowed = {"name", "notes", "assignee_id", "due_on", "completed"}
        changes = {k: v for k, v in fields.items() if k in allowed and v is not None}
        if "completed" in changes:
            changes["completed"] = int(bool(changes["completed"]))
        if changes:
            sets = ", ".join(f"{k}=?" for k in changes)
            self.db.execute(f"UPDATE tasks SET {sets} WHERE id=?", (*changes.values(), task_id))
            self.db.commit()
        return dict(self._task_row(task_id))

    def add_comment(self, actor: str, task_id: str, body: str) -> dict:
        task = self._task_row(task_id)
        # Commenter ne demande qu'un droit de lecture (comme dans la plupart des outils)
        self._require(actor, task["project_id"])
        cur = self.db.execute(
            "INSERT INTO comments(task_id, author_id, body, created_at) VALUES (?,?,?,?)",
            (task_id, actor, body, _now()),
        )
        self.db.commit()
        return {"comment_id": cur.lastrowid, "task_id": task_id}

    # ---------------------------------------------------------------- mémoire
    def add_memory(self, agent: str, object_type: str, object_id: str, content: str) -> dict:
        """Une mémoire est TOUJOURS rattachée à un objet du graphe : c'est ce lien
        qui sert à la retrouver et à appliquer les droits d'accès."""
        project_id = object_id if object_type == "project" else self._task_row(object_id)["project_id"]
        self._require(agent, project_id)
        cur = self.db.execute(
            "INSERT INTO memories(agent_id, object_type, object_id, content, created_at)"
            " VALUES (?,?,?,?,?)",
            (agent, object_type, object_id, content, _now()),
        )
        self.db.commit()
        return {"memory_id": cur.lastrowid}

    def memories_for(self, agent: str, project_id: str, task_id: str | None = None) -> list[str]:
        if self._role(agent, project_id) is None:
            return []
        rows = self.db.execute(
            "SELECT content FROM memories WHERE agent_id=? AND ("
            " (object_type='project' AND object_id=?) OR (object_type='task' AND object_id=?))"
            " ORDER BY id DESC LIMIT 20",
            (agent, project_id, task_id or ""),
        ).fetchall()
        return [r["content"] for r in rows]

    # -------------------------------------------------------------- audit
    def audit(self, actor: str, action: str, payload: dict, status: str) -> None:
        self.db.execute(
            "INSERT INTO audit_log(actor_id, action, payload, status, created_at) VALUES (?,?,?,?,?)",
            (actor, action, json.dumps(payload, ensure_ascii=False), status, _now()),
        )
        self.db.commit()

    def audit_trail(self, actor: str | None = None) -> list[dict]:
        sql, params = "SELECT * FROM audit_log", ()
        if actor:
            sql, params = sql + " WHERE actor_id=?", (actor,)
        return [dict(r) for r in self.db.execute(sql + " ORDER BY id", params)]


def seed(graph: WorkGraph) -> None:
    """Jeu de données de démonstration."""
    db = graph.db
    db.executemany(
        "INSERT INTO users VALUES (?,?,?)",
        [("alice", "Alice (cheffe de projet)", 0), ("bob", "Bob (dev mobile)", 0),
         ("chloe", "Chloé (design)", 0), ("atlas", "Atlas (AI Teammate)", 1)],
    )
    db.executemany(
        "INSERT INTO projects VALUES (?,?,?)",
        [("P1", "Lancement App Mobile v2", "Publier la v2 sur les stores avant le 15 décembre"),
         ("P2", "RH - Salaires 2027", "Confidentiel")],
    )
    db.executemany(
        "INSERT INTO memberships VALUES (?,?,?)",
        [("alice", "P1", "editor"), ("bob", "P1", "editor"), ("chloe", "P1", "editor"),
         ("atlas", "P1", "editor"),            # l'IA a accès au projet P1...
         ("alice", "P2", "editor")],           # ...mais PAS au projet RH P2
    )
    db.executemany(
        "INSERT INTO tasks(id, project_id, name, notes, assignee_id, due_on, completed, parent_id)"
        " VALUES (?,?,?,?,?,?,?,?)",
        [
            ("T001", "P1", "Maquettes écran de paiement", "Version Figma validée par le PO",
             "chloe", "2026-10-30", 1, None),
            ("T002", "P1", "Intégrer le SDK de paiement", "Bloqué par la clé API sandbox",
             "bob", "2026-11-03", 0, None),
            ("T003", "P1", "Tests de non-régression iOS", "", "bob", "2026-11-05", 0, None),
            ("T004", "P1", "Rédiger les notes de version", "", None, "2026-12-01", 0, None),
            ("T005", "P1", "Préparer le point d'avancement hebdo",
             "Fais le point sur le projet : ce qui est terminé, ce qui est en retard, les "
             "blocages. Relance les personnes concernées en commentaire sur leurs tâches "
             "en retard et propose des sous-tâches si un blocage le justifie.",
             "atlas", "2026-11-10", 0, None),
            ("T006", "P2", "Grille salariale 2027", "Données sensibles", "alice",
             "2026-11-20", 0, None),
        ],
    )
    db.execute(
        "INSERT INTO comments(task_id, author_id, body, created_at) VALUES (?,?,?,?)",
        ("T002", "bob", "J'attends toujours la clé sandbox du prestataire.", _now()),
    )
    db.commit()
    graph.add_memory("atlas", "project", "P1",
                     "Alice préfère des rapports courts en puces, avec les risques en premier.")
