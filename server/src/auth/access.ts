import { uid } from "../db.js";
import {
  ALL_PERMISSIONS,
  PERMISSION_GROUPS,
  effectivePermissions,
  isPermission,
  type BaseRole,
} from "../permissions.js";
import { badRequest, forbidden, notFound, type OrgRole, type Services } from "../services.js";
import type { Auth, RequestInfo } from "./service.js";

export interface AccessProfile {
  id: string;
  org_id: string;
  name: string;
  description: string;
  base_role: BaseRole;
  permissions: string[];
  is_system: boolean;
  member_count?: number;
}
export interface ProfileInput {
  name: string;
  description?: string;
  base_role: BaseRole;
  permissions: string[];
}
const RANK: Record<OrgRole, number> = { guest: 1, member: 2, admin: 3, owner: 4 };

/** Profils d'accès et exceptions individuelles, avec une règle centrale : on ne donne jamais plus que ce qu'on possède. */
export class Access {
  constructor(
    private svc: Services,
    private auth: Auth,
  ) {}

  catalog() {
    return PERMISSION_GROUPS;
  }

  async list(actorId: string, orgId: string) {
    await this.svc.requirePerm(actorId, orgId, "org.profiles");
    return this.svc.db.query<AccessProfile>(
      `SELECT p.*, (SELECT count(*)::int FROM org_members m WHERE m.profile_id = p.id) AS member_count FROM access_profiles p WHERE p.org_id = $1 ORDER BY p.is_system DESC, p.created_at`,
      [orgId],
    );
  }

  async profile(orgId: string, id: string) {
    const p = await this.svc.db.one<AccessProfile>("SELECT * FROM access_profiles WHERE id = $1 AND org_id = $2", [
      id,
      orgId,
    ]);
    if (!p) throw badRequest("Profil invalide pour cette organisation");
    return p;
  }

  private async mine(actorId: string, orgId: string) {
    return {
      role: (await this.svc.orgRole(actorId, orgId))!,
      perms: new Set<string>(await this.svc.permissionsOf(actorId, orgId)),
    };
  }
  private assertSubset(perms: string[], mine: { role: OrgRole; perms: Set<string> }) {
    if (mine.role === "owner") return;
    if (perms.some((p) => !mine.perms.has(p)))
      throw forbidden("Vous ne pouvez pas accorder un droit que vous ne possédez pas");
  }
  private assertRole(role: OrgRole, mine: { role: OrgRole }) {
    if (mine.role !== "owner" && RANK[role] > RANK[mine.role])
      throw forbidden("Vous ne pouvez pas attribuer un niveau d'accès supérieur au vôtre");
  }
  private clean(perms: string[]) {
    const unknown = perms.find((p) => !isPermission(p));
    if (unknown) throw badRequest(`Droit inconnu : ${unknown}`);
    return ALL_PERMISSIONS.filter((p) => perms.includes(p));
  }

  async create(actorId: string, orgId: string, input: ProfileInput, info: RequestInfo) {
    await this.svc.requirePerm(actorId, orgId, "org.profiles");
    const mine = await this.mine(actorId, orgId);
    const permissions = this.clean(input.permissions);
    this.assertSubset(permissions, mine);
    this.assertRole(input.base_role, mine);
    if (input.base_role === "owner") throw badRequest("Le niveau Propriétaire est réservé au profil système");
    if (
      await this.svc.db.one("SELECT 1 FROM access_profiles WHERE org_id = $1 AND lower(name) = lower($2)", [
        orgId,
        input.name.trim(),
      ])
    )
      throw badRequest("Un profil porte déjà ce nom");
    const id = uid("prf");
    await this.svc.db.query(
      "INSERT INTO access_profiles (id, org_id, name, description, base_role, permissions) VALUES ($1,$2,$3,$4,$5,$6)",
      [id, orgId, input.name.trim(), input.description ?? "", input.base_role, JSON.stringify(permissions)],
    );
    await this.auth.record("profile.created", { actorId, ip: info.ip, data: { org_id: orgId, name: input.name } });
    return this.profile(orgId, id);
  }

  async update(actorId: string, orgId: string, id: string, patch: Partial<ProfileInput>, info: RequestInfo) {
    await this.svc.requirePerm(actorId, orgId, "org.profiles");
    const p = await this.profile(orgId, id);
    if (p.base_role === "owner") throw badRequest("Le profil Propriétaire ne peut pas être modifié");
    const mine = await this.mine(actorId, orgId);
    this.assertRole(p.base_role, mine);
    const permissions = patch.permissions ? this.clean(patch.permissions) : p.permissions;
    if (patch.permissions) {
      // Seuls les droits ajoutés comptent : on peut retirer ce qu'on ne possède pas soi-même
      this.assertSubset(
        permissions.filter((x) => !p.permissions.includes(x)),
        mine,
      );
    }
    const baseRole = patch.base_role ?? p.base_role;
    if (patch.base_role && patch.base_role !== p.base_role) {
      if (p.is_system) throw badRequest("Le niveau d'accès d'un profil système ne change pas");
      if (patch.base_role === "owner") throw badRequest("Le niveau Propriétaire est réservé au profil système");
      this.assertRole(patch.base_role, mine);
    }
    await this.svc.db.tx(async (q) => {
      await q.query(
        "UPDATE access_profiles SET name = $1, description = $2, base_role = $3, permissions = $4 WHERE id = $5",
        [
          p.is_system ? p.name : patch.name?.trim() || p.name,
          patch.description ?? p.description,
          baseRole,
          JSON.stringify(permissions),
          id,
        ],
      );
      if (baseRole !== p.base_role)
        await q.query("UPDATE org_members SET role = $1 WHERE profile_id = $2", [baseRole, id]);
    });
    await this.auth.record("profile.updated", {
      actorId,
      ip: info.ip,
      data: { org_id: orgId, name: p.name, permissions },
    });
    this.svc.bus.emit({ type: "org.changed", actorId, orgId });
    return this.profile(orgId, id);
  }

  async remove(actorId: string, orgId: string, id: string, info: RequestInfo) {
    await this.svc.requirePerm(actorId, orgId, "org.profiles");
    const p = await this.profile(orgId, id);
    if (p.is_system) throw badRequest("Un profil système ne peut pas être supprimé");
    this.assertRole(p.base_role, await this.mine(actorId, orgId));
    const used = await this.svc.db.one<{ n: number }>(
      "SELECT count(*)::int AS n FROM org_members WHERE profile_id = $1",
      [id],
    );
    if (used?.n) throw badRequest(`Ce profil est encore attribué à ${used.n} personne(s)`);
    await this.svc.db.query("DELETE FROM access_profiles WHERE id = $1", [id]);
    await this.auth.record("profile.deleted", { actorId, ip: info.ip, data: { org_id: orgId, name: p.name } });
  }

  /** Vérifie qu'un profil peut être attribué par cette personne, avant une invitation ou un changement. */
  async assertCanAssign(actorId: string, orgId: string, profileId: string) {
    const [p, mine] = [await this.profile(orgId, profileId), await this.mine(actorId, orgId)];
    this.assertRole(p.base_role, mine);
    this.assertSubset(p.permissions, mine);
    return p;
  }

  private async target(actorId: string, orgId: string, userId: string) {
    const role = await this.svc.orgRole(userId, orgId);
    if (!role) throw notFound("Cette personne n'est pas membre de l'organisation");
    const mine = await this.mine(actorId, orgId);
    if (mine.role !== "owner" && RANK[role] > RANK[mine.role])
      throw forbidden("Vous ne pouvez pas modifier une personne de niveau supérieur au vôtre");
    if (mine.role !== "owner" && role === "admin" && userId !== actorId)
      throw forbidden("Seul un propriétaire peut modifier un administrateur");
    return { role, mine };
  }

  async assign(actorId: string, orgId: string, userId: string, profileId: string, info: RequestInfo) {
    await this.svc.requirePerm(actorId, orgId, "org.members");
    const { role } = await this.target(actorId, orgId, userId);
    const p = await this.assertCanAssign(actorId, orgId, profileId);
    if (role === "owner" && p.base_role !== "owner") {
      const owners = await this.svc.db.one<{ n: number }>(
        "SELECT count(*)::int AS n FROM org_members WHERE org_id = $1 AND role = 'owner'",
        [orgId],
      );
      if ((owners?.n ?? 0) <= 1) throw badRequest("Impossible de retirer le dernier propriétaire de l'organisation");
    }
    await this.svc.db.query("UPDATE org_members SET profile_id = $1, role = $2 WHERE org_id = $3 AND user_id = $4", [
      p.id,
      p.base_role,
      orgId,
      userId,
    ]);
    await this.auth.record("member.profile", {
      userId,
      actorId,
      ip: info.ip,
      data: { org_id: orgId, profile: p.name },
    });
    this.svc.bus.emit({ type: "org.changed", actorId, orgId });
  }

  async memberAccess(actorId: string, orgId: string, userId: string) {
    if (actorId !== userId) await this.svc.requirePerm(actorId, orgId, "org.members");
    const r = await this.svc.db.one<{
      role: BaseRole;
      profile_id: string | null;
      permission_overrides: Record<string, boolean>;
      profile_permissions: string[] | null;
    }>(
      `SELECT om.role, om.profile_id, om.permission_overrides, p.permissions AS profile_permissions FROM org_members om LEFT JOIN access_profiles p ON p.id = om.profile_id WHERE om.org_id = $1 AND om.user_id = $2`,
      [orgId, userId],
    );
    if (!r) throw notFound("Cette personne n'est pas membre de l'organisation");
    return {
      role: r.role,
      profile_id: r.profile_id,
      overrides: r.permission_overrides,
      profile_permissions: r.profile_permissions ?? [],
      effective: effectivePermissions(r.role, r.profile_permissions, r.permission_overrides),
    };
  }

  /** Exceptions individuelles : true accorde, false retire, null revient au profil. */
  async setOverrides(
    actorId: string,
    orgId: string,
    userId: string,
    changes: Record<string, boolean | null>,
    info: RequestInfo,
  ) {
    await this.svc.requirePerm(actorId, orgId, "org.members");
    const { mine } = await this.target(actorId, orgId, userId);
    this.clean(Object.keys(changes));
    if (mine.role !== "owner") {
      const granted = Object.entries(changes)
        .filter(([, v]) => v === true)
        .map(([k]) => k);
      this.assertSubset(granted, mine);
      if (actorId === userId && granted.length) throw forbidden("Vous ne pouvez pas vous accorder de droits vous-même");
    }
    const current = (await this.memberAccess(actorId, orgId, userId)).overrides;
    const next = { ...current };
    for (const [k, v] of Object.entries(changes)) {
      if (v === null) delete next[k];
      else next[k] = v;
    }
    await this.svc.db.query("UPDATE org_members SET permission_overrides = $1 WHERE org_id = $2 AND user_id = $3", [
      JSON.stringify(next),
      orgId,
      userId,
    ]);
    await this.auth.record("member.permissions", { userId, actorId, ip: info.ip, data: { org_id: orgId, changes } });
    this.svc.bus.emit({ type: "org.changed", actorId, orgId });
  }
}
