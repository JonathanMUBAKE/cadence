import { uid } from "./db.js";
import { localDate, type Services, type Priority, type Role } from "./services.js";

const d = (offset: number) => { const x = new Date(); x.setDate(x.getDate() + offset); return localDate(x); };
const ts = (offsetDays: number, hour = 10) => { const x = new Date(); x.setDate(x.getDate() + offsetDays); x.setHours(hour, 12, 0, 0); return x.toISOString(); };

export async function seedIfEmpty(svc: Services) {
  if (await svc.db.one("SELECT id FROM users LIMIT 1")) return false;
  await seed(svc);
  return true;
}

export async function seed(svc: Services) {
  const db = svc.db;
  const users: [string, string, string | null, string, string, boolean, string | null, string | null][] = [
    ["u_alice", "Alice Martin", "alice@cadence.app", "Head of Product", "#E5484D", false, null, null],
    ["u_karim", "Karim Benali", "karim@cadence.app", "Lead développeur mobile", "#0090FF", false, null, null],
    ["u_chloe", "Chloé Dubois", "chloe@cadence.app", "Product designer", "#D6409F", false, null, null],
    ["u_hugo", "Hugo Lefèvre", "hugo@cadence.app", "Responsable marketing", "#F76B15", false, null, null],
    ["u_ines", "Inès Moreau", "ines@cadence.app", "Responsable RH", "#12A594", false, null, null],
    ["u_theo", "Théo Garnier", "theo@cadence.app", "Ingénieur QA", "#8E4EC6", false, null, null],
    ["ai_atlas", "Atlas", null, "Coéquipier IA", "#6E56CF", true, "chef de projet IA : suivi, relances, points d'avancement, découpage du travail",
      "Rapports courts, en puces, risques en premier. Quand tu relances quelqu'un, rappelle toujours l'échéance et propose ton aide. Ne change jamais une échéance sans le signaler."],
    ["ai_nova", "Nova", null, "Coéquipière IA", "#00A2C7", true, "analyste QA et triage : qualifie les bugs, fixe les priorités, prépare les plans de test",
      "Pour un bug : vérifie qu'il y a des étapes de reproduction, un résultat attendu et observé ; sinon demande-les en commentaire. Fixe la priorité selon l'impact utilisateur."],
    ["ai_cadence", "Cadence AI", null, "Assistant", "#6E56CF", true, "assistant conversationnel", null],
  ];
  for (const u of users) await db.query("INSERT INTO users (id, name, email, title, avatar_color, is_ai, ai_role, ai_instructions) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", u);

  // ------------------------------------------------------------------ organisation Nova Mobile
  const org = await svc.createOrg("u_alice", { name: "Nova Mobile", domains: ["cadence.app"] });
  const root = (await db.one<{ id: string }>("SELECT id FROM org_units WHERE org_id = $1 AND parent_id IS NULL", [org.id]))!.id;
  for (const [u, role] of [["u_karim", "member"], ["u_chloe", "member"], ["u_hugo", "member"], ["u_ines", "member"], ["u_theo", "member"], ["ai_atlas", "member"], ["ai_nova", "member"], ["ai_cadence", "member"]] as const) {
    await svc.addOrgMember(org.id, u, role);
  }
  const unit = (name: string, kind: string, parent: string, manager: string | null) => svc.createUnit("u_alice", org.id, { name, kind, parent_id: parent, manager_id: manager });
  const dirProduit = await unit("Direction Produit & Technologie", "Direction", root, "u_alice");
  const produit = await unit("Produit & Design", "Département", dirProduit, "u_chloe");
  const inge = await unit("Ingénierie", "Département", dirProduit, "u_karim");
  const mobile = await unit("Mobile", "Service", inge, "u_karim");
  const qualite = await unit("Qualité", "Service", inge, "u_theo");
  const dirMarketing = await unit("Direction Marketing", "Direction", root, "u_hugo");
  const acquisition = await unit("Acquisition", "Service", dirMarketing, "u_hugo");
  const dirGenerale = await unit("Direction Générale", "Direction", root, "u_alice");
  const rh = await unit("Ressources humaines", "Service", dirGenerale, "u_ines");
  for (const [u, un] of [["u_alice", dirProduit], ["u_karim", mobile], ["u_chloe", produit], ["u_theo", qualite], ["u_hugo", acquisition], ["u_ines", rh]] as const) {
    await svc.setMemberUnit("u_alice", org.id, u, un);
  }

  const team = async (by: string, name: string, unitId: string, visibility: "public" | "request" | "private", color: string, description: string, members: [string, "lead" | "member"][]) => {
    const t = await svc.createTeam(by, org.id, { name, unit_id: unitId, visibility, color, description });
    for (const [u, r] of members) await svc.setTeamMember(by, t.id, u, r);
    return t.id;
  };
  const tMobile = await team("u_karim", "Équipe Mobile", mobile, "public", "#0090FF", "Développement et qualité des applications iOS et Android.", [["u_theo", "member"]]);
  const tProduit = await team("u_chloe", "Produit & Design", produit, "public", "#D6409F", "Vision produit, recherche utilisateur et design.", [["u_alice", "member"]]);
  const tMarketing = await team("u_hugo", "Marketing", acquisition, "request", "#F76B15", "Acquisition, contenus et lancements.", []);
  const tRh = await team("u_ines", "RH", rh, "private", "#12A594", "Recrutements, rémunération, vie de l'entreprise.", [["u_alice", "lead"]]);

  type T = { title: string; section: string; assignee?: string; due?: number; start?: number; priority?: Priority; done?: number; tags?: string[]; desc?: string; subs?: [string, string?, boolean?][]; comments?: [string, string, number][] };
  const project = async (by: string, p: { name: string; key: string; team: string; access?: "team" | "private"; description: string; color: string; icon: string; due: number; status?: "on_track" | "at_risk" | "off_track"; sections: string[]; members: [string, Role][]; tasks: T[]; createdDaysAgo: number }, orgId = org.id) => {
    const pr = await svc.createProject(by, orgId, { name: p.name, key: p.key, team_id: p.team, access: p.access ?? "team", description: p.description, color: p.color, icon: p.icon, due_on: d(p.due), sections: p.sections });
    if (p.status) await db.query("UPDATE projects SET status = $1 WHERE id = $2", [p.status, pr.id]);
    await db.query("UPDATE projects SET created_at = $1 WHERE id = $2", [ts(-p.createdDaysAgo), pr.id]);
    for (const [u, role] of p.members) await svc.setMember(by, pr.id, u, role);
    const sec = (name: string) => pr.sections.find((s) => s.name === name)!.id;
    for (let i = 0; i < p.tasks.length; i++) {
      const t = p.tasks[i];
      const task = await svc.createTask(by, {
        project_id: pr.id, title: t.title, description: t.desc ?? "", section_id: sec(t.section), assignee_id: t.assignee ?? null,
        due_on: t.due === undefined ? null : d(t.due), start_on: t.start === undefined ? null : d(t.start), priority: t.priority ?? "none", tags: t.tags ?? [],
      });
      const created = ts(-p.createdDaysAgo + Math.min(i, p.createdDaysAgo - 1));
      await db.query("UPDATE tasks SET created_at = $1, updated_at = $1 WHERE id = $2", [created, task.id]);
      if (t.done !== undefined) await db.query("UPDATE tasks SET completed = TRUE, completed_at = $1 WHERE id = $2", [ts(-t.done, 16), task.id]);
      for (const [title, who, done] of t.subs ?? []) {
        const s = await svc.createTask(by, { project_id: pr.id, parent_id: task.id, title, assignee_id: who ?? null });
        if (done) await db.query("UPDATE tasks SET completed = TRUE, completed_at = $1 WHERE id = $2", [ts(-2), s.id]);
      }
      for (const [author, body, ago] of t.comments ?? []) {
        await db.query("INSERT INTO comments (id, task_id, author_id, body, created_at) VALUES ($1,$2,$3,$4,$5)", [uid("cmt"), task.id, author, body, ts(-ago, 9 + (ago % 8))]);
      }
    }
    return pr;
  };

  const app = await project("u_alice", {
    name: "Application mobile v2", key: "APP", team: tMobile, icon: "smartphone", color: "#6E56CF", due: 37, createdDaysAgo: 24, status: "at_risk",
    description: "Refonte complète de l'app iOS et Android : nouveau parcours de paiement, mode hors ligne et tableau de bord personnalisé. Objectif : publication sur les stores avant la fin de l'année.",
    sections: ["Backlog", "À faire", "En cours", "En revue", "Terminé"],
    members: [["u_chloe", "editor"], ["u_ines", "commenter"], ["u_hugo", "viewer"], ["ai_atlas", "editor"], ["ai_nova", "editor"]],
    tasks: [
      { title: "Maquettes du nouveau parcours de paiement", section: "Terminé", assignee: "u_chloe", due: -12, done: 11, priority: "high", tags: ["design"],
        desc: "Écrans panier → paiement → confirmation, états d'erreur inclus. Validé en revue produit.", comments: [["u_alice", "Validé, beau travail. On part là-dessus.", 11]] },
      { title: "Définir l'architecture du mode hors ligne", section: "Terminé", assignee: "u_karim", due: -9, done: 8, priority: "high", tags: ["tech"],
        desc: "Choix de la stratégie de synchronisation (file d'opérations + résolution des conflits côté serveur)." },
      { title: "Intégrer le SDK de paiement", section: "En cours", assignee: "u_karim", due: -4, start: -10, priority: "urgent", tags: ["tech", "paiement"],
        desc: "Intégration du SDK du prestataire pour carte bancaire, Apple Pay et Google Pay.\n\nBloquant : il nous manque la clé API sandbox.",
        subs: [["Carte bancaire", "u_karim", true], ["Apple Pay", "u_karim"], ["Google Pay", "u_karim"]],
        comments: [["u_karim", "J'attends toujours la clé sandbox du prestataire, relancé deux fois.", 3], ["u_alice", "Je m'en occupe avec leur account manager.", 2]] },
      { title: "Tests de non-régression iOS", section: "À faire", assignee: "u_theo", due: -2, priority: "high", tags: ["qa"], desc: "Campagne complète sur iPhone 13 à 17, iOS 18 et 19." },
      { title: "Écran tableau de bord personnalisé", section: "En cours", assignee: "u_chloe", due: 5, start: -3, priority: "medium", tags: ["design"],
        subs: [["Wireframes", "u_chloe", true], ["Maquette haute fidélité", "u_chloe"], ["Prototype animé", "u_chloe"]] },
      { title: "Synchronisation hors ligne : file d'opérations", section: "En cours", assignee: "u_karim", due: 9, start: -1, priority: "high", tags: ["tech"] },
      { title: "Plan de test du mode hors ligne", section: "À faire", assignee: "u_theo", due: 12, priority: "medium", tags: ["qa"] },
      { title: "Bug : le panier se vide après mise en arrière-plan", section: "Backlog", priority: "none", tags: ["bug"],
        desc: "Remonté par le support. Sur Android, le panier est perdu quand l'app passe en arrière-plan plus de 5 minutes." },
      { title: "Accessibilité : contrastes et tailles de police dynamiques", section: "Backlog", assignee: "u_chloe", due: 20, priority: "medium", tags: ["design", "a11y"] },
      { title: "Instrumentation analytics du tunnel de paiement", section: "À faire", assignee: "u_ines", due: 8, priority: "medium", tags: ["data"] },
      { title: "Revue de sécurité du paiement", section: "En revue", assignee: "u_karim", due: 3, priority: "urgent", tags: ["sécurité"], comments: [["u_theo", "Deux points mineurs remontés, rien de bloquant.", 1]] },
      { title: "Rédiger les notes de version", section: "Backlog", due: 30, priority: "low", tags: ["release"] },
      { title: "Préparer les fiches App Store et Play Store", section: "À faire", assignee: "u_hugo", due: 25, priority: "medium", tags: ["release", "marketing"] },
      { title: "Point d'avancement hebdo", section: "À faire", due: 1, priority: "medium", tags: ["suivi"],
        desc: "Faire le point : ce qui est terminé, ce qui est en retard, les blocages. Relancer les personnes concernées et proposer un plan si besoin." },
      { title: "Migration des comptes utilisateurs v1", section: "Terminé", assignee: "u_karim", due: -6, done: 5, priority: "high", tags: ["tech"] },
      { title: "Icônes et illustrations de l'onboarding", section: "Terminé", assignee: "u_chloe", due: -3, done: 2, tags: ["design"] },
    ],
  });

  const camp = await project("u_hugo", {
    name: "Campagne de lancement", key: "CAMP", team: tMarketing, icon: "megaphone", color: "#F76B15", due: 45, createdDaysAgo: 15,
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

  await project("u_chloe", {
    name: "Refonte du site web", key: "WEB", team: tProduit, icon: "globe", color: "#12A594", due: 60, createdDaysAgo: 10,
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

  await project("u_alice", {
    name: "RH · Recrutements 2027", key: "RH", team: tRh, access: "private", icon: "lock", color: "#D6409F", due: 90, createdDaysAgo: 6,
    description: "Confidentiel. Ouverture de postes, grilles de rémunération et calendrier des entretiens.",
    sections: ["À faire", "En cours", "Terminé"],
    members: [["u_ines", "editor"]],
    tasks: [
      { title: "Grille de rémunération 2027", section: "En cours", assignee: "u_alice", due: 12, priority: "high" },
      { title: "Fiche de poste : développeur·se mobile senior", section: "À faire", assignee: "u_ines", due: 9 },
    ],
  });

  // Règle IA d'exemple : Nova trie chaque nouvelle tâche du Backlog
  await db.query("INSERT INTO ai_rules (id, project_id, name, trigger, section_id, agent_id, instructions, auto_approve, enabled, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,FALSE,TRUE,$8)",
    [uid("rul"), app.id, "Triage du backlog", "task_created", app.sections.find((s) => s.name === "Backlog")!.id, "ai_nova",
      "Qualifie la nouvelle tâche : fixe une priorité selon l'impact utilisateur. Si c'est un bug sans étapes de reproduction, demande-les en commentaire. Si un test est nécessaire, mentionne @Théo.", "u_alice"]);
  await db.query("INSERT INTO ai_memories (id, agent_id, object_type, object_id, project_id, content) VALUES ($1,'ai_atlas','project',$2,$2,$3)",
    [uid("mem"), app.id, "Alice veut les risques en premier dans chaque point d'avancement."]);
  await db.query("INSERT INTO ai_memories (id, agent_id, object_type, object_id, project_id, content) VALUES ($1,'ai_atlas','project',$2,$2,$3)",
    [uid("mem"), camp.id, "La vidéo de lancement doit être validée par Alice avant toute diffusion."]);
  await db.query("UPDATE activity SET created_at = t.created_at FROM tasks t WHERE t.id = activity.task_id");

  // ------------------------------------------------------------------ second espace : Studio Lumen
  const studio = await svc.createOrg("u_hugo", { name: "Studio Lumen" });
  await svc.addOrgMember(studio.id, "u_alice", "member");
  const sRoot = (await db.one<{ id: string }>("SELECT id FROM org_units WHERE org_id = $1 AND parent_id IS NULL", [studio.id]))!.id;
  const sTeam = await svc.createTeam("u_hugo", studio.id, { name: "Création", unit_id: sRoot, visibility: "public", color: "#0090FF" });
  await svc.setTeamMember("u_hugo", sTeam.id, "u_alice", "member");
  const idv = await svc.createProject("u_hugo", studio.id, { name: "Identité visuelle client", key: "IDV", team_id: sTeam.id, icon: "target", color: "#0090FF", due_on: d(20), sections: ["À faire", "En cours", "Terminé"] });
  for (const [title, who, due] of [["Moodboard et pistes créatives", "u_hugo", 3], ["Déclinaisons du logo", "u_alice", 8], ["Charte graphique PDF", "u_hugo", 15]] as const) {
    await svc.createTask("u_hugo", { project_id: idv.id, title, assignee_id: who, due_on: d(due) });
  }
}
