import { useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  closestCorners,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type Collision,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Sparkles } from "lucide-react";
import { Avatar, Checkbox, Chip, cn } from "@/components/ui";
import { DueChip, PriorityFlag } from "@/components/pickers";
import { SubtaskProgress } from "@/components/TaskDrawer";
import { InlineAdd } from "./ListView";
import { SectionMenu } from "@/components/SectionMenu";
import { useMoveTask, useUpdateTask, useUserMap } from "@/lib/hooks";
import { useShell } from "@/lib/shell";
import type { Task, User } from "@/lib/types";
import type { ViewProps } from "@/pages/Project";

type Columns = Record<string, string[]>;

export function BoardView({ project, tasks, aiActive, canEdit }: ViewProps) {
  const users = useUserMap();
  const shell = useShell();
  const move = useMoveTask();
  const update = useUpdateTask();
  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const derive = () =>
    Object.fromEntries(
      project.sections.map((s) => [
        s.id,
        tasks
          .filter((t) => t.section_id === s.id)
          .sort((a, b) => a.position - b.position)
          .map((t) => t.id),
      ]),
    ) as Columns;
  const [cols, setCols] = useState<Columns>(derive);
  const [dragging, setDragging] = useState<string | null>(null);
  const lastOver = useRef<Collision[]>([]);
  useEffect(() => {
    if (!dragging) setCols(derive());
  }, [tasks, project.sections]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const columnOf = (id: string) => (cols[id] ? id : Object.keys(cols).find((k) => cols[k].includes(id)));
  // La colonne sous le pointeur décide : comparer les coins faisait gagner les cartes voisines face à une colonne vide ou courte
  const collision: CollisionDetection = (args) => {
    const { droppableContainers, pointerCoordinates } = args;
    if (!pointerCoordinates) return closestCorners(args);
    const column = pointerWithin({
      ...args,
      droppableContainers: droppableContainers.filter((c) => cols[String(c.id)]),
    })[0];
    // Entre deux colonnes, on garde la dernière cible : recalculer ferait sauter la carte d'une colonne à l'autre sans fin
    if (!column) return lastOver.current;
    const inColumn = new Set(cols[String(column.id)]);
    const cards = droppableContainers.filter((c) => inColumn.has(String(c.id)));
    lastOver.current = cards.length ? closestCenter({ ...args, droppableContainers: cards }) : [column];
    return lastOver.current;
  };

  const onStart = (e: DragStartEvent) => {
    lastOver.current = [];
    setDragging(String(e.active.id));
  };
  const onOver = (e: DragOverEvent) => {
    const a = String(e.active.id),
      o = e.over ? String(e.over.id) : null;
    if (!o) return;
    const from = columnOf(a),
      to = columnOf(o);
    if (!from || !to || from === to) return;
    setCols((c) => {
      const src = c[from].filter((x) => x !== a);
      const dst = [...c[to]];
      const idx = c[to].includes(o) ? dst.indexOf(o) : dst.length;
      dst.splice(idx, 0, a);
      return { ...c, [from]: src, [to]: dst };
    });
  };
  const onEnd = (e: DragEndEvent) => {
    const a = String(e.active.id),
      o = e.over ? String(e.over.id) : null;
    setDragging(null);
    if (!o) {
      setCols(derive());
      return;
    }
    const col = columnOf(a)!;
    let list = cols[col];
    if (list.includes(o) && o !== a) {
      const from = list.indexOf(a),
        to = list.indexOf(o);
      list = [...list];
      list.splice(from, 1);
      list.splice(to, 0, a);
      setCols({ ...cols, [col]: list });
    }
    const i = list.indexOf(a);
    const t = byId.get(a)!;
    const before = list[i + 1] ?? null,
      after = list[i - 1] ?? null;
    if (t.section_id === col && derive()[col].join() === list.join()) return; // déposée à sa place
    move.mutate({ id: a, section_id: col, before_id: before, after_id: after }, { onError: () => setCols(derive()) });
  };

  const active = dragging ? byId.get(dragging) : null;
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collision}
      onDragStart={onStart}
      onDragOver={onOver}
      onDragEnd={onEnd}
      onDragCancel={() => {
        setDragging(null);
        setCols(derive());
      }}
    >
      <div className="flex h-full gap-3 overflow-x-auto px-4 py-5 sm:px-8">
        {project.sections.map((s) => (
          <Column
            key={s.id}
            id={s.id}
            name={s.name}
            count={cols[s.id]?.length ?? 0}
            done={(cols[s.id] ?? []).filter((id) => byId.get(id)?.completed).length}
            menu={
              canEdit ? (
                <SectionMenu
                  section={s}
                  sections={project.sections}
                  taskCount={cols[s.id]?.length ?? 0}
                  canDelete={project.role === "admin"}
                />
              ) : undefined
            }
          >
            <SortableContext items={cols[s.id] ?? []} strategy={verticalListSortingStrategy}>
              {(cols[s.id] ?? []).map((id) => {
                const t = byId.get(id);
                if (!t) return null;
                return (
                  <SortableCard
                    key={id}
                    t={t}
                    disabled={!canEdit}
                    assignee={t.assignee_id ? users.get(t.assignee_id) : null}
                    ai={aiActive.has(id)}
                    onOpen={() => shell.openTask(id)}
                    onToggle={(v) => update.mutate({ id, completed: v })}
                  />
                );
              })}
            </SortableContext>
            {canEdit && <InlineAdd projectId={project.id} sectionId={s.id} compact />}
          </Column>
        ))}
      </div>
      <DragOverlay dropAnimation={{ duration: 180, easing: "cubic-bezier(.2,.8,.2,1)" }}>
        {active && (
          <Card
            t={active}
            assignee={active.assignee_id ? users.get(active.assignee_id) : null}
            ai={aiActive.has(active.id)}
            overlay
          />
        )}
      </DragOverlay>
    </DndContext>
  );
}

function Column({
  id,
  name,
  count,
  done,
  menu,
  children,
}: {
  id: string;
  name: string;
  count: number;
  done: number;
  menu?: React.ReactNode;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <section
      ref={setNodeRef}
      className={cn(
        "flex w-[288px] shrink-0 flex-col rounded-2xl border bg-sidebar/60 transition-colors",
        isOver ? "border-line-strong" : "border-transparent",
      )}
    >
      <header className="flex h-11 items-center gap-2 px-3">
        <span className="text-[13px] font-semibold">{name}</span>
        <span className="text-[12px] tabular text-faint">{count}</span>
        {count > 0 && (
          <span className="ml-auto h-1 w-12 overflow-hidden rounded-full bg-active">
            <span className="block h-full rounded-full bg-success" style={{ width: `${(done / count) * 100}%` }} />
          </span>
        )}
        <span className={count > 0 ? "" : "ml-auto"}>{menu}</span>
      </header>
      <div className="flex min-h-[60px] flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">{children}</div>
    </section>
  );
}

function SortableCard(props: {
  t: Task;
  assignee?: User | null;
  ai: boolean;
  onOpen: () => void;
  onToggle: (v: boolean) => void;
  disabled: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.t.id,
    disabled: props.disabled,
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      {...attributes}
      {...listeners}
      className={cn(isDragging && "opacity-30")}
    >
      <Card {...props} />
    </div>
  );
}

function Card({
  t,
  assignee,
  ai,
  onOpen,
  onToggle,
  overlay,
}: {
  t: Task;
  assignee?: User | null;
  ai: boolean;
  onOpen?: () => void;
  onToggle?: (v: boolean) => void;
  overlay?: boolean;
}) {
  return (
    <article
      onClick={onOpen}
      className={cn(
        "group relative rounded-xl border bg-panel p-3 shadow-sm transition-[box-shadow,border-color] hover:border-line-strong hover:shadow-md",
        ai ? "ai-ring border-transparent" : "border-line",
        overlay && "rotate-[1.5deg] cursor-grabbing shadow-lg",
      )}
    >
      <div className="flex items-start gap-2">
        <span className="pt-[1px]">
          <Checkbox checked={t.completed} size={16} onChange={(v) => onToggle?.(v)} />
        </span>
        <p
          className={cn(
            "flex-1 text-[13.5px] font-medium leading-snug",
            t.completed && "text-faint line-through decoration-1",
          )}
        >
          {t.title}
        </p>
      </div>
      {(t.tags.length > 0 || ai) && (
        <div className="mt-2 flex flex-wrap gap-1 pl-6">
          {ai && (
            <Chip tone="ai" icon={<Sparkles className="pulse-dot size-3" />}>
              IA au travail
            </Chip>
          )}
          {t.tags.slice(0, 3).map((tg) => (
            <Chip key={tg}>{tg}</Chip>
          ))}
        </div>
      )}
      <div className="mt-2.5 flex items-center gap-2.5 pl-6">
        <DueChip due={t.due_on} done={t.completed} />
        <PriorityFlag p={t.priority} />
        <SubtaskProgress t={t} />
        <span className="ml-auto">
          <Avatar user={assignee} size={22} />
        </span>
      </div>
    </article>
  );
}
