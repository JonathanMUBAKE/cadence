import { useMemo } from "react";
import { addDays, differenceInCalendarDays, format, parseISO, startOfWeek } from "date-fns";
import { fr } from "date-fns/locale";
import { Avatar, cn } from "@/components/ui";
import { useUserMap } from "@/lib/hooks";
import { useShell } from "@/lib/shell";
import type { ViewProps } from "@/pages/Project";

const DAY = 30;
const WEEKS = 9;

export function TimelineView({ project, tasks, aiActive }: ViewProps) {
  const users = useUserMap();
  const shell = useShell();
  const start = useMemo(() => startOfWeek(addDays(new Date(), -14), { weekStartsOn: 1 }), []);
  const days = WEEKS * 7;
  const x = (iso: string) => differenceInCalendarDays(parseISO(iso + "T12:00:00"), start) * DAY;
  const todayX = differenceInCalendarDays(new Date(), start) * DAY;
  const scheduled = tasks.filter((t) => t.due_on);
  const rows = project.sections
    .map((s) => ({
      s,
      items: scheduled
        .filter((t) => t.section_id === s.id)
        .sort((a, b) => ((a.start_on ?? a.due_on!) < (b.start_on ?? b.due_on!) ? -1 : 1)),
    }))
    .filter((r) => r.items.length);

  return (
    <div className="py-5">
      <div className="mx-4 overflow-x-auto rounded-2xl border border-line bg-panel shadow-sm sm:mx-8">
        <div className="relative" style={{ width: 240 + days * DAY }}>
          {/* En-tête des semaines */}
          <div className="sticky top-0 z-10 flex border-b border-line bg-panel">
            <div className="sticky left-0 z-20 w-[240px] shrink-0 border-r border-line bg-panel px-4 py-2 text-[11.5px] font-medium uppercase tracking-wider text-faint">
              Tâche
            </div>
            {Array.from({ length: WEEKS }, (_, w) => {
              const d = addDays(start, w * 7);
              return (
                <div key={w} className="shrink-0 border-r border-line" style={{ width: 7 * DAY }}>
                  <div className="px-2 pt-1.5 text-[12px] font-medium">{format(d, "d MMM", { locale: fr })}</div>
                  <div className="flex">
                    {Array.from({ length: 7 }, (_, i) => (
                      <div key={i} className="pb-1 text-center text-[10.5px] text-faint" style={{ width: DAY }}>
                        {format(addDays(d, i), "EEEEE", { locale: fr })}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          {/* Aujourd'hui */}
          <div
            className="pointer-events-none absolute bottom-0 top-0 z-[5] w-px bg-danger"
            style={{ left: 240 + todayX + DAY / 2 }}
          >
            <span className="absolute -top-0 left-1 rounded bg-danger px-1 text-[10px] font-medium text-white">
              Auj.
            </span>
          </div>
          {rows.map(({ s, items }) => (
            <div key={s.id}>
              <div className="flex h-8 items-center border-b border-line bg-sidebar/60">
                <div className="sticky left-0 w-[240px] px-4 text-[12px] font-semibold">{s.name}</div>
              </div>
              {items.map((t) => {
                const end = x(t.due_on!) + DAY;
                const begin = t.start_on ? x(t.start_on) : end - 3 * DAY;
                const left = Math.max(0, begin),
                  width = Math.max(DAY, Math.min(days * DAY, end) - left);
                const u = t.assignee_id ? users.get(t.assignee_id) : null;
                const color = u?.avatar_color ?? "var(--faint)";
                const late = !t.completed && t.due_on! < format(new Date(), "yyyy-MM-dd");
                return (
                  <div key={t.id} className="group flex h-10 items-center border-b border-line hover:bg-hover">
                    <button
                      onClick={() => shell.openTask(t.id)}
                      className="sticky left-0 z-[6] flex h-full w-[240px] shrink-0 items-center gap-2 border-r border-line bg-panel px-4 text-left group-hover:bg-[color-mix(in_oklab,var(--panel),var(--fg)_4%)]"
                    >
                      <Avatar user={u} size={18} />
                      <span className={cn("truncate text-[13px]", t.completed && "text-faint line-through")}>
                        {t.title}
                      </span>
                    </button>
                    <div className="relative h-full" style={{ width: days * DAY }}>
                      {Array.from({ length: WEEKS }, (_, w) => (
                        <div
                          key={w}
                          className="absolute bottom-0 top-0 border-r border-line/60"
                          style={{ left: (w + 1) * 7 * DAY }}
                        />
                      ))}
                      {end > 0 && begin < days * DAY && (
                        <button
                          onClick={() => shell.openTask(t.id)}
                          title={t.title}
                          className={cn(
                            "absolute top-1/2 h-6 -translate-y-1/2 overflow-hidden rounded-md px-2 text-left text-[11.5px] font-medium text-white shadow-sm transition-transform hover:scale-y-110",
                            aiActive.has(t.id) && "ai-ring",
                            t.completed && "opacity-45",
                          )}
                          style={{
                            left,
                            width,
                            background: `linear-gradient(90deg, ${color}, color-mix(in oklab, ${color} 75%, black))`,
                            outline: late ? "2px solid var(--danger)" : undefined,
                            outlineOffset: 1,
                          }}
                        >
                          <span className="block truncate leading-6">{t.title}</span>
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
          {rows.length === 0 && (
            <p className="px-4 py-10 text-center text-[13px] text-muted">
              Aucune tâche planifiée. Ajoutez des échéances pour les voir ici.
            </p>
          )}
        </div>
      </div>
      <p className="mx-4 mt-2 text-[12px] text-faint sm:mx-8">
        Les barres vont de la date de début (ou trois jours avant l'échéance) jusqu'à l'échéance. Contour rouge : en
        retard.
      </p>
    </div>
  );
}
