import { get, run, uid, now } from "./db.js";
import type { Services, Priority } from "./services.js";

const d = (offset: number) => { const x = new Date(); x.setDate(x.getDate() + offset); return x.toISOString().slice(0, 10); };
const ts = (offsetDays: number, hour = 10) => { const x = new Date(); x.setDate(x.getDate() + offsetDays); x.setHours(hour, 12, 0, 0); return x.toISOString(); };

export function seedIfEmpty(svc: Services) {
  if (get(svc.db, "SELECT id FROM users LIMIT 1")) return false;
  seed(svc);
  return true;
}

export function seed(svc: Services) {
  const db = svc.db;
  const users: [string, string, string | null, string, string, number, string | null, string | null][] = [
    ["u_alice", "Alice Martin", "alice@cadence.app", "Head of Product", "#E5484D", 0, null, null],
    ["u_karim", "Karim Benali", "karim@cadence.app", "Lead développeur mobile", "#0090FF", 0, null, null],
    ["u_chloe", "Chloé Dubois", "chloe@cadence.app", "Product designer", "#D6409F", 0, null, null],
    ["u_hugo", "Hugo Lefèvre", "hugo@cadence.app", "Responsable marketing", "#F76B15", 0, null, null],
    ["u_ines", "Inès Moreau", "ines@cadence.app", "Data analyst", "#12A594", 0, null, null],
    ["u_theo", "Théo Garnier", "theo@cadence.app", "Ingénieur QA", "#8E4EC6", 0, null, null],
    ["ai_atlas", "Atlas", null, "Coéquipier IA", "#6E56CF", 1, "chef de projet IA : suivi, relances, points d'avancement, découpage du travail",
      "Rapports courts, en puces, risques en premier. Quand tu relances quelqu'un, rappelle toujours l'échéance et propose ton aide. Ne change jamais une échéance sans le signaler."],
    ["ai_nova", "Nova", null, "Coéquipière IA", "#00A2C7", 1, "analyste QA et triage : qualifie les bugs, fixe les priorités, prépare les plans de test",
      "Pour un bug : vérifie qu'il y a des étapes de reproduction, un résultat attendu et observé ; sinon demande-les en commentaire. Fixe la priorité selon l'impact utilisateur."],
    ["ai_cadence", "Cadence AI", null, "Assistant", "#6E56CF", 1, "assistant conversationnel", null],
  ];
  for (const u of users) run(db, "INSERT INTO users (id, name, email, title, avatar_color, is_ai, ai_role, ai_instructions) VALUES (?,?,?,?,?,?,?,?)", ...u);

  type T = { title: string; section: string; assignee?: string; due?: number; start?: number; priority?: Priority; done?: number; tags?: string[]; desc?: string; subs?: [string, string?, boolean?][]; comments?: [string, string, number][] };
  const project = (by: string, p: { name: string; description: string; color: string; icon: string; due: number; status?: "on_track" | "at_risk" | "off_track"; sections: string[]; members: [string, "viewer" | "commenter" | "editor" | "admin"][]; tasks: T[]; createdDaysAgo: number }) => {
    const pr = svc.createProject(by, { name: p.name, description: p.description, color: p.color, icon: p.icon, due_on: d(p.due), sections: p.sections });
    if (p.status) run(db, "UPDATE projects SET status = ? WHERE id = ?", p.status, pr.id);
    run(db, "UPDATE projects SET created_at = ? WHERE id = ?", ts(-p.createdDaysAgo), pr.id);
    for (const [u, role] of p.members) svc.setMember(by, pr.id, u, role);
    const sec = (name: string) => pr.sections.find((s) => s.name === name)!.id;
    p.tasks.forEach((t, i) => {
      const task = svc.createTask(by, {
        project_id: pr.id, title: t.title, description: t.desc ?? "", section_id: sec(t.section), assignee_id: t.assignee ?? null,
        due_on: t.due === undefined ? null : d(t.due), start_on: t.start === undefined ? null : d(t.start), priority: t.priority ?? "none", tags: t.tags ?? [],
      });
      const created = ts(-p.createdDaysAgo + Math.min(i, p.createdDaysAgo - 1));
      run(db, "UPDATE tasks SET created_at = ?, updated_at = ? WHERE id = ?", created, created, task.id);
      if (t.done !== undefined) run(db, "UPDATE tasks SET completed = 1, completed_at = ? WHERE id = ?", ts(-t.done, 16), task.id);
      for (const [title, who, done] of t.subs ?? []) {
        const s = svc.createTask(by, { project_id: pr.id, parent_id: task.id, title, assignee_id: who ?? null });
        if (done) run(db, "UPDATE tasks SET completed = 1, completed_at = ? WHERE id = ?", ts(-2), s.id);
      }
      for (const [author, body, ago] of t.comments ?? []) {
        run(db, "INSERT INTO comments (id, task_id, author_id, body, created_at) VALUES (?,?,?,?,?)", uid("cmt"), task.id, author, body, ts(-ago, 9 + (ago % 8)));
      }
    });
    return pr;
  };

  // ------------------------------------------------------------------ Projet 1
  const app = project("u_alice", {
    name: "Application mobile v2", icon: "smartphone", color: "#6E56CF", due: 37, createdDaysAgo: 24, status: "at_risk",
    description: "Refonte complète de l'app iOS et Android : nouveau parcours de paiement, mode hors ligne et tableau de bord personnalisé. Objectif : publication sur les stores avant la fin de l'année.",
    sections: ["Backlog", "À faire", "En cours", "En revue", "Terminé"],
    members: [["u_karim", "editor"], ["u_chloe", "editor"], ["u_theo", "editor"], ["u_ines", "commenter"], ["u_hugo", "viewer"], ["ai_atlas", "editor"], ["ai_nova", "editor"]],
    tasks: [
      { title: "Maquettes du nouveau parcours de paiement", section: "Terminé", assignee: "u_chloe", due: -12, done: 11, priority: "high", tags: ["design"],
        desc: "Écrans panier → paiement → confirmation, états d'erreur inclus. Validé en revue produit.", comments: [["u_alice", "Validé, beau travail. On part là-dessus.", 11]] },
      { title: "Définir l'architecture du mode hors ligne", section: "Terminé", assignee: "u_karim", due: -9, done: 8, priority: "high", tags: ["tech"],
        desc: "Choix de la stratégie de synchronisation (file d'opérations + résolution des conflits côté serveur)." },
      { title: "Intégrer le SDK de paiement", section: "En cours", assignee: "u_karim", due: -4, start: -10, priority: "urgent", tags: ["tech", "paiement"],
        desc: "Intégration du SDK du prestataire pour carte bancaire, Apple Pay et Google Pay.\n\nBloquant : il nous manque la clé API sandbox.",
        subs: [["Carte bancaire", "u_karim", true], ["Apple Pay", "u_karim"], ["Google Pay", "u_karim"]],
        comments: [["u_karim", "J'attends toujours la clé sandbox du prestataire, relancé deux fois.", 3], ["u_alice", "Je m'en occupe avec leur account manager.", 2]] },
      { title: "Tests de non-régression iOS", section: "À faire", assignee: "u_theo", due: -2, priority: "high", tags: ["qa"],
        desc: "Campagne complète sur iPhone 13 à 17, iOS 18 et 19." },
      { title: "Écran tableau de bord personnalisé", section: "En cours", assignee: "u_chloe", due: 5, start: -3, priority: "medium", tags: ["design"],
        subs: [["Wireframes", "u_chloe", true], ["Maquette haute fidélité", "u_chloe"], ["Prototype animé", "u_chloe"]] },
      { title: "Synchronisation hors ligne : file d'opérations", section: "En cours", assignee: "u_karim", due: 9, start: -1, priority: "high", tags: ["tech"] },
      { title: "Plan de test du mode hors ligne", section: "À faire", assignee: "u_theo", due: 12, priority: "medium", tags: ["qa"] },
      { title: "Bug : le panier se vide après mise en arrière-plan", section: "Backlog", priority: "none", tags: ["bug"],
        desc: "Remonté par le support. Sur Android, le panier est perdu quand l'app passe en arrière-plan plus de 5 minutes." },
      { title: "Accessibilité : contrastes et tailles de police dynamiques", section: "Backlog", assignee: "u_chloe", due: 20, priority: "medium", tags: ["design", "a11y"] },
      { title: "Instrumentation analytics du tunnel de paiement", section: "À faire", assignee: "u_ines", due: 8, priority: "medium", tags: ["data"] },
      { title: "Revue de sécurité du paiement", section: "En revue", assignee: "u_karim", due: 3, priority: "urgent", tags: ["sécurité"],
        comments: [["u_theo", "Deux points mineurs remontés, rien de bloquant.", 1]] },
      { title: "Rédiger les notes de version", section: "Backlog", due: 30, priority: "low", tags: ["release"] },
      { title: "Préparer les fiches App Store et Play Store", section: "À faire", assignee: "u_hugo", due: 25, priority: "medium", tags: ["release", "marketing"] },
      { title: "Point d'avancement hebdo", section: "À faire", due: 1, priority: "medium", tags: ["suivi"],
        desc: "Faire le point : ce qui est terminé, ce qui est en retard, les blocages. Relancer les personnes concernées et proposer un plan si besoin." },
      { title: "Migration des comptes utilisateurs v1", section: "Terminé", assignee: "u_karim", due: -6, done: 5, priority: "high", tags: ["tech"] },
      { title: "Icônes et illustrations de l'onboarding", section: "Terminé", assignee: "u_chloe", due: -3, done: 2, tags: ["design"] },
    ],
  });

  // ------------------------------------------------------------------ Projet 2
  const camp = project("u_hugo", {
    name: "Campagne de lancement", icon: "megaphone", color: "#F76B15", due: 45, createdDaysAgo: 15,
    description: "Campagne d'acquisition pour la sortie de l'app v2 : vidéo, réseaux sociaux, presse et partenaires.",
    sections: ["Idées", "Production", "Validation", "Publié"],
    members: [["u_alice", "editor"], ["u_chloe", "editor"], ["u_ines", "editor"], ["ai_atlas", "editor"]],
    tasks: [
      { title: "Brief créatif de la campagne", section: "Publié", assignee: "u_hugo", due: -8, done: 7, priority: "high" },
      { title: "Script de la vidéo de lancement", section: "Validation", assignee: "u_hugo", due: 2, priority: "high", tags: ["vidéo"] },
      { title: "Storyboard vidéo", section: "Production", assignee: "u_chloe", due: 6, priority: "medium", tags: ["vidéo"] },
      { title: "Calendrier éditorial réseaux sociaux", section: "Production", assignee: "u_hugo", due: -1, priority: "medium", tags: ["social"] },
      { title: "Liste des journalistes et influenceurs", section: "Idées", assignee: "u_hugo", due: 14 },
      { title: "Tableau de suivi des conversions", section: "Production", assignee: "u_ines", due: 10, tags: ["data"] },
      { title: "Visuels pour les stores", section: "Idées", assignee: "u_chloe", due: 18, tags: ["design"] },
      { title: "Budget média T4", section: "Publié", assignee: "u_alice", due: -5, done: 4 },
    ],
  });

  // ------------------------------------------------------------------ Projet 3
  project("u_chloe", {
    name: "Refonte du site web", icon: "globe", color: "#12A594", due: 60, createdDaysAgo: 10,
    description: "Nouveau site vitrine aligné sur la nouvelle identité : pages produit, tarifs, blog et centre d'aide.",
    sections: ["À faire", "En cours", "Terminé"],
    members: [["u_alice", "admin"], ["u_hugo", "editor"], ["u_karim", "viewer"], ["ai_atlas", "editor"]],
    tasks: [
      { title: "Arborescence et contenus clés", section: "Terminé", assignee: "u_chloe", due: -4, done: 3 },
      { title: "Design system web", section: "En cours", assignee: "u_chloe", due: 7, priority: "high" },
      { title: "Page tarifs", section: "À faire", assignee: "u_hugo", due: 15 },
      { title: "Migration du blog", section: "À faire", due: 28 },
      { title: "Centre d'aide : structure des articles", section: "À faire", assignee: "u_hugo", due: 21 },
    ],
  });

  // ------------------------------------------------------------------ Projet 4 (confidentiel)
  project("u_alice", {
    name: "RH · Recrutements 2027", icon: "lock", color: "#D6409F", due: 90, createdDaysAgo: 6,
    description: "Confidentiel. Ouverture de postes, grilles de rémunération et calendrier des entretiens.",
    sections: ["À faire", "En cours", "Terminé"],
    members: [["u_ines", "editor"]],
    tasks: [
      { title: "Grille de rémunération 2027", section: "En cours", assignee: "u_alice", due: 12, priority: "high" },
      { title: "Fiche de poste : développeur·se mobile senior", section: "À faire", assignee: "u_ines", due: 9 },
    ],
  });

  // Règle IA d'exemple : Nova trie chaque nouvelle tâche du Backlog
  run(db, "INSERT INTO ai_rules (id, project_id, name, trigger, section_id, agent_id, instructions, auto_approve, enabled, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    uid("rul"), app.id, "Triage du backlog", "task_created", app.sections.find((s) => s.name === "Backlog")!.id, "ai_nova",
    "Qualifie la nouvelle tâche : fixe une priorité selon l'impact utilisateur. Si c'est un bug sans étapes de reproduction, demande-les en commentaire. Si un test est nécessaire, mentionne @Théo.", 0, 1, "u_alice", now());

  // Mémoires de départ
  run(db, "INSERT INTO ai_memories (id, agent_id, object_type, object_id, project_id, content, created_at) VALUES (?,?,?,?,?,?,?)",
    uid("mem"), "ai_atlas", "project", app.id, app.id, "Alice veut les risques en premier dans chaque point d'avancement.", now());
  run(db, "INSERT INTO ai_memories (id, agent_id, object_type, object_id, project_id, content, created_at) VALUES (?,?,?,?,?,?,?)",
    uid("mem"), "ai_atlas", "project", camp.id, camp.id, "La vidéo de lancement doit être validée par Alice avant toute diffusion.", now());

  // Historique d'activité plausible
  run(db, "UPDATE activity SET created_at = (SELECT t.created_at FROM tasks t WHERE t.id = activity.task_id) WHERE task_id IS NOT NULL");
}
