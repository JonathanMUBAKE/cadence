"""Tests hors ligne (sans appel au LLM) : droits, filtres, mémoire, checkpoints."""

import json
from types import SimpleNamespace

import pytest

from teammate import AITeammate, PermissionDenied, WorkGraph, seed
from teammate import tools as T


@pytest.fixture
def graph():
    g = WorkGraph()
    seed(g)
    return g


def test_agent_cannot_see_hr_project(graph):
    ids = {t["id"] for t in graph.search_tasks("atlas")}
    assert "T006" not in ids and "T002" in ids
    with pytest.raises(PermissionDenied):
        graph.get_task("atlas", "T006")


def test_tool_returns_error_instead_of_leaking(graph):
    content, is_error = T.execute(graph, "atlas", "get_task", {"task_id": "T006"})
    assert is_error and "Accès refusé" in content


def test_overdue_filter(graph):
    ids = {t["id"] for t in graph.search_tasks("atlas", overdue=True)}
    assert {"T002", "T003"} <= ids and "T001" not in ids


def test_memories_are_scoped_to_graph_objects(graph):
    assert graph.memories_for("atlas", "P1")
    assert graph.memories_for("atlas", "P2") == []


class FakeClient:
    """Simule le modèle : demande un commentaire, puis termine."""

    def __init__(self):
        self.calls = 0
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=self.create))

    def create(self, **kwargs):
        self.calls += 1
        if self.calls == 1:
            block = SimpleNamespace(type="tool_use", id="tu_1", name="add_comment",
                                    input={"task_id": "T002", "body": "Relance"})
            return SimpleNamespace(stop_reason="tool_use", content=[block])
        last = kwargs["messages"][-1]["content"][0]["content"]
        text = SimpleNamespace(type="text", text=f"Fini. Résultat outil : {last}")
        return SimpleNamespace(stop_reason="end_turn", content=[text])


def test_checkpoint_declines_write(graph):
    agent = AITeammate(graph, client=FakeClient(), verbose=False)
    report = agent.work_on_task("T005", approver=lambda name, args: False)
    assert "refusée" in report
    comments = graph.get_task("atlas", "T002")["comments"]
    assert all(c["author_id"] != "atlas" for c in comments)
    statuses = [(e["action"], e["status"]) for e in graph.audit_trail("atlas")]
    assert ("add_comment", "declined") in statuses


def test_checkpoint_approves_write(graph):
    agent = AITeammate(graph, client=FakeClient(), verbose=False)
    agent.work_on_task("T005", approver=lambda name, args: True)
    bodies = [c["body"] for c in graph.get_task("atlas", "T002")["comments"]]
    assert "Relance" in bodies
    # Le compte rendu est publié sur la tâche de l'IA (transparence)
    assert graph.get_task("atlas", "T005")["comments"][-1]["body"].startswith("[Compte rendu IA]")
    assert json.loads(graph.audit_trail("atlas")[-1]["payload"])["task_id"] == "T002"
