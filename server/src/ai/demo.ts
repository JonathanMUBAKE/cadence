/**
 * Fournisseur de DÉMONSTRATION : utilisé quand aucune clé ANTHROPIC_API_KEY n'est configurée.
 * Ce n'est pas un modèle : c'est un petit cerveau à règles qui appelle les mêmes outils que Claude,
 * pour que toute la chaîne (outils, droits, validations, journal, temps réel) soit testable.
 */
import type {
  AiProvider,
  ContentBlock,
  JsonRequest,
  Msg,
  ToolResultBlock,
  TurnRequest,
  TurnResult,
} from "./provider.js";
import type { Services } from "../services.js";
import { localDate, mentionPattern, today } from "../services.js";
import type { RawImport } from "./importer.js";

type Parsed = { name: string; input: Record<string, unknown>; ok: boolean; out: unknown };

let seq = 0;
const call = (name: string, input: Record<string, unknown>): ContentBlock => ({
  type: "tool_use",
  id: `demo_${++seq}`,
  name,
  input,
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function rounds(messages: Msg[]): Parsed[][] {
  const out: Parsed[][] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    const uses = m.content.filter((b) => b.type === "tool_use") as {
      id: string;
      name: string;
      input: Record<string, unknown>;
    }[];
    if (!uses.length) continue;
    const next = messages[i + 1];
    const results = next && typeof next.content !== "string" ? (next.content as ToolResultBlock[]) : [];
    out.push(
      uses.map((u) => {
        const r = results.find((x) => x.tool_use_id === u.id);
        let parsed: unknown = r?.content;
        try {
          parsed = JSON.parse(String(r?.content));
        } catch {
          /* texte brut */
        }
        return {
          name: u.name,
          input: u.input,
          ok: !!r && !r.is_error && !String(r.content).startsWith("Refusé"),
          out: parsed,
        };
      }),
    );
  }
  return out;
}

const READ_WORDS = /pi[èe]ce jointe|fichier|document|\blis\b|\blire\b/i;
const importPriority = (s: string) =>
  /urgent|critique/i.test(s)
    ? "urgent"
    : /haut|élev|high/i.test(s)
      ? "high"
      : /moyen|normal|medium/i.test(s)
        ? "medium"
        : /bas|faible|low/i.test(s)
          ? "low"
          : "none";
const importDate = (s: string) => {
  const fr = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return fr ? `${fr[3]}-${fr[2].padStart(2, "0")}-${fr[1].padStart(2, "0")}` : /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};

/** Sans modèle : lit un tableau avec en-têtes, ou un plan fait de titres et de puces. */
function demoImport(text: string, fallback: string): RawImport {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("## Feuille :"));
  const rows = lines.filter((l) => /[|;\t]/.test(l)).map((l) => l.split(/\s*[|;\t]\s*/).map((c) => c.trim()));
  const header = rows[0]?.map((h) => h.toLowerCase()) ?? [];
  const col = (re: RegExp, not?: RegExp) => header.findIndex((h) => re.test(h) && !not?.test(h));
  const title = col(/t[âa]che|titre|action|libell|intitul/, /parent/);
  return title >= 0 && rows.length > 1
    ? demoFromTable(rows.slice(1), title, col, fallback)
    : demoFromOutline(lines, fallback);
}

function demoFromTable(
  rows: string[][],
  title: number,
  col: (re: RegExp, not?: RegExp) => number,
  fallback: string,
): RawImport {
  const [who, due, prio, state, parent] = [
    col(/responsable|assign|porteur|qui/),
    col(/[ée]ch[ée]ance|date|deadline/),
    col(/priorit/),
    col(/statut|[ée]tat|section|phase|colonne/),
    col(/parent/),
  ];
  const at = (r: string[], i: number) => (i >= 0 ? (r[i] ?? "") : "");
  const tasks: RawImport["tasks"] = [];
  for (const r of rows.filter((x) => at(x, title) && !at(x, parent))) {
    const status = at(r, state);
    tasks.push({
      title: at(r, title),
      description: "",
      section: status || null,
      assignee: at(r, who) || null,
      due_on: importDate(at(r, due)),
      priority: importPriority(at(r, prio)),
      completed: /termin|fait|done|clos/i.test(status),
      subtasks: [],
    });
  }
  for (const r of rows.filter((x) => at(x, title) && at(x, parent))) {
    const sub = { title: at(r, title), assignee: at(r, who) || null, due_on: importDate(at(r, due)) };
    const owner = tasks.find((t) => t.title === at(r, parent));
    if (owner) owner.subtasks.push(sub);
    else
      tasks.push({
        ...sub,
        description: "",
        section: at(r, state) || null,
        priority: importPriority(at(r, prio)),
        completed: false,
        subtasks: [],
      });
  }
  return {
    name: fallback,
    description: "",
    due_on: null,
    sections: [...new Set(tasks.map((t) => t.section).filter((s): s is string => !!s))],
    tasks,
    notes: ["Mode démo : colonnes reconnues d'après leur en-tête."],
  };
}

function demoFromOutline(lines: string[], fallback: string): RawImport {
  const headings = lines.filter((l) => /^#+\s/.test(l)).length;
  let name = "",
    description = "",
    section: string | null = null;
  const sections: string[] = [];
  const tasks: RawImport["tasks"] = [];
  const add = (t: string) =>
    tasks.push({
      title: t,
      description: "",
      section,
      assignee: null,
      due_on: null,
      priority: "none",
      completed: false,
      subtasks: [],
    });
  for (const line of lines) {
    const h = line.match(/^(#+)\s+(.*)$/),
      item = line.match(/^(\s*)[-•*]\s+(.*)$/);
    if (h) {
      if (!name && h[1].length === 1 && headings > 1) name = h[2];
      else {
        section = h[2];
        sections.push(section);
      }
    } else if (item) {
      if (item[1].length && tasks.length)
        tasks[tasks.length - 1].subtasks.push({ title: item[2], assignee: null, due_on: null });
      else add(item[2]);
    } else if (!tasks.length && !section && !description) description = line.trim();
    else add(line.trim());
  }
  if (!tasks.length && description) {
    add(description);
    description = "";
  } // Un texte d'une seule ligne reste une tâche
  return {
    name: name || fallback,
    description,
    due_on: null,
    sections,
    tasks,
    notes: ["Mode démo : plan déduit des titres et des puces du document."],
  };
}

const daysLate = (d: string) => Math.round((Date.parse(today()) - Date.parse(d)) / 86400000);
const fmt = (d: string) => new Date(d + "T12:00:00").toLocaleDateString("fr-FR", { day: "numeric", month: "long" });

export class DemoProvider implements AiProvider {
  name = "demo" as const;
  constructor(
    private svc: Services,
    private delayMs = 450,
  ) {}

  private async say(text: string, req: TurnRequest): Promise<TurnResult> {
    if (req.onText)
      for (const chunk of text.match(/.{1,24}(\s|$)/gs) ?? [text]) {
        req.onText(chunk);
        await sleep(18);
      }
    return { stop_reason: "end_turn", content: [{ type: "text", text }] };
  }
  private tools(...blocks: ContentBlock[]): TurnResult {
    return { stop_reason: "tool_use", content: blocks };
  }

  async turn(req: TurnRequest): Promise<TurnResult> {
    await sleep(this.delayMs);
    const r = rounds(req.messages);
    const { mode } = req.hint;
    if (mode === "teammate") return this.teammate(req, r);
    if (mode === "mention") return this.mention(req, r);
    return this.assistant(req, r);
  }

  // ------------------------------------------------------------ lecture d'une pièce jointe
  private readFile(req: TurnRequest, r: Parsed[][], attachmentId: string): Promise<TurnResult> | TurnResult {
    if (r.length === 0) return this.tools(call("read_attachment", { attachment_id: attachmentId }));
    const p = r[0][0];
    if (!p.ok || typeof p.out !== "object")
      return this.say(`Je n'ai pas pu lire ce fichier : ${String(p.out).replace(/^Erreur : /, "")}`, req);
    const out = p.out as { filename: string; content: string; total_chars: number };
    return this.say(
      `J'ai lu « ${out.filename} » (${out.total_chars} caractères).\n\nDébut du document :\n${out.content.slice(0, 400)}`,
      req,
    );
  }

  // ------------------------------------------------------------ coéquipier assigné
  private async teammate(req: TurnRequest, r: Parsed[][]): Promise<TurnResult> {
    const { taskId, projectId } = req.hint;
    const task = taskId ? await this.svc.getTask(req.hint.actorId, taskId) : null;
    if (task?.attachments[0] && READ_WORDS.test(`${task.title} ${task.description}`))
      return this.readFile(req, r, task.attachments[0].id);
    if (r.length === 0) {
      return this.tools(
        call("get_task", { task: task?.key }),
        call("search_tasks", { project_id: projectId, overdue: true, limit: 10 }),
      );
    }
    if (r.length === 1) {
      const overdue =
        (
          r[0].find((p) => p.name === "search_tasks")?.out as {
            tasks?: { task: string; title: string; assignee: string | null; due_on: string }[];
          }
        )?.tasks ?? [];
      const writes: ContentBlock[] = [];
      for (const t of overdue.filter((x) => x.assignee && x.task !== task?.key).slice(0, 3)) {
        const first = t.assignee!.split(" ")[0];
        writes.push(
          call("add_comment", {
            task: t.task,
            body: `@${first} petite relance : « ${t.title} » devait être livrée le ${fmt(t.due_on)} (${daysLate(t.due_on)} j de retard). Tu peux me donner une nouvelle date réaliste, ou me dire ce qui bloque ?`,
          }),
        );
      }
      if (task && task.subtasks.length === 0) {
        const steps = [
          "Rassembler les éléments et l'état des lieux",
          "Produire une première version",
          "Faire relire et valider",
        ];
        steps.forEach((title, i) => {
          const d = new Date();
          d.setDate(d.getDate() + i + 1);
          writes.push(
            call("create_task", {
              project_id: task.project_id,
              parent: task.key,
              title: `${title}`,
              due_on: localDate(d),
            }),
          );
        });
      }
      if (writes.length) return this.tools(...writes);
    }
    // Compte rendu final
    const all = r.flat();
    const overdue =
      (r[0]?.find((p) => p.name === "search_tasks")?.out as { tasks?: { task: string; title: string }[] })?.tasks ?? [];
    const relances = all.filter((p) => p.name === "add_comment");
    const subs = all.filter((p) => p.name === "create_task");
    const lines = [
      `**Point sur ${task ? `${task.key} « ${task.title} »` : "la tâche"}**`,
      "",
      overdue.length
        ? `• ${overdue.length} tâche(s) en retard dans le projet : ${overdue
            .slice(0, 5)
            .map((t) => `${t.task} ${t.title}`)
            .join(", ")}.`
        : "• Aucune tâche en retard dans le projet.",
      ...(relances.length
        ? [
            `• Relances : ${relances.filter((p) => p.ok).length} envoyée(s), ${relances.filter((p) => !p.ok).length} refusée(s) ou en échec.`,
          ]
        : []),
      ...(subs.length
        ? [`• Plan d'action : ${subs.filter((p) => p.ok).length}/${subs.length} sous-tâche(s) créée(s).`]
        : []),
      "• Prochaine étape : je repasse sur les retards dès qu'il y a une réponse.",
    ];
    return this.say(lines.join("\n"), req);
  }

  // ------------------------------------------------------------ @mention dans un commentaire
  private async mention(req: TurnRequest, r: Parsed[][]): Promise<TurnResult> {
    const task = req.hint.taskId ? await this.svc.getTask(req.hint.actorId, req.hint.taskId) : null;
    const asked =
      String(req.messages[0]?.content ?? "").match(/mentionné dans ce commentaire :\n« ([\s\S]*) »/)?.[1] ?? "";
    if (task?.attachments[0] && READ_WORDS.test(asked)) return this.readFile(req, r, task.attachments[0].id);
    if (r.length === 0 && task) return this.tools(call("get_task", { task: task.key }));
    if (!task) return this.say("Je n'ai pas trouvé la tâche concernée.", req);
    const done = task.subtasks.filter((s) => s.completed).length;
    const who = task.assignee_id ? (await this.svc.user(task.assignee_id)).name : "personne";
    const late = task.due_on && !task.completed && task.due_on < today();
    const text = [
      `Voici où en est ${task.key} « ${task.title} » :`,
      `• Assignée à ${who}, ${task.completed ? "terminée" : (task.section?.name ?? "sans section")}.`,
      task.due_on
        ? `• Échéance : ${fmt(task.due_on)}${late ? ` — en retard de ${daysLate(task.due_on)} j` : ""}.`
        : "• Pas d'échéance fixée.",
      task.subtasks.length ? `• Sous-tâches : ${done}/${task.subtasks.length} terminées.` : "• Pas de sous-tâches.",
      task.comments.length
        ? `• Dernier échange : « ${task.comments[task.comments.length - 1].body.slice(0, 120)} »`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
    return this.say(text, req);
  }

  // ------------------------------------------------------------ assistant (chat)
  private async assistant(req: TurnRequest, r: Parsed[][]): Promise<TurnResult> {
    const last = [...req.messages].reverse().find((m) => m.role === "user" && typeof m.content === "string");
    const q = String(last?.content ?? "").toLowerCase();
    const pid = req.hint.projectId ?? undefined;
    const me = req.hint.actorId;
    if (r.length === 0) {
      const create = q.match(/(?:crée|créer|ajoute|ajouter)\s+(?:une\s+)?t[âa]che\s*(?:[:«"]\s*)?(.+?)["»]?$/i);
      if (create && pid)
        return this.tools(
          call("create_task", {
            project_id: pid,
            title: create[1].replace(/^["«\s]+|["»\s]+$/g, "").replace(/^./, (c) => c.toUpperCase()),
          }),
        );
      if (/retard|overdue|en retard/.test(q))
        return this.tools(call("search_tasks", { project_id: pid, overdue: true }));
      if (/\bmes\b|\bmoi\b|ma semaine|mon travail/.test(q))
        return this.tools(call("search_tasks", { assignee: me, completed: false }));
      if (/semaine|bientôt|échéance|cette semaine/.test(q)) {
        const d = new Date();
        d.setDate(d.getDate() + 7);
        return this.tools(call("search_tasks", { project_id: pid, completed: false, due_before: localDate(d) }));
      }
      if (/urgent|priorit/.test(q))
        return this.tools(
          call("search_tasks", { project_id: pid, priority: "urgent", completed: false }),
          call("search_tasks", { project_id: pid, priority: "high", completed: false }),
        );
      if (/résum|statut|avancement|où en|point/.test(q))
        return pid ? this.tools(call("get_project", { project_id: pid })) : this.tools(call("list_projects", {}));
      const words = q
        .replace(/[?!.,]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 4);
      return this.tools(
        call("search_tasks", { project_id: pid, text: words[words.length - 1] ?? "", completed: false }),
      );
    }
    const res = r[r.length - 1];
    const lines: string[] = [];
    for (const p of res) {
      if (!p.ok) {
        lines.push(`Je n'ai pas pu faire « ${p.name} » : ${typeof p.out === "string" ? p.out : "refusé"}.`);
        continue;
      }
      if (p.name === "search_tasks") {
        const tasks = (
          p.out as {
            tasks: { task: string; title: string; assignee: string | null; due_on: string | null; priority: string }[];
          }
        ).tasks;
        if (!tasks.length) {
          lines.push("Je n'ai trouvé aucune tâche correspondante.");
          continue;
        }
        lines.push(`J'ai trouvé ${tasks.length} tâche(s) :`);
        for (const t of tasks.slice(0, 8))
          lines.push(
            `• ${t.task} ${t.title}${t.assignee ? ` — ${t.assignee}` : ""}${t.due_on ? ` · ${fmt(t.due_on)}` : ""}${t.due_on && t.due_on < today() ? " (en retard)" : ""}`,
          );
      } else if (p.name === "get_project") {
        const o = p.out as {
          name: string;
          status: string;
          stats: { total: number; done: number; overdue: number; due_this_week: number; unassigned: number };
        };
        const pct = o.stats.total ? Math.round((o.stats.done / o.stats.total) * 100) : 0;
        lines.push(
          `**${o.name}** — ${pct} % terminé (${o.stats.done}/${o.stats.total}).`,
          `• ${o.stats.overdue} en retard, ${o.stats.due_this_week} à rendre cette semaine, ${o.stats.unassigned} sans responsable.`,
          o.stats.overdue
            ? "• Priorité : débloquer les retards avant d'ouvrir de nouveaux sujets."
            : "• Le rythme est bon, rien d'alarmant.",
        );
      } else if (p.name === "list_projects") {
        const ps = p.out as { name: string; tasks: number; done: number; overdue: number }[];
        lines.push(
          "Vos projets :",
          ...ps.map(
            (x) => `• ${x.name} — ${x.done}/${x.tasks} terminées${x.overdue ? `, ${x.overdue} en retard` : ""}`,
          ),
        );
      } else if (p.name === "create_task") {
        lines.push(
          `C'est fait : tâche ${(p.out as { created: { task: string; title: string } }).created.task} « ${(p.out as { created: { title: string } }).created.title} » créée.`,
        );
      }
    }
    return this.say(lines.join("\n") || "C'est noté.", req);
  }

  // ------------------------------------------------------------ actions intelligentes (JSON)
  async json<T>(req: JsonRequest): Promise<T> {
    await sleep(this.delayMs);
    const d = req.hint.data as Record<string, unknown>;
    switch (req.hint.kind) {
      case "subtasks": {
        const title = String(d.title ?? "la tâche");
        return {
          subtasks: [
            { title: `Cadrer « ${title} » : objectif, périmètre, critères de réussite`, days_from_now: 1 },
            { title: "Lister les dépendances et les personnes à impliquer", days_from_now: 2 },
            { title: "Réaliser une première version", days_from_now: 4 },
            { title: "Faire relire et intégrer les retours", days_from_now: 6 },
            { title: "Valider et communiquer le résultat", days_from_now: 7 },
          ],
        } as T;
      }
      case "status": {
        const st = d.stats as {
          total: number;
          done: number;
          overdue: number;
          due_this_week: number;
          unassigned: number;
        };
        const overdue = (d.overdue as { title: string }[]) ?? [];
        const status = st.overdue >= 3 ? "off_track" : st.overdue > 0 ? "at_risk" : "on_track";
        const pct = st.total ? Math.round((st.done / st.total) * 100) : 0;
        return {
          status,
          headline:
            status === "on_track"
              ? `Dans les temps : ${pct} % réalisé`
              : status === "at_risk"
                ? `À surveiller : ${st.overdue} tâche(s) en retard`
                : `En difficulté : ${st.overdue} retards cumulés`,
          summary: `${st.done} tâches terminées sur ${st.total}. ${st.due_this_week} échéance(s) cette semaine.`,
          risks: overdue
            .slice(0, 3)
            .map((t) => `Retard sur « ${t.title} »`)
            .concat(st.unassigned ? [`${st.unassigned} tâche(s) sans responsable`] : []),
          next_steps: [
            "Débloquer les tâches en retard avec leurs responsables",
            "Assigner les tâches orphelines",
            "Confirmer les échéances de la semaine",
          ],
        } as T;
      }
      case "parse": {
        const text = String(d.text ?? "");
        const users = (d.members as { id: string; name: string }[]) ?? [];
        const items = text
          .split(/\n|;|•|- (?=\S)/)
          .map((s) => s.trim())
          .filter((s) => s.length > 2);
        return {
          tasks: items.slice(0, 20).map((line) => {
            const who = users.find((u) => mentionPattern(u.name, "@?").test(line));
            const dt = new Date();
            let due: string | null = null;
            if (/demain/i.test(line)) {
              dt.setDate(dt.getDate() + 1);
              due = localDate(dt);
            } else if (/semaine prochaine/i.test(line)) {
              dt.setDate(dt.getDate() + 7);
              due = localDate(dt);
            } else {
              const m = line.match(/(\d{1,2})\/(\d{1,2})/);
              if (m) due = `${dt.getFullYear()}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
            }
            const priority = /urgent|asap|critique/i.test(line)
              ? "urgent"
              : /important|prioritaire/i.test(line)
                ? "high"
                : "none";
            const title = line
              .replace(/@\w+/g, "")
              .replace(/\b(demain|urgent|asap|semaine prochaine|pour le \d{1,2}\/\d{1,2}|\d{1,2}\/\d{1,2})\b/gi, "")
              .replace(/\s{2,}/g, " ")
              .replace(/[,.\s]+$/, "")
              .trim();
            return {
              title: title.charAt(0).toUpperCase() + title.slice(1),
              assignee_id: who?.id ?? null,
              due_on: due,
              priority,
              section: null,
              description: "",
            };
          }),
        } as T;
      }
      case "describe": {
        const title = String(d.title ?? "");
        return {
          description: `**Objectif**\n${title}.\n\n**Contexte**\n${String(d.description || "À préciser.")}\n\n**Critères de réussite**\n- Le livrable est validé par le responsable du projet\n- Les personnes concernées sont informées\n\n**Points d'attention**\n- Vérifier les dépendances avant de commencer`,
        } as T;
      }
      case "import":
        return demoImport(String(d.text ?? ""), String(d.name ?? "Projet importé")) as T;
      default:
        throw new Error(`Action IA inconnue : ${req.hint.kind}`);
    }
  }
}
