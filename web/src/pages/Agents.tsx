import { useState } from "react";
import { motion } from "motion/react";
import { ShieldCheck, Sparkles, Eye, Hand, ScrollText } from "lucide-react";
import { Avatar, Chip, Empty, ProjectIcon, cn } from "@/components/ui";
import { ApprovalCard, RUN_STATUS, RunTimeline, isActive } from "@/components/ai";
import { useAgents, useAiStatus, useApprovals, useProjects, useRuns, useUserMap } from "@/lib/hooks";
import { useShell } from "@/lib/shell";
import { ago } from "@/lib/format";

export function AgentsPage() {
  const { data: agents } = useAgents();
  const { data: projects } = useProjects();
  const { data: runs } = useRuns({});
  const { data: approvals } = useApprovals();
  const { data: ai } = useAiStatus();
  const users = useUserMap();
  const shell = useShell();
  const [selected, setSelected] = useState<string | null>(null);
  const run = selected ?? runs?.[0]?.id ?? null;

  return (
    <div className="mx-auto max-w-[1180px] px-4 pb-16 pt-8 sm:px-8">
      <header className="mb-8">
        <p className="flex items-center gap-1.5 text-[12px] font-medium uppercase tracking-wider text-ai-fg"><Sparkles className="size-3.5" />Coéquipiers IA</p>
        <h1 className="mt-2 font-serif text-[38px] leading-[1.05] tracking-[-0.02em] sm:text-[46px]">Des collègues qui ne dorment jamais,<br className="hidden sm:block" /> et qui demandent la permission.</h1>
        <p className="mt-3 max-w-2xl text-[13.5px] text-muted">
          {ai?.provider === "anthropic" ? `Propulsés par Claude (${ai.model}).` : "Mode démo : les décisions sont simulées par un moteur de règles tant qu'aucune clé ANTHROPIC_API_KEY n'est configurée sur le serveur."}
          {" "}Assignez-leur une tâche, mentionnez-les dans un commentaire, ou créez une règle d'automatisation dans un projet.
        </p>
      </header>

      <div className="mb-10 grid grid-cols-1 gap-3 md:grid-cols-3">
        {[
          { icon: Eye, title: "Contexte", text: "Ils lisent le graphe de travail : la tâche, son projet, ses membres, l'historique et leurs souvenirs." },
          { icon: Hand, title: "Validations", text: "Chaque création, modification ou commentaire attend l'accord d'un humain, qui peut aussi retoucher l'action." },
          { icon: ShieldCheck, title: "Droits", text: "Ils n'accèdent qu'aux projets dont ils sont membres, avec leur propre rôle. Tout est journalisé." },
        ].map((c) => (
          <div key={c.title} className="rounded-2xl border border-line bg-panel p-4 shadow-sm">
            <c.icon className="size-4 text-ai-fg" />
            <p className="mt-2 text-[14px] font-semibold">{c.title}</p>
            <p className="mt-1 text-[13px] leading-relaxed text-muted">{c.text}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {agents?.map((a, i) => {
          const mine = runs?.filter((r) => r.agent_id === a.id) ?? [];
          const projs = projects?.filter((p) => p.members.includes(a.id)) ?? [];
          const active = mine.filter((r) => isActive(r.status)).length;
          return (
            <motion.div key={a.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}
              className={cn("relative overflow-hidden rounded-2xl border bg-panel p-5 shadow-sm", active ? "ai-ring border-transparent" : "border-line")}>
              <div className="flex items-start gap-3.5">
                <Avatar user={a} size={48} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2"><h2 className="text-[17px] font-semibold">{a.name}</h2>{active > 0 && <Chip tone="ai"><span className="pulse-dot size-1.5 rounded-full bg-current" />{active} en cours</Chip>}</div>
                  <p className="mt-0.5 text-[13px] text-muted first-letter:uppercase">{a.ai_role}</p>
                </div>
              </div>
              {a.ai_instructions && (
                <div className="mt-4 rounded-xl bg-hover px-3.5 py-3">
                  <p className="mb-1 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-faint"><ScrollText className="size-3" />Consignes permanentes</p>
                  <p className="text-[13px] leading-relaxed">{a.ai_instructions}</p>
                </div>
              )}
              <div className="mt-4 flex flex-wrap gap-1.5">
                {projs.map((p) => <span key={p.id} className="flex items-center gap-1.5 rounded-lg border border-line px-2 py-1 text-[12px]"><ProjectIcon icon={p.icon} color={p.color} size={14} />{p.name}</span>)}
              </div>
              <div className="mt-4 flex gap-6 border-t border-line pt-3 text-[12.5px] text-muted">
                <span><b className="font-semibold text-fg tabular">{mine.length}</b> interventions</span>
                <span><b className="font-semibold text-fg tabular">{mine.filter((r) => r.status === "done").length}</b> terminées</span>
                <span><b className="font-semibold text-fg tabular">{approvals?.filter((x) => x.agent_id === a.id).length ?? 0}</b> en attente</span>
              </div>
            </motion.div>
          );
        })}
      </div>

      {!!approvals?.length && (
        <section className="mt-10">
          <h2 className="mb-3 text-[15px] font-semibold">En attente de votre accord</h2>
          <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">{approvals.map((a) => <ApprovalCard key={a.id} a={a} />)}</div>
        </section>
      )}

      <section className="mt-10">
        <h2 className="mb-3 text-[15px] font-semibold">Journal des interventions</h2>
        {!runs?.length ? <div className="rounded-2xl border border-line bg-panel"><Empty title="Aucune intervention">Assignez une tâche à Atlas ou Nova pour commencer.</Empty></div> : (
          <div className="grid overflow-hidden rounded-2xl border border-line bg-panel shadow-sm md:grid-cols-[minmax(0,380px)_1fr]">
            <ul className="max-h-[560px] overflow-y-auto border-b border-line md:border-b-0 md:border-r">
              {runs.map((r) => (
                <li key={r.id}>
                  <button onClick={() => setSelected(r.id)} className={cn("flex w-full items-center gap-2.5 border-b border-line px-4 py-3 text-left last:border-b-0", run === r.id ? "bg-active" : "hover:bg-hover")}>
                    <Avatar user={users.get(r.agent_id)} size={24} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium">{users.get(r.agent_id)?.name} · {r.kind === "mention" ? "mention" : r.kind === "rule" ? "règle" : "tâche assignée"}</span>
                      <span className="block text-[11.5px]"><span className={RUN_STATUS[r.status].tone}>{RUN_STATUS[r.status].label}</span><span className="text-faint"> · {r.step_count} étape(s) · {ago(r.created_at)}</span></span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="min-w-0 p-5">
              {run && <RunTimeline runId={run} />}
              {run && runs.find((r) => r.id === run)?.task_id && <button onClick={() => shell.openTask(runs.find((r) => r.id === run)!.task_id!)} className="mt-4 text-[12.5px] text-muted hover:text-fg">Ouvrir la tâche →</button>}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
