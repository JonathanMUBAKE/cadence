"""L'IA embarquée : un « AI Teammate » qui travaille DANS l'outil.

Les trois principes repris d'Asana :
  1. Contexte  : on injecte le voisinage de la tâche dans le Work Graph + les mémoires.
  2. Checkpoints : toute écriture passe par une validation humaine (ou une politique).
  3. Contrôles : l'agent agit avec SES droits ; chaque action est journalisée (audit).
"""

from __future__ import annotations

import json
from datetime import date
from typing import Callable

import anthropic

from . import tools as T
from .work_graph import WorkGraph

MODEL = "claude-opus-5-5"

# Approver : reçoit (nom_outil, arguments) et renvoie True pour autoriser l'action.
Approver = Callable[[str, dict], bool]


def auto_approve(_name: str, _args: dict) -> bool:
    return True


def console_approver(name: str, args: dict) -> bool:
    print(f"\n  ⏸  CHECKPOINT — l'IA veut exécuter « {name} »")
    print("     " + json.dumps(args, ensure_ascii=False, indent=2).replace("\n", "\n     "))
    return input("     Autoriser ? [o/N] ").strip().lower() in {"o", "oui", "y", "yes"}


class AITeammate:
    def __init__(
        self,
        graph: WorkGraph,
        agent_id: str = "atlas",
        role: str = "Assistant chef de projet",
        guidelines: str = "",
        client: anthropic.Anthropic | None = None,
        max_steps: int = 15,
        verbose: bool = True,
    ):
        self.graph = graph
        self.agent_id = agent_id
        self.client = client or anthropic.Anthropic()
        self.max_steps = max_steps
        self.verbose = verbose
        # Prompt système STABLE (mis en cache) : rôle + consignes de l'équipe.
        self.system = (
            f"Tu es {agent_id}, un AI Teammate intégré à un outil de gestion de projet. "
            f"Ton rôle : {role}.\n"
            "Tu travailles comme un membre de l'équipe : tu lis le Work Graph (projets, "
            "tâches, commentaires) avec tes outils, tu agis avec les mêmes droits qu'un "
            "utilisateur, et tu expliques ce que tu fais.\n"
            "Règles :\n"
            "- Appuie-toi uniquement sur les données obtenues par tes outils ; si une "
            "information manque ou si l'accès est refusé, dis-le.\n"
            "- Utilise des filtres précis dans search_tasks plutôt que de tout lister.\n"
            "- Si une action est refusée au checkpoint, n'insiste pas : adapte-toi.\n"
            "- Enregistre avec `remember` les préférences ou décisions durables.\n"
            "- Termine par un compte rendu clair, en français, de ce que tu as fait.\n"
            + (f"\nConsignes de l'équipe :\n{guidelines}\n" if guidelines else "")
        )

    # ------------------------------------------------------------------ utils
    def _log(self, msg: str) -> None:
        if self.verbose:
            print(msg)

    def _build_context(self, task_id: str) -> str:
        """Récupération de contexte « Work Graph » : la tâche, son voisinage, les mémoires."""
        task = self.graph.get_task(self.agent_id, task_id)
        memories = self.graph.memories_for(self.agent_id, task["project_id"], task_id)
        parts = [
            f"Date du jour : {date.today().isoformat()}",
            "Tâche qui t'est assignée (avec son contexte) :",
            json.dumps(task, ensure_ascii=False, indent=2, default=str),
        ]
        if memories:
            parts.append("Ce dont tu te souviens sur ce projet :\n- " + "\n- ".join(memories))
        return "\n\n".join(parts)

    # ------------------------------------------------------------ boucle agent
    def _loop(self, messages: list, tools: list, approver: Approver) -> str:
        for step in range(self.max_steps):
            response = self.client.beta.messages.create(
                model=MODEL,
                max_tokens=16000,
                system=[{"type": "text", "text": self.system,
                         "cache_control": {"type": "ephemeral"}}],
                tools=tools,
                messages=messages,
                output_config={"effort": "medium"},
                # Repli automatique si les garde-fous du modèle déclinent la requête.
                betas=["server-side-fallback-2026-07-01"],
                fallbacks="default",
            )

            if response.stop_reason == "refusal":
                self.graph.audit(self.agent_id, "refusal", {"step": step}, "stopped")
                return "Le modèle a décliné cette demande."

            # On renvoie le contenu tel quel (blocs de réflexion compris) : historique append-only.
            messages.append({"role": "assistant", "content": response.content})

            if response.stop_reason == "pause_turn":
                continue
            if response.stop_reason != "tool_use":
                # end_turn, max_tokens… : on récupère le texte final.
                return "\n".join(b.text for b in response.content if b.type == "text").strip()

            results = []
            for block in response.content:
                if block.type != "tool_use":
                    continue
                args = block.input if isinstance(block.input, dict) else {}
                self._log(f"  → {block.name}({json.dumps(args, ensure_ascii=False)})")

                # CHECKPOINT : les écritures doivent être validées.
                if block.name in T.WRITE_TOOL_NAMES and not approver(block.name, args):
                    self.graph.audit(self.agent_id, block.name, args, "declined")
                    results.append({
                        "type": "tool_result", "tool_use_id": block.id,
                        "content": "Action refusée par un humain au checkpoint. Ne la refais pas.",
                    })
                    continue

                content, is_error = T.execute(self.graph, self.agent_id, block.name, args)
                self.graph.audit(self.agent_id, block.name, args, "error" if is_error else "ok")
                results.append({"type": "tool_result", "tool_use_id": block.id,
                                "content": content, "is_error": is_error})

            # Tous les résultats dans UN SEUL message utilisateur.
            messages.append({"role": "user", "content": results})

        return "Arrêt : nombre maximal d'étapes atteint."

    # ------------------------------------------------------------- modes
    def work_on_task(self, task_id: str, approver: Approver = console_approver) -> str:
        """Mode « Teammate » : l'IA prend en charge une tâche qui lui est assignée."""
        self.graph.audit(self.agent_id, "start_task", {"task_id": task_id}, "ok")
        messages = [{"role": "user", "content":
                     self._build_context(task_id) + "\n\nRéalise cette tâche."}]
        report = self._loop(messages, T.READ_TOOLS + T.WRITE_TOOLS, approver)
        # Transparence : le compte rendu est publié sur la tâche, visible par toute l'équipe.
        self.graph.add_comment(self.agent_id, task_id, f"[Compte rendu IA]\n{report}")
        return report

    def ask(self, question: str, as_user: str) -> str:
        """Mode « chat » : questions en langage naturel, outils en LECTURE SEULE,
        exécutés avec les droits de l'utilisateur qui pose la question."""
        assistant = AITeammate(self.graph, agent_id=as_user, client=self.client,
                               verbose=self.verbose)
        assistant.system = self.system.replace(
            f"Tu es {self.agent_id}", f"Tu es l'assistant IA de {as_user}")
        messages = [{"role": "user", "content":
                     f"Date du jour : {date.today().isoformat()}\n\n{question}"}]
        return assistant._loop(messages, T.READ_TOOLS, auto_approve)

    def run_inbox(self, approver: Approver = console_approver) -> list[tuple[str, str]]:
        """Déclencheur : traite toutes les tâches ouvertes assignées à l'IA."""
        tasks = self.graph.search_tasks(self.agent_id, assignee_id=self.agent_id, completed=False)
        out = []
        for t in tasks:
            self._log(f"\n=== {self.agent_id} prend en charge {t['id']} : {t['name']} ===")
            out.append((t["id"], self.work_on_task(t["id"], approver)))
        return out
