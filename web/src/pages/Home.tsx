import { useMemo, useState } from "react";
import { Link } from "react-router";
import { motion } from "motion/react";
import { Archive, ArrowRight, Sparkles, Wand2 } from "lucide-react";
import { Avatar, Button, Empty, ProgressRing, ProjectIcon, cn } from "@/components/ui";
import { ApprovalCard, RUN_STATUS, isActive } from "@/components/ai";
import { TaskRow } from "@/components/TaskRow";
import {
  useApprovals,
  useArchivedProjects,
  useMe,
  useMyTasks,
  useProjects,
  useRuns,
  useUpdateTask,
  useUserMap,
} from "@/lib/hooks";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useShell } from "@/lib/shell";
import { STATUS, ago, firstName, greeting, isoIn, longDate, todayIso } from "@/lib/format";

export function HomePage() {
  const { data: me } = useMe();
  const { data: tasks } = useMyTasks();
  const { data: projects } = useProjects();
  const { data: approvals } = useApprovals();
  const { data: runs } = useRuns({});
  const users = useUserMap();
  const shell = useShell();
  const update = useUpdateTask();
  const [tab, setTab] = useState<"upcoming" | "overdue" | "done">("upcoming");
  const [showArchived, setShowArchived] = useState(false);
  const { data: archived } = useArchivedProjects(showArchived);
  const qc = useQueryClient();
  const projectMap = useMemo(() => new Map(projects?.map((p) => [p.id, p])), [projects]);

  const open = tasks?.filter((t) => !t.completed) ?? [];
  const overdue = open.filter((t) => t.due_on && t.due_on < todayIso());
  const upcoming = open
    .filter((t) => !t.due_on || t.due_on >= todayIso())
    .sort((a, b) => ((a.due_on ?? "9") < (b.due_on ?? "9") ? -1 : 1));
  const doneWeek = tasks?.filter((t) => t.completed && (t.completed_at ?? "") >= isoIn(-7)) ?? [];
  const list = tab === "upcoming" ? upcoming : tab === "overdue" ? overdue : doneWeek;
  const activeRuns = runs?.filter((r) => isActive(r.status)) ?? [];

  return (
    <div className="mx-auto max-w-[1180px] px-4 pb-16 pt-8 sm:px-8 sm:pt-12">
      <motion.header initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="mb-8">
        <p className="text-[13px] text-muted first-letter:uppercase">{longDate(todayIso())}</p>
        <h1 className="mt-1 font-serif text-[40px] leading-[1.05] tracking-[-0.02em] sm:text-[52px]">
          {greeting()}, {me ? firstName(me.name) : ""}
        </h1>
        <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px] text-muted">
          <span>
            <b className="font-semibold text-fg tabular">{open.length}</b>{" "}
            {open.length > 1 ? "tâches ouvertes" : "tâche ouverte"}
          </span>
          <span className={overdue.length ? "text-danger" : ""}>
            <b className="font-semibold tabular">{overdue.length}</b> en retard
          </span>
          <span>
            <b className="font-semibold text-fg tabular">{doneWeek.length}</b>{" "}
            {doneWeek.length > 1 ? "terminées" : "terminée"} cette semaine
          </span>
          {!!approvals?.length && (
            <span className="text-ai-fg">
              <b className="font-semibold tabular">{approvals.length}</b> validation(s) IA en attente
            </span>
          )}
        </div>
      </motion.header>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-6">
          <section className="overflow-hidden rounded-2xl border border-line bg-panel shadow-sm">
            <div className="flex items-center gap-1 overflow-x-auto border-b border-line px-4 pt-3">
              <h2 className="mr-3 hidden shrink-0 pb-2.5 text-[14px] font-semibold sm:block">Mes tâches</h2>
              {(
                [
                  ["upcoming", "À venir", upcoming.length],
                  ["overdue", "En retard", overdue.length],
                  ["done", "Terminées", doneWeek.length],
                ] as const
              ).map(([k, label, n]) => (
                <button
                  key={k}
                  onClick={() => setTab(k)}
                  className={cn(
                    "-mb-px shrink-0 border-b-2 px-2 pb-2.5 text-[13px]",
                    tab === k ? "border-fg font-medium text-fg" : "border-transparent text-muted hover:text-fg",
                  )}
                >
                  {label} <span className="tabular text-faint">{n}</span>
                </button>
              ))}
              <Link to="/my-tasks" className="ml-auto shrink-0 pl-2 pb-2.5 text-[12.5px] text-muted hover:text-fg">
                Tout voir
              </Link>
            </div>
            {list.length === 0 ? (
              <Empty
                title={
                  tab === "overdue"
                    ? "Aucun retard"
                    : tab === "done"
                      ? "Rien de terminé cette semaine"
                      : "Rien à l'horizon"
                }
              >
                {tab === "overdue" ? "Tout est dans les temps." : "Profitez-en pour avancer sur un projet."}
              </Empty>
            ) : (
              list
                .slice(0, 9)
                .map((t) => (
                  <TaskRow
                    key={t.id}
                    t={t}
                    assignee={me}
                    project={projectMap.get(t.project_id)}
                    onOpen={() => shell.openTask(t.id)}
                    onToggle={(v) => update.mutate({ id: t.id, completed: v })}
                    dense
                  />
                ))
            )}
          </section>

          <section>
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="text-[14px] font-semibold">Projets</h2>
              <span className="flex gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Archive className="size-3.5" />}
                  onClick={() => setShowArchived((v) => !v)}
                >
                  {showArchived ? "Masquer les archivés" : "Archivés"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => shell.setNewProject(true)}>
                  Nouveau projet
                </Button>
              </span>
            </div>
            {showArchived && (
              <div className="mb-3 overflow-hidden rounded-2xl border border-dashed border-line-strong">
                {!archived?.length && <p className="px-4 py-3 text-[13px] text-muted">Aucun projet archivé.</p>}
                {archived?.map((p) => (
                  <div key={p.id} className="flex items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0">
                    <ProjectIcon icon={p.icon} color={p.color} size={22} />
                    <Link
                      to={`/projects/${p.id}`}
                      className="min-w-0 flex-1 truncate text-[13.5px] text-muted hover:text-fg"
                    >
                      {p.name}
                    </Link>
                    {(p.role === "editor" || p.role === "admin") && (
                      <Button
                        size="sm"
                        onClick={() =>
                          api.patch(`/api/projects/${p.id}`, { archived: false }).then(() => {
                            qc.invalidateQueries({ queryKey: ["projects"] });
                            toast.success("Projet restauré");
                          })
                        }
                      >
                        Restaurer
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {projects?.map((p) => {
                const pct = p.task_count ? p.done_count / p.task_count : 0;
                return (
                  <Link
                    key={p.id}
                    to={`/projects/${p.id}`}
                    className="group flex items-center gap-3.5 rounded-2xl border border-line bg-panel p-4 shadow-sm transition-[border-color,transform] hover:-translate-y-px hover:border-line-strong"
                  >
                    <div className="relative">
                      <ProgressRing value={pct} size={46} stroke={3.5} color={p.color} />
                      <span className="absolute inset-0 flex items-center justify-center">
                        <ProjectIcon icon={p.icon} color={p.color} size={24} />
                      </span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[14px] font-medium">{p.name}</p>
                      <p className="mt-0.5 flex items-center gap-2 text-[12px] text-muted">
                        <span className="flex items-center gap-1" style={{ color: STATUS[p.status].color }}>
                          <span className="size-1.5 rounded-full bg-current" />
                          {STATUS[p.status].label}
                        </span>
                        <span className="tabular">{Math.round(pct * 100)} %</span>
                        {p.overdue_count > 0 && (
                          <span className="text-danger tabular">{p.overdue_count} en retard</span>
                        )}
                      </p>
                    </div>
                    <ArrowRight className="size-4 text-faint opacity-0 transition-opacity group-hover:opacity-100" />
                  </Link>
                );
              })}
            </div>
          </section>
        </div>

        <aside className="min-w-0 space-y-6">
          <section className="relative overflow-hidden rounded-2xl border border-ai-line bg-panel p-5 shadow-sm">
            <div className="pointer-events-none absolute -right-16 -top-16 size-48 rounded-full bg-[radial-gradient(circle,var(--ai-soft),transparent_70%)]" />
            <div className="relative">
              <div className="flex items-center gap-2">
                <Sparkles className="size-4 text-ai-fg" />
                <h2 className="text-[14px] font-semibold">Cadence AI</h2>
              </div>
              <p className="mt-2 text-[13px] text-muted">
                Posez une question sur vos projets ou transformez des notes en tâches.
              </p>
              <div className="mt-3 flex flex-col gap-1.5">
                {["Qu'est-ce qui est en retard, et pourquoi ?", "Quelles sont mes tâches ouvertes ?"].map((q) => (
                  <button
                    key={q}
                    onClick={() => shell.openAssistant(q)}
                    className="rounded-lg border border-line bg-bg/60 px-3 py-2 text-left text-[13px] hover:border-ai-line hover:bg-ai-soft"
                  >
                    {q}
                  </button>
                ))}
                <Button
                  variant="ai"
                  className="mt-1"
                  icon={<Wand2 className="size-3.5" />}
                  onClick={() => shell.openQuickAdd(null)}
                >
                  Créer des tâches à partir de notes
                </Button>
              </div>
            </div>
          </section>

          {!!approvals?.length && (
            <section>
              <h2 className="mb-3 text-[14px] font-semibold">En attente de votre accord</h2>
              <div className="space-y-2.5">
                {approvals.slice(0, 3).map((a) => (
                  <ApprovalCard key={a.id} a={a} compact />
                ))}
              </div>
            </section>
          )}

          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-[14px] font-semibold">Activité des coéquipiers IA</h2>
              <Link to="/ai" className="text-[12.5px] text-muted hover:text-fg">
                Tout voir
              </Link>
            </div>
            <div className="rounded-2xl border border-line bg-panel p-1.5 shadow-sm">
              {(runs ?? []).slice(0, 6).map((r) => (
                <button
                  key={r.id}
                  onClick={() => r.task_id && shell.openTask(r.task_id)}
                  className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left hover:bg-hover"
                >
                  <Avatar user={users.get(r.agent_id)} size={24} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px]">
                      <b className="font-medium">{users.get(r.agent_id)?.name}</b>{" "}
                      <span className="text-muted">
                        {r.kind === "mention"
                          ? "a répondu à une mention"
                          : r.kind === "rule"
                            ? "a appliqué une règle"
                            : "a pris une tâche en charge"}
                      </span>
                    </span>
                    <span className={cn("block text-[11.5px]", RUN_STATUS[r.status].tone)}>
                      {RUN_STATUS[r.status].label} · <span className="text-faint">{ago(r.created_at)}</span>
                    </span>
                  </span>
                </button>
              ))}
              {!runs?.length && (
                <p className="px-3 py-4 text-[13px] text-muted">
                  Aucune intervention pour l'instant. Assignez une tâche à Atlas pour le voir travailler.
                </p>
              )}
              {activeRuns.length > 0 && (
                <p className="px-3 pb-1.5 pt-1 text-[12px] text-ai-fg">{activeRuns.length} en cours…</p>
              )}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
