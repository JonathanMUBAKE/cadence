import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Check,
  CircleStop,
  Eye,
  FilePlus2,
  LoaderCircle,
  MessageSquare,
  PenLine,
  Search,
  Sparkles,
  X,
  BookmarkPlus,
  FolderOpen,
  ShieldAlert,
} from "lucide-react";
import { Avatar, Button, Markdown, cn } from "./ui";
import { useDecide, useRun, useUserMap } from "@/lib/hooks";
import { ago } from "@/lib/format";
import { api } from "@/lib/api";
import type { AiApproval, AiRun, AiStep } from "@/lib/types";

export const RUN_STATUS: Record<AiRun["status"], { label: string; tone: string }> = {
  queued: { label: "En file", tone: "text-faint" },
  running: { label: "Au travail", tone: "text-ai-fg" },
  waiting_approval: { label: "Attend votre accord", tone: "text-warning" },
  done: { label: "Terminé", tone: "text-success" },
  failed: { label: "Échec", tone: "text-danger" },
  cancelled: { label: "Arrêté", tone: "text-faint" },
};
export const isActive = (s: AiRun["status"]) => s === "queued" || s === "running" || s === "waiting_approval";

const TOOL_ICON: Record<string, typeof Search> = {
  search_tasks: Search,
  get_task: Eye,
  get_project: FolderOpen,
  list_projects: FolderOpen,
  create_task: FilePlus2,
  update_task: PenLine,
  add_comment: MessageSquare,
  remember: BookmarkPlus,
};

export function stepLabel(s: AiStep): string {
  const i = (s.input ?? {}) as Record<string, string | boolean>;
  switch (s.tool) {
    case "search_tasks": {
      const f: string[] = [];
      if (i.overdue) f.push("en retard");
      if (i.assignee) f.push(`de ${i.assignee}`);
      if (i.priority) f.push(`priorité ${i.priority}`);
      if (i.text) f.push(`« ${i.text} »`);
      if (i.due_before) f.push(`avant le ${i.due_before}`);
      if (i.completed === false) f.push("ouvertes");
      const out = s.output as { count?: number } | null;
      return `Recherche des tâches${f.length ? " " + f.join(", ") : ""}${out && typeof out === "object" && "count" in out ? ` · ${out.count} résultat(s)` : ""}`;
    }
    case "get_task":
      return `Lecture de la tâche ${i.task}`;
    case "get_project":
      return "Lecture du projet";
    case "list_projects":
      return "Tour des projets";
    case "create_task":
      return i.parent ? `Sous-tâche « ${i.title} »` : `Nouvelle tâche « ${i.title} »`;
    case "update_task":
      return `Mise à jour de ${i.task}`;
    case "add_comment":
      return `Commentaire sur ${i.task}`;
    case "remember":
      return "Mémorisation";
    default:
      return s.kind === "thought" ? "Réflexion" : (s.tool ?? s.kind);
  }
}

function StepRow({ s }: { s: AiStep }) {
  const Icon = s.tool ? (TOOL_ICON[s.tool] ?? Sparkles) : Sparkles;
  const status = s.status;
  return (
    <motion.li
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      className="relative flex gap-2.5 pb-2.5 last:pb-0"
    >
      <span
        className={cn(
          "relative z-10 mt-[1px] flex size-[22px] shrink-0 items-center justify-center rounded-full border bg-panel",
          status === "error"
            ? "border-danger/40 text-danger"
            : status === "rejected"
              ? "border-warning/40 text-warning"
              : status === "running"
                ? "border-ai-line text-ai-fg"
                : "border-line text-muted",
        )}
      >
        {status === "running" ? <LoaderCircle className="size-3 animate-spin" /> : <Icon className="size-3" />}
      </span>
      <div className="min-w-0 flex-1 pt-[2px]">
        <p
          className={cn(
            "text-[12.5px] leading-snug",
            status === "rejected" ? "text-muted line-through decoration-warning/60" : "text-fg",
          )}
        >
          {stepLabel(s)}
        </p>
        {s.tool === "add_comment" && typeof s.input?.body === "string" && (
          <p className="mt-0.5 line-clamp-2 text-[12px] text-muted">« {s.input.body} »</p>
        )}
        {status === "error" && <p className="mt-0.5 text-[12px] text-danger">{String(s.output)}</p>}
        {status === "rejected" && <p className="mt-0.5 text-[12px] text-warning">Refusé par un humain</p>}
      </div>
    </motion.li>
  );
}

export function ApprovalCard({ a, compact }: { a: AiApproval; compact?: boolean }) {
  const users = useUserMap();
  const decide = useDecide();
  const agent = users.get(a.agent_id);
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(String(a.input.body ?? ""));
  const [decided, setDecided] = useState<null | boolean>(null);
  const pending = a.status === "pending" && decided === null;
  const detail =
    a.tool === "add_comment"
      ? String(a.input.body ?? "")
      : a.tool === "create_task"
        ? [a.input.description, a.input.due_on && `Échéance ${a.input.due_on}`].filter(Boolean).join(" · ")
        : "";
  return (
    <div
      className={cn("rounded-xl border bg-panel p-3", pending ? "ai-ring border-transparent shadow-md" : "border-line")}
    >
      <div className="flex items-start gap-2.5">
        <Avatar user={agent} size={24} />
        <div className="min-w-0 flex-1">
          <p className="text-[11.5px] font-medium uppercase tracking-wider text-ai-fg">
            {pending
              ? `${agent?.name ?? "L'IA"} demande votre accord`
              : decided === true || a.status === "approved"
                ? "Autorisé"
                : decided === false || a.status === "rejected"
                  ? "Refusé"
                  : "Expiré"}
          </p>
          <p className="mt-0.5 text-[13.5px] font-medium leading-snug">{a.summary}</p>
          {detail && !editing && (
            <p
              className={cn(
                "mt-1.5 whitespace-pre-wrap rounded-lg bg-hover px-2.5 py-2 text-[13px] text-fg/90",
                compact && "line-clamp-3",
              )}
            >
              {detail}
            </p>
          )}
          {editing && (
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={4}
              className="mt-1.5 w-full resize-y rounded-lg border border-ai-line bg-panel px-2.5 py-2 text-[13px] outline-none"
            />
          )}
          {pending && (
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              <Button
                size="sm"
                variant="primary"
                icon={<Check className="size-3.5" />}
                loading={decide.isPending && decide.variables?.approve}
                onClick={() =>
                  decide.mutate(
                    { id: a.id, approve: true, edits: editing ? { body } : undefined },
                    { onSuccess: () => setDecided(true) },
                  )
                }
              >
                Autoriser
              </Button>
              <Button
                size="sm"
                icon={<X className="size-3.5" />}
                onClick={() => decide.mutate({ id: a.id, approve: false }, { onSuccess: () => setDecided(false) })}
              >
                Refuser
              </Button>
              {a.tool === "add_comment" && !editing && (
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<PenLine className="size-3.5" />}
                  onClick={() => setEditing(true)}
                >
                  Retoucher
                </Button>
              )}
              <span className="ml-auto text-[11.5px] text-faint">{ago(a.created_at)}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Déroulé en direct d'une exécution IA : étapes, validations, compte rendu. */
export function RunTimeline({ runId, showSummary = true }: { runId: string; showSummary?: boolean }) {
  const { data: run } = useRun(runId);
  const users = useUserMap();
  if (!run)
    return (
      <div className="flex items-center gap-2 py-2 text-[13px] text-muted">
        <LoaderCircle className="size-4 animate-spin" />
        Chargement…
      </div>
    );
  const agent = users.get(run.agent_id);
  const pending = run.approvals.filter((a) => a.status === "pending");
  const st = RUN_STATUS[run.status];
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Avatar user={agent} size={20} />
        <span className="text-[13px] font-medium">{agent?.name}</span>
        <span className={cn("flex items-center gap-1.5 text-[12px]", st.tone)}>
          {isActive(run.status) && <span className="pulse-dot size-1.5 rounded-full bg-current" />}
          {st.label}
        </span>
        <span className="ml-auto text-[11.5px] text-faint">{ago(run.created_at)}</span>
        {isActive(run.status) && (
          <button
            onClick={() => api.post(`/api/ai/runs/${run.id}/cancel`)}
            className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] text-muted hover:bg-hover hover:text-fg"
          >
            <CircleStop className="size-3.5" />
            Arrêter
          </button>
        )}
      </div>
      {run.steps.length > 0 && (
        <ol className="relative ml-[1px] before:absolute before:bottom-3 before:left-[10.5px] before:top-3 before:w-px before:bg-line">
          {run.steps
            .filter((s) => s.kind === "tool")
            .map((s) => (
              <StepRow key={s.id} s={s} />
            ))}
        </ol>
      )}
      <AnimatePresence>
        {pending.map((a) => (
          <motion.div
            key={a.id}
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
          >
            <ApprovalCard a={a} />
          </motion.div>
        ))}
      </AnimatePresence>
      {run.status === "failed" && (
        <div className="flex gap-2 rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" />
          {run.error}
        </div>
      )}
      {showSummary && run.summary && run.status === "done" && (
        <div className="rounded-lg border border-line bg-bg/60 px-3 py-2.5 text-[13px]">
          <Markdown text={run.summary} />
        </div>
      )}
    </div>
  );
}

export function AiBadge({ label = "IA" }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-ai-soft px-1.5 py-0.5 text-[11px] font-semibold text-ai-fg">
      <Sparkles className="size-3" />
      {label}
    </span>
  );
}
