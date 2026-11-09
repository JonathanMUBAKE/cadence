import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import { ArrowUp, RotateCcw, Sparkles, X } from "lucide-react";
import { IconButton, Markdown, ProjectIcon, cn } from "./ui";
import { RunTimeline } from "./ai";
import { onAiDelta, useAiStatus, useProjects, useRun } from "@/lib/hooks";
import { useShell } from "@/lib/shell";
import { api } from "@/lib/api";

type Msg = { role: "user" | "assistant"; content: string; error?: boolean };

const SUGGESTIONS = [
  "Qu'est-ce qui est en retard, et pourquoi ?",
  "Résume l'avancement du projet",
  "Quelles sont mes tâches ouvertes ?",
  "Quelles tâches urgentes restent à faire ?",
  "Crée une tâche Préparer la démo client",
];

export function Assistant() {
  const shell = useShell();
  const open = shell.assistant.open;
  const loc = useLocation();
  const projectId = loc.pathname.match(/^\/projects\/([^/?]+)/)?.[1] ?? null;
  const { data: projects } = useProjects();
  const project = projects?.find((p) => p.id === projectId);
  const { data: ai } = useAiStatus();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [stream, setStream] = useState("");
  const [input, setInput] = useState("");
  const { data: run } = useRun(runId);
  const scroller = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(
    () =>
      onAiDelta((id, delta) => {
        if (id === runId) setStream((s) => s + delta);
      }),
    [runId],
  );
  useEffect(() => {
    if (!run || run.id !== runId) return;
    if (run.status === "done" || run.status === "failed" || run.status === "cancelled") {
      setMessages((m) => [
        ...m,
        run.status === "done"
          ? { role: "assistant", content: run.summary || stream || "C'est fait." }
          : {
              role: "assistant",
              content: run.status === "failed" ? (run.error ?? "Une erreur est survenue.") : "Arrêté.",
              error: true,
            },
      ]);
      setRunId(null);
      setStream("");
    }
  }, [run, runId, stream]);
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [messages, stream, run?.steps.length, run?.approvals.length]);
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 150);
  }, [open]);
  useEffect(() => {
    if (open && shell.assistant.prompt) send(shell.assistant.prompt);
  }, [open, shell.assistant.prompt]);

  async function send(text: string) {
    const q = text.trim();
    if (!q || runId) return;
    const history = [...messages.filter((m) => !m.error), { role: "user" as const, content: q }];
    setMessages((m) => [...m, { role: "user", content: q }]);
    setInput("");
    try {
      const r = await api.post<{ run_id: string }>("/api/ai/chat", { messages: history, project_id: projectId });
      setStream("");
      setRunId(r.run_id);
    } catch (e) {
      setMessages((m) => [...m, { role: "assistant", content: (e as Error).message, error: true }]);
    }
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          key="assistant"
          initial={{ x: 32, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: 32, opacity: 0 }}
          transition={{ type: "spring", stiffness: 420, damping: 38 }}
          className="fixed inset-y-0 right-0 z-[45] flex w-full flex-col border-l border-line bg-panel shadow-lg sm:inset-y-3 sm:right-3 sm:w-[440px] sm:rounded-2xl sm:border"
        >
          <header className="flex h-14 shrink-0 items-center gap-2.5 border-b border-line px-4">
            <span className="flex size-8 items-center justify-center rounded-xl bg-[conic-gradient(from_200deg,var(--ai),#4FB3F0,var(--ai))] text-white shadow-sm">
              <Sparkles className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-semibold leading-tight">Cadence AI</p>
              <p className="truncate text-[11.5px] text-faint">
                {ai?.provider === "anthropic" ? `Claude · ${ai.model}` : "Mode démo : réponses simulées, sans clé API"}
              </p>
            </div>
            {messages.length > 0 && (
              <IconButton
                label="Nouvelle conversation"
                onClick={() => {
                  setMessages([]);
                  setRunId(null);
                  setStream("");
                }}
              >
                <RotateCcw className="size-4" />
              </IconButton>
            )}
            <IconButton label="Fermer" onClick={shell.closeAssistant}>
              <X className="size-4" />
            </IconButton>
          </header>

          <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            {messages.length === 0 && !runId ? (
              <div className="flex h-full flex-col justify-end pb-2">
                <p className="font-serif text-[30px] leading-[1.05] tracking-[-0.01em]">
                  Que voulez-vous savoir <span className="ai-text shimmer italic">sur votre travail</span> ?
                </p>
                <p className="mt-2 text-[13px] text-muted">
                  Je lis vos projets avec vos droits, je réponds avec les numéros de tâches, et je vous demande votre
                  accord avant de modifier quoi que ce soit.
                </p>
                <div className="mt-5 flex flex-col gap-1.5">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      onClick={() => send(s)}
                      className="rounded-xl border border-line bg-bg/60 px-3 py-2 text-left text-[13px] text-fg transition-colors hover:border-ai-line hover:bg-ai-soft"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                {messages.map((m, i) =>
                  m.role === "user" ? (
                    <div key={i} className="flex justify-end">
                      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-fg px-3.5 py-2 text-[13.5px] text-bg">
                        {m.content}
                      </div>
                    </div>
                  ) : (
                    <div
                      key={i}
                      className={cn(
                        "text-[13.5px] leading-relaxed",
                        m.error && "rounded-lg bg-danger-soft px-3 py-2 text-danger",
                      )}
                    >
                      <Markdown text={m.content} />
                    </div>
                  ),
                )}
                {runId && (
                  <div className="space-y-3">
                    {run && (run.steps.length > 0 || run.approvals.length > 0) && (
                      <div className="rounded-xl border border-line bg-bg/50 p-3">
                        <RunTimeline runId={runId} showSummary={false} />
                      </div>
                    )}
                    {stream ? (
                      <div className="text-[13.5px] leading-relaxed">
                        <Markdown text={stream} />
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 text-[13px] text-muted">
                        <span className="flex gap-1">
                          {[0, 1, 2].map((i) => (
                            <span
                              key={i}
                              className="pulse-dot size-1.5 rounded-full bg-ai"
                              style={{ animationDelay: `${i * 160}ms` }}
                            />
                          ))}
                        </span>
                        Réflexion…
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="shrink-0 border-t border-line p-3">
            {project && (
              <div className="mb-2 flex items-center gap-1.5 text-[12px] text-muted">
                <ProjectIcon icon={project.icon} color={project.color} size={16} />
                Contexte : <span className="font-medium text-fg">{project.name}</span>
              </div>
            )}
            <div className="flex items-end gap-2 rounded-xl border border-line bg-bg/60 p-1.5 pl-3 focus-within:border-ai-line">
              <textarea
                ref={inputRef}
                value={input}
                rows={1}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Posez une question ou demandez une action…"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send(input);
                  }
                }}
                className="max-h-32 min-h-[34px] flex-1 resize-none bg-transparent py-1.5 text-[13.5px] outline-none placeholder:text-faint"
              />
              <button
                aria-label="Envoyer"
                disabled={!input.trim() || !!runId}
                onClick={() => send(input)}
                className="flex size-8 items-center justify-center rounded-lg bg-fg text-bg transition-opacity disabled:opacity-30"
              >
                <ArrowUp className="size-4" />
              </button>
            </div>
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
