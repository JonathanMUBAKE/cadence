import { useMemo, useState } from "react";
import { addDays, addMonths, endOfMonth, endOfWeek, format, isSameMonth, startOfMonth, startOfWeek } from "date-fns";
import { fr } from "date-fns/locale";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { Avatar, Button, IconButton, cn } from "@/components/ui";
import { useCreateTask, useUserMap } from "@/lib/hooks";
import { useShell } from "@/lib/shell";
import { priorityMeta, todayIso } from "@/lib/format";
import type { ViewProps } from "@/pages/Project";

export function CalendarView({ project, tasks, canEdit }: ViewProps) {
  const [month, setMonth] = useState(() => startOfMonth(new Date()));
  const users = useUserMap();
  const shell = useShell();
  const create = useCreateTask();
  const days = useMemo(() => {
    const start = startOfWeek(startOfMonth(month), { weekStartsOn: 1 });
    const end = endOfWeek(endOfMonth(month), { weekStartsOn: 1 });
    const out: Date[] = [];
    for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
    return out;
  }, [month]);
  const byDay = useMemo(() => {
    const m = new Map<string, typeof tasks>();
    for (const t of tasks) if (t.due_on) m.set(t.due_on, [...(m.get(t.due_on) ?? []), t]);
    return m;
  }, [tasks]);
  const noDate = tasks.filter((t) => !t.due_on && !t.completed).length;

  return (
    <div className="px-4 py-5 sm:px-8">
      <div className="mb-4 flex items-center gap-2">
        <h2 className="min-w-[160px] text-[18px] font-semibold first-letter:uppercase">{format(month, "MMMM yyyy", { locale: fr })}</h2>
        <IconButton label="Mois précédent" onClick={() => setMonth(addMonths(month, -1))}><ChevronLeft className="size-4" /></IconButton>
        <IconButton label="Mois suivant" onClick={() => setMonth(addMonths(month, 1))}><ChevronRight className="size-4" /></IconButton>
        <Button size="sm" onClick={() => setMonth(startOfMonth(new Date()))}>Aujourd'hui</Button>
        {noDate > 0 && <span className="ml-auto text-[12.5px] text-faint">{noDate} tâche(s) sans échéance</span>}
      </div>
      <div className="overflow-x-auto">
        <div className="grid min-w-[760px] grid-cols-7 overflow-hidden rounded-2xl border border-line bg-panel shadow-sm">
          {["lun.", "mar.", "mer.", "jeu.", "ven.", "sam.", "dim."].map((d) => <div key={d} className="border-b border-line px-3 py-2 text-[11.5px] font-medium uppercase tracking-wider text-faint">{d}</div>)}
          {days.map((d, i) => {
            const iso = format(d, "yyyy-MM-dd");
            const items = byDay.get(iso) ?? [];
            const isToday = iso === todayIso();
            return (
              <div key={iso} className={cn("group relative min-h-[118px] border-line p-1.5", i % 7 !== 6 && "border-r", i < days.length - 7 && "border-b", !isSameMonth(d, month) && "bg-sidebar/50")}>
                <div className="mb-1 flex items-center justify-between px-1">
                  <span className={cn("flex size-6 items-center justify-center rounded-full text-[12px] tabular", isToday ? "bg-fg font-semibold text-bg" : isSameMonth(d, month) ? "text-muted" : "text-faint")}>{format(d, "d")}</span>
                  {canEdit && <button aria-label="Ajouter une tâche ce jour" onClick={() => create.mutate({ project_id: project.id, title: "Nouvelle tâche", due_on: iso }, { onSuccess: (t) => shell.openTask(t.id) })} className="rounded p-0.5 text-faint opacity-0 hover:bg-hover hover:text-fg group-hover:opacity-100"><Plus className="size-3.5" /></button>}
                </div>
                <div className="space-y-1">
                  {items.slice(0, 4).map((t) => (
                    <button key={t.id} onClick={() => shell.openTask(t.id)}
                      className={cn("flex w-full items-center gap-1.5 rounded-md border-l-2 bg-hover px-1.5 py-1 text-left text-[12px] leading-tight hover:bg-active", t.completed && "opacity-50")}
                      style={{ borderLeftColor: t.priority === "none" ? "var(--line-strong)" : priorityMeta(t.priority).color }}>
                      <span className={cn("min-w-0 flex-1 truncate", t.completed && "line-through")}>{t.title}</span>
                      {t.assignee_id && <Avatar user={users.get(t.assignee_id)} size={14} />}
                    </button>
                  ))}
                  {items.length > 4 && <p className="px-1.5 text-[11.5px] text-faint">+{items.length - 4} autre(s)</p>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
