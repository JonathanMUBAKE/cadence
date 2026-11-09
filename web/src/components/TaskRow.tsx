import { memo } from "react";
import { Sparkles } from "lucide-react";
import { Avatar, Checkbox, ProjectIcon, cn } from "./ui";
import { DueChip, PriorityFlag } from "./pickers";
import { TaskMetaRow } from "./TaskDrawer";
import type { ProjectSummary, Task, User } from "@/lib/types";

/** Ligne de tâche réutilisée par la vue Liste, Mes tâches et l'accueil. */
export const TaskRow = memo(function TaskRow({
  t,
  assignee,
  onOpen,
  onToggle,
  aiActive,
  project,
  dense,
  canEdit = true,
}: {
  t: Task;
  assignee?: User | null;
  onOpen: () => void;
  onToggle: (v: boolean) => void;
  aiActive?: boolean;
  project?: ProjectSummary;
  dense?: boolean;
  canEdit?: boolean;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => e.key === "Enter" && onOpen()}
      className={cn(
        "group flex cursor-default items-center gap-3 border-b border-line px-3 transition-colors hover:bg-hover sm:px-4",
        dense ? "h-10" : "h-11",
      )}
    >
      <Checkbox checked={t.completed} onChange={(v) => canEdit && onToggle(v)} />
      <span
        className={cn("min-w-0 flex-1 truncate text-[13.5px]", t.completed && "text-faint line-through decoration-1")}
      >
        {t.title}
      </span>
      {aiActive && (
        <span className="flex items-center gap-1 rounded-md bg-ai-soft px-1.5 py-0.5 text-[11.5px] font-medium text-ai-fg">
          <Sparkles className="pulse-dot size-3" />
          IA au travail
        </span>
      )}
      <span className="hidden items-center gap-3 md:flex">
        <TaskMetaRow t={t} />
      </span>
      {project && (
        <span className="hidden max-w-[180px] items-center gap-1.5 truncate text-[12px] text-muted sm:flex">
          <ProjectIcon icon={project.icon} color={project.color} size={16} />
          <span className="truncate">{project.name}</span>
        </span>
      )}
      <span className="w-5">
        <PriorityFlag p={t.priority} />
      </span>
      <span className="w-[92px] text-right">
        <DueChip due={t.due_on} done={t.completed} />
      </span>
      <span className="w-6">
        <Avatar user={assignee} size={22} />
      </span>
    </div>
  );
});
