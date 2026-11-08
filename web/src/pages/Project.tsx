import { useMemo, useState } from "react";
import { NavLink, useParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { BarChart3, CalendarDays, ChartNoAxesGantt, Check, ChevronDown, LayoutList, Plus, Sparkles, SquareKanban, UserPlus, Wand2, Zap } from "lucide-react";
import { Avatar, AvatarStack, Button, Menu, MenuContent, MenuItem, MenuTrigger, Popover, PopoverContent, PopoverTrigger, ProjectIcon, Spinner, cn } from "@/components/ui";
import { DueChip, DuePicker } from "@/components/pickers";
import { StatusUpdateDialog } from "@/components/dialogs";
import { isActive } from "@/components/ai";
import { useProject, useProjectTasks, useRuns, useUserMap, useUsers } from "@/lib/hooks";
import { useShell } from "@/lib/shell";
import { STATUS } from "@/lib/format";
import { api } from "@/lib/api";
import type { ProjectDetail, ProjectStatus, Role, Task } from "@/lib/types";
import { ListView } from "@/views/ListView";
import { BoardView } from "@/views/BoardView";
import { CalendarView } from "@/views/CalendarView";
import { TimelineView } from "@/views/TimelineView";
import { DashboardView } from "@/views/DashboardView";
import { AutomationsView } from "@/views/AutomationsView";

export interface ViewProps { project: ProjectDetail; tasks: Task[]; aiActive: Set<string>; canEdit: boolean }

const VIEWS = [
  { id: "list", label: "Liste", icon: LayoutList },
  { id: "board", label: "Tableau", icon: SquareKanban },
  { id: "calendar", label: "Calendrier", icon: CalendarDays },
  { id: "timeline", label: "Chronologie", icon: ChartNoAxesGantt },
  { id: "dashboard", label: "Tableau de bord", icon: BarChart3 },
  { id: "automations", label: "Automatisations", icon: Zap },
] as const;

export function ProjectPage() {
  const { id, view = "list" } = useParams();
  const { data: project, error } = useProject(id);
  const { data: tasks } = useProjectTasks(id);
  const { data: runs } = useRuns({ projectId: id });
  const shell = useShell();
  const qc = useQueryClient();
  const [statusOpen, setStatusOpen] = useState(false);
  const aiActive = useMemo(() => new Set((runs ?? []).filter((r) => isActive(r.status) && r.task_id).map((r) => r.task_id!)), [runs]);

  if (error) return <div className="p-8 text-[14px] text-danger">{(error as Error).message}</div>;
  if (!project || !tasks) return <div className="flex h-64 items-center justify-center"><Spinner /></div>;
  const canEdit = project.role === "editor" || project.role === "admin";
  const patch = (body: Record<string, unknown>) => api.patch(`/api/projects/${project.id}`, body).then(() => { qc.invalidateQueries({ queryKey: ["project", project.id] }); qc.invalidateQueries({ queryKey: ["projects"] }); }, (e) => toast.error(e.message));
  const props: ViewProps = { project, tasks, aiActive, canEdit };
  const addTask = async () => {
    if (!canEdit) return;
    const t = await api.post<Task>("/api/tasks", { project_id: project.id, title: "Nouvelle tâche" }).catch((e) => { toast.error(e.message); return null; });
    if (t) { qc.invalidateQueries({ queryKey: ["tasks"] }); shell.openTask(t.id); }
  };

  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b border-line px-4 pt-5 sm:px-8 sm:pt-7">
        <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
          <ProjectIcon icon={project.icon} color={project.color} size={40} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <ProjectTitle project={project} canEdit={canEdit} onSave={(name) => patch({ name })} />
              <Menu>
                <MenuTrigger asChild disabled={!canEdit}>
                  <button className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-[12.5px] font-medium" style={{ background: STATUS[project.status].soft, color: STATUS[project.status].color }}>
                    <span className="size-1.5 rounded-full bg-current" />{STATUS[project.status].label}{canEdit && <ChevronDown className="size-3" />}
                  </button>
                </MenuTrigger>
                <MenuContent>
                  {(Object.keys(STATUS) as ProjectStatus[]).map((s) => <MenuItem key={s} onSelect={() => patch({ status: s })} icon={<span className="size-2 rounded-full" style={{ background: STATUS[s].color }} />} right={project.status === s ? <Check className="size-3.5" /> : undefined}>{STATUS[s].label}</MenuItem>)}
                </MenuContent>
              </Menu>
              <DuePicker value={project.due_on} onChange={(d) => canEdit && patch({ due_on: d })}>
                <button disabled={!canEdit} className="flex h-7 items-center rounded-lg px-1.5 hover:bg-hover"><DueChip due={project.due_on} empty={<span className="text-[12.5px] text-faint">Échéance</span>} /></button>
              </DuePicker>
            </div>
            {project.description && <p className="mt-1 line-clamp-2 max-w-3xl text-[13px] text-muted">{project.description}</p>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Members project={project} />
            <Button variant="ai" icon={<Sparkles className="size-3.5" />} onClick={() => setStatusOpen(true)}>Point d'avancement</Button>
            {canEdit && <Button variant="ai" icon={<Wand2 className="size-3.5" />} onClick={() => shell.openQuickAdd(project.id)} className="hidden sm:inline-flex">Notes → tâches</Button>}
            {canEdit && <Button variant="primary" icon={<Plus className="size-3.5" />} onClick={addTask}>Tâche</Button>}
          </div>
        </div>
        <nav className="-mb-px mt-5 flex gap-1 overflow-x-auto">
          {VIEWS.map((v) => (
            <NavLink key={v.id} to={`/projects/${project.id}/${v.id === "list" ? "" : v.id}`} end
              className={() => cn("flex h-9 shrink-0 items-center gap-1.5 border-b-2 px-2.5 text-[13px]", view === v.id ? "border-fg font-medium text-fg" : "border-transparent text-muted hover:text-fg")}>
              <v.icon className={cn("size-3.5", v.id === "automations" && "text-ai-fg")} />{v.label}
            </NavLink>
          ))}
        </nav>
      </header>
      <div className="min-h-0 flex-1">
        {view === "list" && <ListView {...props} />}
        {view === "board" && <BoardView {...props} />}
        {view === "calendar" && <CalendarView {...props} />}
        {view === "timeline" && <TimelineView {...props} />}
        {view === "dashboard" && <DashboardView {...props} onStatusUpdate={() => setStatusOpen(true)} />}
        {view === "automations" && <AutomationsView {...props} />}
      </div>
      <StatusUpdateDialog projectId={project.id} open={statusOpen} onOpenChange={setStatusOpen} />
    </div>
  );
}

function ProjectTitle({ project, canEdit, onSave }: { project: ProjectDetail; canEdit: boolean; onSave: (v: string) => void }) {
  const [v, setV] = useState(project.name);
  return (
    <input value={v} disabled={!canEdit} onChange={(e) => setV(e.target.value)} onBlur={() => v.trim() && v !== project.name && onSave(v.trim())}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      className="min-w-0 max-w-full rounded-md px-1 -mx-1 [field-sizing:content] bg-transparent text-[22px] font-semibold tracking-[-0.02em] outline-none hover:bg-hover focus:bg-hover disabled:hover:bg-transparent sm:text-[24px]" />
  );
}

const ROLES: { value: Role; label: string }[] = [{ value: "admin", label: "Administrateur" }, { value: "editor", label: "Éditeur" }, { value: "commenter", label: "Commentateur" }, { value: "viewer", label: "Lecteur" }];

function Members({ project }: { project: ProjectDetail }) {
  const users = useUserMap();
  const { data: all } = useUsers();
  const qc = useQueryClient();
  const isAdmin = project.role === "admin";
  const set = (userId: string, role: Role | null) => api.put(`/api/projects/${project.id}/members/${userId}`, { role }).then(() => qc.invalidateQueries({ queryKey: ["project", project.id] }), (e) => toast.error(e.message));
  const outside = (all ?? []).filter((u) => u.id !== "ai_cadence" && !project.members.some((m) => m.user_id === u.id));
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className="flex h-8 items-center gap-1.5 rounded-lg px-1.5 hover:bg-hover"><AvatarStack users={project.members.map((m) => users.get(m.user_id))} max={5} size={24} /></button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[330px] p-2">
        <p className="px-1.5 pb-2 pt-1 text-[12px] font-medium uppercase tracking-wider text-faint">Membres · {project.members.length}</p>
        <div className="max-h-[300px] overflow-y-auto">
          {project.members.map((m) => {
            const u = users.get(m.user_id);
            return (
              <div key={m.user_id} className="flex h-10 items-center gap-2.5 rounded-md px-1.5 hover:bg-hover">
                <Avatar user={u} size={24} />
                <span className="min-w-0 flex-1 truncate text-[13px]">{u?.name}{u?.is_ai && <span className="ml-1.5 text-[11px] text-ai-fg">IA</span>}</span>
                {isAdmin ? (
                  <select value={m.role} onChange={(e) => set(m.user_id, e.target.value === "remove" ? null : (e.target.value as Role))} className="rounded-md bg-transparent px-1 py-0.5 text-[12px] text-muted outline-none hover:bg-active">
                    {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}<option value="remove">Retirer</option>
                  </select>
                ) : <span className="text-[12px] text-faint">{ROLES.find((r) => r.value === m.role)?.label}</span>}
              </div>
            );
          })}
        </div>
        {isAdmin && outside.length > 0 && (
          <div className="mt-1 border-t border-line pt-2">
            <p className="flex items-center gap-1.5 px-1.5 pb-1 text-[12px] text-muted"><UserPlus className="size-3.5" />Ajouter</p>
            {outside.map((u) => (
              <button key={u.id} onClick={() => set(u.id, "editor")} className="flex h-9 w-full items-center gap-2.5 rounded-md px-1.5 text-left text-[13px] hover:bg-hover">
                <Avatar user={u} size={20} /><span className="flex-1 truncate">{u.name}</span>{u.is_ai && <span className="text-[11px] text-ai-fg">Coéquipier IA</span>}
              </button>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
