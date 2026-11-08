"""Démo : python main.py run [--auto]   |   python main.py ask "question" [--as alice]"""

import argparse

from teammate import AITeammate, WorkGraph, auto_approve, console_approver, seed


def main() -> None:
    p = argparse.ArgumentParser(description="Prototype d'IA embarquée façon Asana")
    sub = p.add_subparsers(dest="cmd", required=True)
    run = sub.add_parser("run", help="L'AI Teammate traite les tâches qui lui sont assignées")
    run.add_argument("--auto", action="store_true", help="Valider automatiquement les checkpoints")
    ask = sub.add_parser("ask", help="Poser une question à l'assistant (lecture seule)")
    ask.add_argument("question")
    ask.add_argument("--as", dest="as_user", default="alice")
    args = p.parse_args()

    graph = WorkGraph()
    seed(graph)
    atlas = AITeammate(graph, guidelines="Mentionne toujours l'échéance quand tu relances quelqu'un.")

    if args.cmd == "run":
        for task_id, report in atlas.run_inbox(auto_approve if args.auto else console_approver):
            print(f"\n--- Compte rendu ({task_id}) ---\n{report}")
        print("\n--- Journal d'audit ---")
        for e in graph.audit_trail("atlas"):
            print(f"{e['created_at']}  {e['action']:<12} {e['status']:<9} {e['payload']}")
    else:
        print(atlas.ask(args.question, as_user=args.as_user))


if __name__ == "__main__":
    main()
