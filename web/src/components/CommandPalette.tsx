import { useEffect, useState } from "react";
import { Command } from "cmdk";
import { useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, FolderPlus, House, Inbox, Moon, Search, Sparkles, Wand2 } from "lucide-react";
import { ProjectIcon } from "./ui";
import { useProjects } from "@/lib/hooks";
import { useShell } from "@/lib/shell";
import { api } from "@/lib/api";
import type { ProjectSummary, Task } from "@/lib/types";

export function CommandPalette() {
  const shell = useShell();
  const nav = useNavigate();
  const { data: projects } = useProjects();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => { const t = setTimeout(() => setDebounced(q), 140); return () => clearTimeout(t); }, [q]);
  const { data: results } = useQuery({
    queryKey: ["search", debounced], enabled: debounced.trim().length > 1,
    queryFn: () => api.get<{ tasks: Task[]; projects: ProjectSummary[] }>(`/api/search?q=${encodeURIComponent(debounced)}`),
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); shell.setPalette(!shell.palette); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") { e.preventDefault(); shell.assistant.open ? shell.closeAssistant() : shell.openAssistant(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shell]);
  const run = (fn: () => void) => { shell.setPalette(false); setQ(""); fn(); };
  const projectName = (id: string) => projects?.find((p) => p.id === id);
  const item = "flex h-10 cursor-default select-none items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] text-fg data-[selected=true]:bg-hover";
  const group = "[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-faint";

  return (
    <Command.Dialog open={shell.palette} onOpenChange={shell.setPalette} label="Palette de commandes" shouldFilter={!results}
      overlayClassName="fixed inset-0 z-50 bg-black/25 backdrop-blur-[2px] dark:bg-black/60"
      contentClassName="fixed left-1/2 top-[12vh] z-50 w-[calc(100vw-24px)] max-w-[620px] -translate-x-1/2 overflow-hidden rounded-2xl border border-line bg-panel shadow-lg">
      <div className="flex items-center gap-2.5 border-b border-line px-4">
        <Search className="size-4 text-faint" />
        <Command.Input value={q} onValueChange={setQ} placeholder="Rechercher une tâche, un projet, une action…" className="h-13 flex-1 bg-transparent py-4 text-[15px] outline-none placeholder:text-faint" />
      </div>
      <Command.List className="max-h-[min(60vh,440px)] overflow-y-auto p-2">
        <Command.Empty className="px-3 py-8 text-center text-[13px] text-muted">Aucun résultat.</Command.Empty>
        {q.trim().length > 1 && (
          <Command.Group heading="Demander à l'IA" className={group}>
            <Command.Item value={`ia ${q}`} onSelect={() => run(() => shell.openAssistant(q))} className={item}>
              <Sparkles className="size-4 text-ai-fg" /><span className="flex-1 truncate">« {q} »</span><span className="text-[12px] text-ai-fg">Cadence AI</span>
            </Command.Item>
          </Command.Group>
        )}
        {results && results.tasks.length > 0 && (
          <Command.Group heading="Tâches" className={group}>
            {results.tasks.map((t) => {
              const p = projectName(t.project_id);
              return (
                <Command.Item key={t.id} value={`#${t.number} ${t.title}`} onSelect={() => run(() => { nav(`/projects/${t.project_id}?task=${t.id}`); })} className={item}>
                  <CheckCircle2 className={t.completed ? "size-4 text-success" : "size-4 text-faint"} />
                  <span className="flex-1 truncate">{t.title}</span>
                  {p && <span className="flex items-center gap-1.5 text-[12px] text-faint"><ProjectIcon icon={p.icon} color={p.color} size={14} />{p.name}</span>}
                </Command.Item>
              );
            })}
          </Command.Group>
        )}
        <Command.Group heading="Aller à" className={group}>
          <Command.Item onSelect={() => run(() => nav("/"))} className={item}><House className="size-4 text-muted" />Accueil</Command.Item>
          <Command.Item onSelect={() => run(() => nav("/my-tasks"))} className={item}><CheckCircle2 className="size-4 text-muted" />Mes tâches</Command.Item>
          <Command.Item onSelect={() => run(() => nav("/inbox"))} className={item}><Inbox className="size-4 text-muted" />Boîte de réception</Command.Item>
          <Command.Item onSelect={() => run(() => nav("/ai"))} className={item}><Sparkles className="size-4 text-ai-fg" />Coéquipiers IA</Command.Item>
          {projects?.map((p) => (
            <Command.Item key={p.id} value={`projet ${p.name}`} onSelect={() => run(() => nav(`/projects/${p.id}`))} className={item}>
              <ProjectIcon icon={p.icon} color={p.color} size={16} />{p.name}
            </Command.Item>
          ))}
        </Command.Group>
        <Command.Group heading="Actions" className={group}>
          <Command.Item onSelect={() => run(() => shell.openAssistant())} className={item}><Sparkles className="size-4 text-ai-fg" />Ouvrir Cadence AI<span className="ml-auto text-[12px] text-faint">⌘J</span></Command.Item>
          <Command.Item onSelect={() => run(() => shell.openQuickAdd(null))} className={item}><Wand2 className="size-4 text-ai-fg" />Créer des tâches à partir de notes</Command.Item>
          <Command.Item onSelect={() => run(() => shell.setNewProject(true))} className={item}><FolderPlus className="size-4 text-muted" />Nouveau projet</Command.Item>
          <Command.Item onSelect={() => run(shell.toggleTheme)} className={item}><Moon className="size-4 text-muted" />Changer de thème</Command.Item>
        </Command.Group>
      </Command.List>
    </Command.Dialog>
  );
}
