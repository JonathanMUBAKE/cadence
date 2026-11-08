import { useId } from "react";
import { NavLink, useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ChevronsUpDown, House, Inbox, LogOut, Moon, Plus, Search, Sparkles, Sun } from "lucide-react";
import { Avatar, Kbd, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, ProjectIcon, cn } from "./ui";
import { useAiStatus, useApprovals, useMe, useNotifications, useProjects } from "@/lib/hooks";
import { useShell } from "@/lib/shell";
import { api } from "@/lib/api";
import { STATUS } from "@/lib/format";

export function Logo({ size = 26 }: { size?: number }) {
  const gid = useId().replace(/:/g, "");
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="9" fill="var(--fg)" />
      <path d="M8.5 19.5c2.2-5 4.4-7.5 6.6-7.5 3.3 0 3.3 8 6.4 8 1 0 2-.7 3-2" stroke={`url(#${gid})`} strokeWidth="2.6" fill="none" strokeLinecap="round" />
      <defs><linearGradient id={gid} x1="8" x2="25" y1="16" y2="16"><stop stopColor="#B9A7FF" /><stop offset="1" stopColor="#6FD3FF" /></linearGradient></defs>
    </svg>
  );
}

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { data: me } = useMe();
  const { data: projects } = useProjects();
  const { data: notifs } = useNotifications();
  const { data: approvals } = useApprovals();
  const { data: aiStatus } = useAiStatus();
  const shell = useShell();
  const nav = useNavigate();
  const qc = useQueryClient();
  const unread = notifs?.filter((n) => !n.read).length ?? 0;

  const link = (to: string, icon: React.ReactNode, label: string, badge?: number, ai?: boolean) => (
    <NavLink to={to} end={to === "/"} onClick={onNavigate}
      className={({ isActive }) => cn("group flex h-8 items-center gap-2.5 rounded-lg px-2 text-[13.5px] transition-colors",
        isActive ? "bg-active font-medium text-fg" : "text-muted hover:bg-hover hover:text-fg")}>
      <span className={cn("flex w-4 justify-center", ai && "text-ai-fg")}>{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      {!!badge && <span className={cn("min-w-[18px] rounded-full px-1.5 text-center text-[11px] font-semibold tabular", ai ? "bg-ai text-white" : "bg-fg text-bg")}>{badge}</span>}
    </NavLink>
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 px-3 pb-2 pt-3">
        <Menu>
          <MenuTrigger asChild>
            <button className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg p-1.5 text-left hover:bg-hover">
              <Logo />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-semibold leading-tight">Cadence</span>
                <span className="block truncate text-[11.5px] text-faint">Espace Nova Mobile</span>
              </span>
              <ChevronsUpDown className="size-3.5 text-faint" />
            </button>
          </MenuTrigger>
          <MenuContent className="w-[240px]">
            <MenuLabel>Connecté en tant que</MenuLabel>
            <div className="flex items-center gap-2 px-2 pb-2"><Avatar user={me} size={26} /><div className="min-w-0"><p className="truncate text-[13px] font-medium">{me?.name}</p><p className="truncate text-[11.5px] text-faint">{me?.title}</p></div></div>
            <MenuSeparator />
            <MenuItem icon={shell.theme === "dark" ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />} onSelect={shell.toggleTheme}>{shell.theme === "dark" ? "Thème clair" : "Thème sombre"}</MenuItem>
            <MenuItem icon={<LogOut className="size-3.5" />} onSelect={async () => { await api.post("/api/auth/logout"); qc.clear(); nav("/login"); }}>Changer d'utilisateur</MenuItem>
          </MenuContent>
        </Menu>
      </div>

      <div className="px-3 pb-2">
        <button onClick={() => shell.setPalette(true)} className="flex h-8 w-full items-center gap-2 rounded-lg border border-line bg-panel px-2.5 text-[13px] text-faint shadow-sm hover:text-muted">
          <Search className="size-3.5" /><span className="flex-1 text-left">Rechercher…</span><Kbd>⌘</Kbd><Kbd>K</Kbd>
        </button>
      </div>

      <nav className="space-y-0.5 px-3">
        {link("/", <House className="size-4" />, "Accueil")}
        {link("/my-tasks", <CheckCircle2 className="size-4" />, "Mes tâches")}
        {link("/inbox", <Inbox className="size-4" />, "Boîte de réception", unread)}
        {link("/ai", <Sparkles className="size-4" />, "Coéquipiers IA", approvals?.length, true)}
      </nav>

      <div className="mt-5 flex items-center justify-between px-5 pb-1">
        <span className="text-[11.5px] font-medium uppercase tracking-wider text-faint">Projets</span>
        <button aria-label="Nouveau projet" onClick={() => shell.setNewProject(true)} className="rounded-md p-0.5 text-faint hover:bg-hover hover:text-fg"><Plus className="size-3.5" /></button>
      </div>
      <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-3 pb-3">
        {projects?.map((p) => (
          <NavLink key={p.id} to={`/projects/${p.id}`} onClick={onNavigate}
            className={({ isActive }) => cn("group flex h-8 items-center gap-2.5 rounded-lg px-2 text-[13.5px]", isActive ? "bg-active font-medium text-fg" : "text-muted hover:bg-hover hover:text-fg")}>
            <ProjectIcon icon={p.icon} color={p.color} size={18} />
            <span className="flex-1 truncate">{p.name}</span>
            <span className="size-1.5 rounded-full" style={{ background: STATUS[p.status].color }} title={STATUS[p.status].label} />
          </NavLink>
        ))}
      </nav>

      <div className="border-t border-line p-3">
        <button onClick={() => shell.openAssistant()} className="group relative flex w-full items-center gap-2.5 overflow-hidden rounded-xl border border-ai-line bg-ai-soft px-3 py-2.5 text-left">
          <span className="flex size-7 items-center justify-center rounded-lg bg-[conic-gradient(from_200deg,var(--ai),#4FB3F0,var(--ai))] text-white shadow-sm"><Sparkles className="size-3.5" /></span>
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-semibold text-ai-fg">Demander à Cadence AI</span>
            <span className="block truncate text-[11.5px] text-muted">{aiStatus?.provider === "anthropic" ? "Propulsé par Claude" : "Mode démo · sans clé API"}</span>
          </span>
          <span className="flex gap-0.5"><Kbd>⌘</Kbd><Kbd>J</Kbd></span>
        </button>
      </div>
    </div>
  );
}
