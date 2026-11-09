import { useEffect, useState } from "react";
import { Navigate, Outlet, useLocation } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import { Menu as MenuIcon, Search, Sparkles } from "lucide-react";
import { Sidebar, Logo } from "./Sidebar";
import { TaskDrawer } from "./TaskDrawer";
import { Assistant } from "./Assistant";
import { CommandPalette } from "./CommandPalette";
import { NewProjectDialog, QuickAddDialog } from "./dialogs";
import { IconButton, Spinner } from "./ui";
import { useLiveUpdates, useMe } from "@/lib/hooks";
import { ShellProvider, useShell } from "@/lib/shell";
import { ApiError } from "@/lib/api";

export function AppLayout() {
  const me = useMe();
  const loc = useLocation();
  useLiveUpdates(!!me.data);
  if (me.isLoading) return <div className="flex h-full items-center justify-center"><Spinner /></div>;
  if (me.error && (me.error as ApiError).status === 401) return <Navigate to="/login" replace />;
  if (me.error) return <div className="p-8 text-danger">{(me.error as Error).message}</div>;
  // Un administrateur système n'appartient pas forcément à une organisation
  if (me.data && !me.data.orgs.length && !["/admin", "/account"].includes(loc.pathname)) return <Navigate to={me.data.platform_role ? "/admin" : "/account"} replace />;
  return <ShellProvider><Shell /></ShellProvider>;
}

function Shell() {
  const shell = useShell();
  const [mobileNav, setMobileNav] = useState(false);
  const loc = useLocation();
  useEffect(() => setMobileNav(false), [loc.pathname]);
  return (
    <div className="flex h-full">
      <aside className="hidden w-[256px] shrink-0 border-r border-line bg-sidebar lg:block">
        <Sidebar />
      </aside>
      <AnimatePresence>
        {mobileNav && (
          <>
            <motion.div key="s" className="fixed inset-0 z-40 bg-black/30 lg:hidden" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setMobileNav(false)} />
            <motion.aside key="n" className="fixed inset-y-0 left-0 z-50 w-[280px] border-r border-line bg-sidebar shadow-lg lg:hidden" initial={{ x: -280 }} animate={{ x: 0 }} exit={{ x: -280 }} transition={{ type: "spring", stiffness: 420, damping: 40 }}>
              <Sidebar onNavigate={() => setMobileNav(false)} />
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3 lg:hidden">
          <IconButton label="Menu" onClick={() => setMobileNav(true)}><MenuIcon className="size-4" /></IconButton>
          <Logo size={22} /><span className="text-[14px] font-semibold">Cadence</span>
          <div className="ml-auto flex items-center gap-1">
            <IconButton label="Rechercher" onClick={() => shell.setPalette(true)}><Search className="size-4" /></IconButton>
            <IconButton label="Cadence AI" onClick={() => shell.openAssistant()} className="text-ai-fg"><Sparkles className="size-4" /></IconButton>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Outlet />
        </div>
      </main>

      <TaskDrawer taskId={shell.taskId} onClose={shell.closeTask} onOpenTask={shell.openTask} />
      <Assistant />
      <CommandPalette />
      <NewProjectDialog />
      <QuickAddDialog />
    </div>
  );
}
