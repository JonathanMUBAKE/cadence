import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Empty, cn } from "@/components/ui";
import { TaskRow } from "@/components/TaskRow";
import { useMe, useMyTasks, useProjects, useUpdateTask } from "@/lib/hooks";
import { useShell } from "@/lib/shell";
import { isoIn, todayIso } from "@/lib/format";
import type { Task } from "@/lib/types";

const BUCKETS: { id: string; label: string; test: (t: Task) => boolean }[] = [
  { id: "overdue", label: "En retard", test: (t) => !!t.due_on && t.due_on < todayIso() },
  { id: "today", label: "Aujourd'hui", test: (t) => t.due_on === todayIso() },
  { id: "week", label: "Cette semaine", test: (t) => !!t.due_on && t.due_on > todayIso() && t.due_on <= isoIn(7) },
  { id: "later", label: "Plus tard", test: (t) => !!t.due_on && t.due_on > isoIn(7) },
  { id: "none", label: "Sans échéance", test: (t) => !t.due_on },
];

export function MyTasksPage() {
  const { data: me } = useMe();
  const { data: tasks } = useMyTasks();
  const { data: projects } = useProjects();
  const update = useUpdateTask();
  const shell = useShell();
  const [showDone, setShowDone] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const pm = useMemo(() => new Map(projects?.map((p) => [p.id, p])), [projects]);
  const open = (tasks ?? []).filter((t) => !t.completed).sort((a, b) => (a.due_on ?? "9") < (b.due_on ?? "9") ? -1 : 1);
  const done = (tasks ?? []).filter((t) => t.completed).sort((a, b) => (b.completed_at ?? "") < (a.completed_at ?? "") ? -1 : 1);

  return (
    <div className="mx-auto max-w-[1100px] pb-16">
      <header className="flex flex-wrap items-end gap-3 px-4 pb-5 pt-8 sm:px-8">
        <div>
          <h1 className="text-[26px] font-semibold tracking-[-0.02em]">Mes tâches</h1>
          <p className="mt-1 text-[13px] text-muted">Tout ce qui vous est assigné, dans tous vos projets.</p>
        </div>
        <label className="ml-auto flex items-center gap-2 text-[13px] text-muted"><input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} className="accent-[var(--fg)]" />Afficher les terminées</label>
      </header>
      <div className="border-t border-line">
        {open.length === 0 && <Empty title="Vous êtes à jour">Aucune tâche ouverte ne vous est assignée.</Empty>}
        {BUCKETS.map((b) => {
          const items = open.filter(b.test);
          if (!items.length) return null;
          return (
            <section key={b.id}>
              <button onClick={() => setCollapsed({ ...collapsed, [b.id]: !collapsed[b.id] })} className="sticky top-0 z-10 flex h-10 w-full items-center gap-2 border-b border-line bg-bg/90 px-4 text-left backdrop-blur sm:px-8">
                <ChevronDown className={cn("size-4 text-faint transition-transform", collapsed[b.id] && "-rotate-90")} />
                <span className={cn("text-[13px] font-semibold", b.id === "overdue" && "text-danger")}>{b.label}</span>
                <span className="text-[12px] tabular text-faint">{items.length}</span>
              </button>
              {!collapsed[b.id] && <div className="sm:px-4">{items.map((t) => <TaskRow key={t.id} t={t} assignee={me} project={pm.get(t.project_id)} onOpen={() => shell.openTask(t.id)} onToggle={(v) => update.mutate({ id: t.id, completed: v })} />)}</div>}
            </section>
          );
        })}
        {showDone && done.length > 0 && (
          <section>
            <div className="flex h-10 items-center gap-2 border-b border-line px-4 sm:px-8"><span className="text-[13px] font-semibold text-muted">Terminées</span><span className="text-[12px] text-faint">{done.length}</span></div>
            <div className="sm:px-4">{done.map((t) => <TaskRow key={t.id} t={t} assignee={me} project={pm.get(t.project_id)} onOpen={() => shell.openTask(t.id)} onToggle={(v) => update.mutate({ id: t.id, completed: v })} />)}</div>
          </section>
        )}
      </div>
    </div>
  );
}
