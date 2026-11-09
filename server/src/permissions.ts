/** Catalogue des droits qu'un profil peut cocher. Ajouter une ligne ici la rend disponible partout. */
export const PERMISSION_GROUPS = [
  { group: "Projets", items: [
    { key: "projects.create", label: "Créer des projets" }, { key: "projects.import", label: "Importer un projet depuis un fichier" },
    { key: "projects.edit", label: "Modifier les projets" }, { key: "projects.archive", label: "Archiver et restaurer les projets" },
    { key: "projects.delete", label: "Supprimer les projets" }, { key: "projects.members", label: "Gérer les membres des projets" },
    { key: "sections.manage", label: "Gérer les sections" },
  ] },
  { group: "Tâches", items: [
    { key: "tasks.create", label: "Créer des tâches" }, { key: "tasks.edit", label: "Modifier les tâches" }, { key: "tasks.delete", label: "Supprimer des tâches" },
    { key: "tasks.move", label: "Déplacer des tâches vers un autre projet" }, { key: "tasks.comment", label: "Commenter" },
    { key: "attachments.upload", label: "Joindre des fichiers" }, { key: "attachments.delete", label: "Supprimer des pièces jointes" },
  ] },
  { group: "Intelligence artificielle", items: [
    { key: "ai.assistant", label: "Utiliser l'assistant" }, { key: "ai.delegate", label: "Confier du travail à l'IA" },
    { key: "ai.approve", label: "Valider les actions de l'IA" }, { key: "ai.rules", label: "Gérer les règles IA" },
  ] },
  { group: "Équipes", items: [{ key: "teams.create", label: "Créer des équipes" }, { key: "teams.manage", label: "Gérer les équipes dont on est responsable" }] },
  { group: "Administration de l'organisation", items: [
    { key: "org.settings", label: "Modifier l'organisation" }, { key: "org.structure", label: "Gérer l'organigramme" }, { key: "org.members", label: "Inviter et gérer les personnes" },
    { key: "org.profiles", label: "Gérer les profils et les droits" }, { key: "org.mail", label: "Configurer la messagerie" },
  ] },
] as const;

export type Permission = (typeof PERMISSION_GROUPS)[number]["items"][number]["key"];
export type BaseRole = "owner" | "admin" | "member" | "guest";

export const ALL_PERMISSIONS = PERMISSION_GROUPS.flatMap((g) => g.items.map((i) => i.key)) as Permission[];
const LABELS = new Map<string, string>(PERMISSION_GROUPS.flatMap((g) => g.items.map((i) => [i.key, i.label] as const)));
export const permissionLabel = (p: string) => LABELS.get(p) ?? p;
export const isPermission = (p: string): p is Permission => LABELS.has(p);

const ADMIN_ONLY = (p: Permission) => p.startsWith("org.");
const NOT_FOR_GUESTS = new Set<Permission>(["projects.create", "projects.import", "teams.create", "teams.manage"]);

/** Droits des quatre profils créés avec chaque organisation : ils reproduisent les rôles historiques. */
export const SYSTEM_PROFILES: { role: BaseRole; name: string; description: string; permissions: Permission[] }[] = [
  { role: "owner", name: "Propriétaire", description: "Tous les droits. Ce profil ne peut pas être modifié.", permissions: ALL_PERMISSIONS },
  { role: "admin", name: "Administrateur", description: "Administre l'organisation, ses personnes et ses projets.", permissions: ALL_PERMISSIONS },
  { role: "member", name: "Membre", description: "Travaille dans les équipes et les projets auxquels il a accès.", permissions: ALL_PERMISSIONS.filter((p) => !ADMIN_ONLY(p)) },
  { role: "guest", name: "Invité", description: "N'accède qu'aux projets partagés avec lui.", permissions: ALL_PERMISSIONS.filter((p) => !ADMIN_ONLY(p) && !NOT_FOR_GUESTS.has(p)) },
];

/** Profil + exceptions individuelles : une exception l'emporte toujours sur le profil. */
export function effectivePermissions(role: BaseRole, profile: string[] | null, overrides: Record<string, boolean>): Permission[] {
  if (role === "owner") return ALL_PERMISSIONS;
  const base = new Set<string>(profile ?? SYSTEM_PROFILES.find((p) => p.role === role)!.permissions);
  for (const [k, allowed] of Object.entries(overrides)) { if (allowed) base.add(k); else base.delete(k); }
  return ALL_PERMISSIONS.filter((p) => base.has(p));
}
