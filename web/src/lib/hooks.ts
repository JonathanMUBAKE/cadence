import { useEffect, useMemo, useRef } from "react";
import { QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "./api";
import type {
  AiApproval, AiRule, AiRun, AiRunDetail, Activity, Notification, ProjectDetail, ProjectSummary, Stats, Task, TaskDetail, User,
} from "./types";

export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 15_000, refetchOnWindowFocus: false, retry: (n, e) => (e as { status?: number }).status !== 401 && n < 2 } },
});

// ---------------------------------------------------------------- lectures
export const useMe = () => useQuery({ queryKey: ["me"], queryFn: () => api.get<User>("/api/me"), retry: false });
export const useUsers = () => useQuery({ queryKey: ["users"], queryFn: () => api.get<User[]>("/api/users"), staleTime: 60_000 });
export function useUserMap() {
  const { data } = useUsers();
  return useMemo(() => new Map((data ?? []).map((u) => [u.id, u])), [data]);
}
export const useProjects = () => useQuery({ queryKey: ["projects"], queryFn: () => api.get<ProjectSummary[]>("/api/projects") });
export const useProject = (id?: string) => useQuery({ queryKey: ["project", id], queryFn: () => api.get<ProjectDetail>(`/api/projects/${id}`), enabled: !!id });
export const useProjectTasks = (id?: string) => useQuery({ queryKey: ["tasks", "project", id], queryFn: () => api.get<Task[]>(`/api/projects/${id}/tasks`), enabled: !!id });
export const useStats = (id?: string) => useQuery({ queryKey: ["stats", id], queryFn: () => api.get<Stats>(`/api/projects/${id}/stats`), enabled: !!id });
export const useProjectActivity = (id?: string) => useQuery({ queryKey: ["activity", id], queryFn: () => api.get<Activity[]>(`/api/projects/${id}/activity`), enabled: !!id });
export const useProjectUpdates = (id?: string) => useQuery({ queryKey: ["updates", id], queryFn: () => api.get<(Activity & { data: { status: string; headline: string; summary: string; risks: string[]; next_steps: string[] } })[]>(`/api/projects/${id}/updates`), enabled: !!id });
export const useMyTasks = () => useQuery({ queryKey: ["tasks", "mine"], queryFn: () => api.get<Task[]>("/api/tasks?assignee=me&subtasks=true") });
export const useTask = (id?: string | null) => useQuery({ queryKey: ["task", id], queryFn: () => api.get<TaskDetail>(`/api/tasks/${id}`), enabled: !!id });
export const useNotifications = () => useQuery({ queryKey: ["notifications"], queryFn: () => api.get<Notification[]>("/api/notifications") });
export const useApprovals = () => useQuery({ queryKey: ["approvals"], queryFn: () => api.get<AiApproval[]>("/api/ai/approvals") });
export const useAiStatus = () => useQuery({ queryKey: ["ai-status"], queryFn: () => api.get<{ provider: "anthropic" | "demo"; model: string | null }>("/api/ai/status"), staleTime: Infinity });
export const useAgents = () => useQuery({ queryKey: ["agents"], queryFn: () => api.get<User[]>("/api/ai/agents"), staleTime: 60_000 });
export const useRuns = (f: { taskId?: string; projectId?: string }) => useQuery({
  queryKey: ["runs", f.taskId ?? null, f.projectId ?? null],
  queryFn: () => api.get<AiRun[]>(`/api/ai/runs?${new URLSearchParams({ ...(f.taskId ? { task_id: f.taskId } : {}), ...(f.projectId ? { project_id: f.projectId } : {}) })}`),
});
export const useRun = (id?: string | null) => useQuery({ queryKey: ["run", id], queryFn: () => api.get<AiRunDetail>(`/api/ai/runs/${id}`), enabled: !!id });
export const useRules = (projectId?: string) => useQuery({ queryKey: ["rules", projectId], queryFn: () => api.get<AiRule[]>(`/api/projects/${projectId}/ai/rules`), enabled: !!projectId });

// ---------------------------------------------------------------- écritures
const errorToast = (e: unknown) => toast.error((e as Error).message || "Une erreur est survenue");

export function useUpdateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: string } & Partial<Task>) => api.patch<Task>(`/api/tasks/${id}`, patch),
    onMutate: async ({ id, ...patch }) => {
      // Mise à jour optimiste dans toutes les listes en cache
      await qc.cancelQueries({ queryKey: ["tasks"] });
      const snapshots = qc.getQueriesData<Task[]>({ queryKey: ["tasks"] });
      for (const [key, list] of snapshots) if (list) qc.setQueryData(key, list.map((t) => (t.id === id ? { ...t, ...patch } : t)));
      const detail = qc.getQueryData<TaskDetail>(["task", id]);
      if (detail) qc.setQueryData(["task", id], { ...detail, ...patch });
      return { snapshots, detail };
    },
    onError: (e, v, ctx) => {
      ctx?.snapshots.forEach(([k, d]) => qc.setQueryData(k, d));
      if (ctx?.detail) qc.setQueryData(["task", v.id], ctx.detail);
      errorToast(e);
    },
    onSettled: (_d, _e, v) => { invalidateTask(qc, v.id); },
  });
}
export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<Task> & { project_id: string; title: string }) => api.post<Task>("/api/tasks", body),
    onSuccess: (t) => { invalidateTask(qc, t.parent_id ?? t.id); qc.invalidateQueries({ queryKey: ["projects"] }); },
    onError: errorToast,
  });
}
export function useMoveTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; section_id: string; before_id?: string | null; after_id?: string | null }) => api.post<Task>(`/api/tasks/${v.id}/move`, v),
    onError: errorToast,
    onSettled: (_d, _e, v) => invalidateTask(qc, v.id),
  });
}
export function useDeleteTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/api/tasks/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["tasks"] }); qc.invalidateQueries({ queryKey: ["projects"] }); qc.invalidateQueries({ queryKey: ["stats"] }); },
    onError: errorToast,
  });
}
export function useDecide() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; approve: boolean; edits?: Record<string, unknown> }) => api.post<AiApproval>(`/api/ai/approvals/${v.id}`, v),
    onSuccess: (a) => {
      toast.success(a.status === "approved" ? "Action autorisée" : "Action refusée");
      qc.invalidateQueries({ queryKey: ["approvals"] }); qc.invalidateQueries({ queryKey: ["run", a.run_id] }); qc.invalidateQueries({ queryKey: ["notifications"] });
    },
    onError: errorToast,
  });
}

function invalidateTask(qc: QueryClient, id: string) {
  qc.invalidateQueries({ queryKey: ["tasks"] });
  qc.invalidateQueries({ queryKey: ["task", id] });
  qc.invalidateQueries({ queryKey: ["stats"] });
}

// ---------------------------------------------------------------- temps réel
type Live = { type: string; projectId?: string; taskId?: string | null; runId?: string; delta?: string; actorId?: string };
const deltaListeners = new Set<(runId: string, delta: string) => void>();
export const onAiDelta = (fn: (runId: string, delta: string) => void) => { deltaListeners.add(fn); return () => { deltaListeners.delete(fn); }; };

export function useLiveUpdates(enabled: boolean) {
  const qc = useQueryClient();
  const timer = useRef<number | null>(null);
  const pending = useRef(new Set<string>());
  useEffect(() => {
    if (!enabled) return;
    const flush = () => {
      timer.current = null;
      for (const k of pending.current) qc.invalidateQueries({ queryKey: JSON.parse(k) });
      pending.current.clear();
    };
    const queue = (...keys: unknown[][]) => {
      keys.forEach((k) => pending.current.add(JSON.stringify(k)));
      if (timer.current == null) timer.current = window.setTimeout(flush, 120);
    };
    const es = new EventSource("/api/events", { withCredentials: true });
    es.onmessage = (m) => {
      const e = JSON.parse(m.data) as Live;
      if (e.type === "ai.delta") { deltaListeners.forEach((fn) => fn(e.runId!, e.delta!)); return; }
      if (e.type === "notification") return queue(["notifications"]);
      if (e.type.startsWith("ai.")) {
        queue(["runs"], ["run", e.runId], ["approvals"]);
        if (e.taskId) queue(["task", e.taskId]);
        return;
      }
      queue(["tasks"], ["projects"], ["stats"], ["activity"]);
      if (e.projectId) queue(["project", e.projectId]);
      if (e.taskId) queue(["task", e.taskId]);
    };
    return () => { es.close(); if (timer.current) clearTimeout(timer.current); };
  }, [enabled, qc]);
}
