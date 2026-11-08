import { useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "motion/react";
import { ArrowRight, Sparkles } from "lucide-react";
import { Avatar, Spinner } from "@/components/ui";
import { Logo } from "@/components/Sidebar";
import { api } from "@/lib/api";
import type { User } from "@/lib/types";

export function LoginPage() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const { data: users, isLoading } = useQuery({ queryKey: ["login-users"], queryFn: () => api.get<User[]>("/api/auth/users") });
  const login = async (id: string) => { await api.post("/api/auth/login", { user_id: id }); qc.clear(); nav("/"); };
  return (
    <div className="grain flex min-h-full flex-col bg-bg lg:flex-row">
      <section className="relative flex flex-1 flex-col justify-between overflow-hidden px-6 py-8 sm:px-12 lg:py-12">
        <div className="flex items-center gap-2.5"><Logo size={30} /><span className="text-[16px] font-semibold tracking-[-0.01em]">Cadence</span></div>
        <div className="my-12 max-w-xl lg:my-0">
          <motion.p initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="mb-5 inline-flex items-center gap-1.5 rounded-full border border-ai-line bg-ai-soft px-3 py-1 text-[12px] font-medium text-ai-fg">
            <Sparkles className="size-3.5" />Coéquipiers IA intégrés
          </motion.p>
          <motion.h1 initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }} className="font-serif text-[44px] leading-[1.02] tracking-[-0.02em] sm:text-[64px]">
            Le travail de l'équipe,<br /><span className="ai-text shimmer italic">et ceux qui l'aident.</span>
          </motion.h1>
          <motion.p initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="mt-5 max-w-md text-[15px] leading-relaxed text-muted">
            Projets, tableaux, échéances et des coéquipiers IA à qui l'on confie une tâche comme à un collègue. Ils lisent le contexte, agissent avec leurs propres droits et vous demandent votre accord avant chaque modification.
          </motion.p>
        </div>
        <p className="hidden text-[12px] text-faint lg:block">Espace de démonstration · données d'exemple</p>
      </section>

      <section className="flex w-full items-center justify-center border-t border-line bg-panel px-6 py-10 lg:w-[480px] lg:border-l lg:border-t-0">
        <div className="w-full max-w-sm">
          <h2 className="text-[20px] font-semibold">Choisissez votre profil</h2>
          <p className="mt-1 text-[13px] text-muted">Chaque membre voit les projets auxquels il a accès, avec ses droits.</p>
          <div className="mt-6 space-y-1.5">
            {isLoading && <Spinner />}
            {users?.map((u, i) => (
              <motion.button key={u.id} initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.03 * i }} onClick={() => login(u.id)}
                className="group flex w-full items-center gap-3 rounded-xl border border-line bg-bg/50 px-3 py-2.5 text-left transition-colors hover:border-line-strong hover:bg-hover">
                <Avatar user={u} size={34} />
                <span className="min-w-0 flex-1"><span className="block text-[14px] font-medium">{u.name}</span><span className="block truncate text-[12.5px] text-muted">{u.title}</span></span>
                <ArrowRight className="size-4 text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-fg" />
              </motion.button>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
