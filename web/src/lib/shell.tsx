import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router";

interface Shell {
  openTask: (id: string) => void;
  closeTask: () => void;
  taskId: string | null;
  assistant: { open: boolean; prompt: string | null };
  openAssistant: (prompt?: string) => void;
  closeAssistant: () => void;
  palette: boolean;
  setPalette: (v: boolean) => void;
  newProject: boolean;
  newProjectTeam: string | null;
  setNewProject: (v: boolean, teamId?: string | null) => void;
  quickAdd: { open: boolean; projectId: string | null };
  openQuickAdd: (projectId: string | null) => void;
  closeQuickAdd: () => void;
  theme: "light" | "dark";
  toggleTheme: () => void;
}

const Ctx = createContext<Shell | null>(null);
export const useShell = () => { const c = useContext(Ctx); if (!c) throw new Error("ShellProvider manquant"); return c; };

export function ShellProvider({ children }: { children: ReactNode }) {
  const [params, setParams] = useSearchParams();
  const taskId = params.get("task");
  const [assistant, setAssistant] = useState<{ open: boolean; prompt: string | null }>({ open: false, prompt: null });
  const [palette, setPalette] = useState(false);
  const [newProject, setNewProjectState] = useState<{ open: boolean; team: string | null }>({ open: false, team: null });
  const [quickAdd, setQuickAdd] = useState<{ open: boolean; projectId: string | null }>({ open: false, projectId: null });
  const [theme, setTheme] = useState<"light" | "dark">(() => (document.documentElement.classList.contains("dark") ? "dark" : "light"));

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    try { localStorage.setItem("cadence-theme", theme); } catch { /* stockage indisponible */ }
  }, [theme]);

  const openTask = useCallback((id: string) => setParams((p) => { const n = new URLSearchParams(p); n.set("task", id); return n; }), [setParams]);
  const closeTask = useCallback(() => setParams((p) => { const n = new URLSearchParams(p); n.delete("task"); return n; }), [setParams]);

  const value = useMemo<Shell>(() => ({
    openTask, closeTask, taskId,
    assistant, openAssistant: (prompt) => setAssistant({ open: true, prompt: prompt ?? null }), closeAssistant: () => setAssistant({ open: false, prompt: null }),
    palette, setPalette, newProject: newProject.open, newProjectTeam: newProject.team,
    setNewProject: (v, teamId = null) => setNewProjectState({ open: v, team: v ? teamId : null }),
    quickAdd, openQuickAdd: (projectId) => setQuickAdd({ open: true, projectId }), closeQuickAdd: () => setQuickAdd({ open: false, projectId: null }),
    theme, toggleTheme: () => setTheme((t) => (t === "dark" ? "light" : "dark")),
  }), [openTask, closeTask, taskId, assistant, palette, newProject, quickAdd, theme]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
