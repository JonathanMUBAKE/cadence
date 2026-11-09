import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Access } from "./access.js";
import type { Provisioning } from "./provisioning.js";
import { SESSION_COOKIE, SESSION_MAX_AGE, type Auth, type RequestInfo } from "./service.js";

export interface AuthDeps { auth: Auth; provisioning: Provisioning; access: Access; secureCookies: boolean; demoLogin: boolean; clearOrgCookie: (reply: FastifyReply) => void }

const email = z.string().trim().max(320);
const password = z.string().min(1).max(1024);
const token = z.string().min(10).max(200);
const info = (req: FastifyRequest): RequestInfo => ({ ip: req.ip, userAgent: String(req.headers["user-agent"] ?? "") });

export function sessionCookie(reply: FastifyReply, value: string, secure: boolean) {
  reply.setCookie(SESSION_COOKIE, value, { path: "/", httpOnly: true, sameSite: "lax", secure, maxAge: SESSION_MAX_AGE });
}

/** Routes accessibles sans session. */
export function publicAuthRoutes(app: FastifyInstance, d: AuthDeps) {
  const { auth, provisioning } = d;
  app.get("/api/auth/config", async () => ({ demo: d.demoLogin, registration: await provisioning.registration() }));
  app.post("/api/auth/mfa", async (req) => { await auth.verifyMfa(req.cookies[SESSION_COOKIE], z.object({ code: z.string().min(6).max(20) }).parse(req.body).code, info(req)); return { status: "ok" }; });
  app.post("/api/auth/token", async (req) => provisioning.peek(z.object({ token }).parse(req.body).token));
  app.post("/api/auth/activate", async (req) => {
    const b = z.object({ token, password, name: z.string().trim().max(120).optional(), email: email.optional() }).parse(req.body);
    await provisioning.activate(b.token, b.password, { name: b.name, email: b.email }, info(req));
    return { ok: true };
  });
  app.post("/api/auth/reset", async (req) => { const b = z.object({ token, password }).parse(req.body); await provisioning.reset(b.token, b.password, info(req)); return { ok: true }; });
  app.post("/api/auth/forgot", async (req) => { await provisioning.forgot(z.object({ email }).parse(req.body).email, info(req)); return { ok: true }; });
  app.post("/api/auth/request-access", async (req) => {
    await provisioning.requestAccess(z.object({ name: z.string().trim().min(1).max(120), email: email.regex(/^[^@\s]+@[^@\s]+$/), note: z.string().max(500).optional() }).parse(req.body), info(req));
    return { ok: true };
  });
  app.post("/api/auth/logout", async (req, reply) => {
    await auth.logout(req.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    d.clearOrgCookie(reply);
    return { ok: true };
  });
}

/** Routes réservées aux personnes connectées. */
export function privateAuthRoutes(r: FastifyInstance, d: AuthDeps) {
  const { auth, provisioning, access } = d;
  const me = (req: FastifyRequest) => req.userId;
  const org = (req: FastifyRequest) => req.orgId;
  type Id = { Params: { id: string } };
  type UserId = { Params: { userId: string } };

  // ---------------------------------------------------------------- mon compte
  r.get("/api/auth/sessions", async (req) => auth.listSessions(me(req), req.sessionId));
  r.delete<Id>("/api/auth/sessions/:id", async (req) => { await auth.revokeSession(me(req), req.params.id); return { ok: true }; });
  r.post("/api/auth/password", async (req) => {
    const b = z.object({ current: password, password }).parse(req.body);
    await auth.changePassword(me(req), req.sessionId, b.current, b.password, info(req));
    return { ok: true };
  });
  r.post("/api/auth/mfa/setup", async (req) => auth.startMfa(me(req)));
  r.post("/api/auth/mfa/confirm", async (req) => auth.confirmMfa(me(req), z.object({ code: z.string().min(6).max(10) }).parse(req.body).code, info(req)));
  r.post("/api/auth/mfa/disable", async (req) => { await auth.disableMfa(me(req), z.object({ password }).parse(req.body).password, info(req)); return { ok: true }; });

  // ---------------------------------------------------------------- invitations
  r.get("/api/org/invitations", async (req) => provisioning.listInvitations(me(req), org(req)));
  r.post("/api/org/invitations", async (req) => provisioning.invite(me(req), org(req), z.object({ email: email.regex(/^[^@\s]+@[^@\s]+$/), name: z.string().trim().min(1).max(120), profile_id: z.string() }).parse(req.body), info(req)));
  r.post<UserId>("/api/org/invitations/:userId/resend", async (req) => provisioning.resendInvitation(me(req), org(req), req.params.userId));
  r.delete<UserId>("/api/org/invitations/:userId", async (req) => { await provisioning.cancelInvitation(me(req), org(req), req.params.userId, info(req)); return { ok: true }; });

  // ---------------------------------------------------------------- profils et droits
  const Base = z.enum(["owner", "admin", "member", "guest"]);
  const ProfileBody = z.object({ name: z.string().trim().min(1).max(80), description: z.string().max(300).optional(), base_role: Base, permissions: z.array(z.string()).max(100) });
  r.get("/api/org/permissions", async () => access.catalog());
  r.get("/api/org/profiles", async (req) => access.list(me(req), org(req)));
  r.post("/api/org/profiles", async (req) => access.create(me(req), org(req), ProfileBody.parse(req.body), info(req)));
  r.patch<Id>("/api/org/profiles/:id", async (req) => access.update(me(req), org(req), req.params.id, ProfileBody.partial().parse(req.body), info(req)));
  r.delete<Id>("/api/org/profiles/:id", async (req) => { await access.remove(me(req), org(req), req.params.id, info(req)); return { ok: true }; });
  r.put<UserId>("/api/org/members/:userId/profile", async (req) => { await access.assign(me(req), org(req), req.params.userId, z.object({ profile_id: z.string() }).parse(req.body).profile_id, info(req)); return { ok: true }; });
  r.get<UserId>("/api/org/members/:userId/access", async (req) => access.memberAccess(me(req), org(req), req.params.userId));
  r.put<UserId>("/api/org/members/:userId/permissions", async (req) => { await access.setOverrides(me(req), org(req), req.params.userId, z.object({ overrides: z.record(z.string(), z.boolean().nullable()) }).parse(req.body).overrides, info(req)); return { ok: true }; });

  // ---------------------------------------------------------------- console de l'administrateur système
  r.get("/api/admin/users", async (req) => provisioning.adminUsers(me(req)));
  r.get("/api/admin/orgs", async (req) => provisioning.adminOrgs(me(req)));
  r.get("/api/admin/events", async (req) => provisioning.adminEvents(me(req)));
  r.get("/api/admin/settings", async (req) => { await provisioning.requireSuperAdmin(me(req)); return { registration: await provisioning.registration() }; });
  r.patch("/api/admin/settings", async (req) => { await provisioning.setRegistration(me(req), z.object({ registration: z.enum(["invite", "approval"]) }).parse(req.body).registration, info(req)); return { ok: true }; });
  r.post<Id>("/api/admin/users/:id/approve", async (req) => { const b = z.object({ org_id: z.string(), profile_id: z.string() }).parse(req.body); return provisioning.approve(me(req), req.params.id, b.org_id, b.profile_id, info(req)); });
  r.post<Id>("/api/admin/users/:id/reject", async (req) => { await provisioning.reject(me(req), req.params.id, info(req)); return { ok: true }; });
  r.post<Id>("/api/admin/users/:id/suspend", async (req) => { await provisioning.suspend(me(req), req.params.id, info(req)); return { ok: true }; });
  r.post<Id>("/api/admin/users/:id/reactivate", async (req) => { await provisioning.reactivate(me(req), req.params.id, info(req)); return { ok: true }; });
  r.post<Id>("/api/admin/users/:id/revoke-sessions", async (req) => { await provisioning.revokeSessions(me(req), req.params.id, info(req)); return { ok: true }; });
  r.post<Id>("/api/admin/users/:id/reset", async (req) => provisioning.adminReset(me(req), req.params.id, z.object({ clear_mfa: z.boolean().optional() }).parse(req.body ?? {}).clear_mfa === true, info(req)));
  r.put<Id>("/api/admin/users/:id/platform-role", async (req) => { await provisioning.setSuperAdmin(me(req), req.params.id, z.object({ super_admin: z.boolean() }).parse(req.body).super_admin, info(req)); return { ok: true }; });
}
