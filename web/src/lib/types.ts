export type Role = "viewer" | "commenter" | "editor" | "admin";
export type Priority = "none" | "low" | "medium" | "high" | "urgent";
export type ProjectStatus = "on_track" | "at_risk" | "off_track" | "done";

export interface User {
  id: string; name: string; email: string | null; title: string | null; avatar_color: string;
  is_ai: boolean; ai_role: string | null; ai_instructions: string | null;
  /** Photo de profil (lien versionné), ou null : on affiche les initiales. */
  avatar_url?: string | null;
}
export type SmtpSecurity = "none" | "starttls" | "tls";
export interface MailConfig {
  domain: string; from_name: string; notifications: boolean;
  smtp: { host: string; port: number; security: SmtpSecurity; username: string; password_set: boolean };
}
export interface ServiceAddress {
  id: string; target_type: "org" | "unit" | "team"; target_id: string; name: string; kind: string;
  parent_name: string | null; local_part: string; address: string;
}
export interface EmailLogEntry { id: string; from_address: string; to_address: string; subject: string; status: "sent" | "failed"; error: string | null; created_at: string }
export type OrgRole = "owner" | "admin" | "member" | "guest";
export interface Organization { id: string; name: string; slug: string; domains: string[]; role: OrgRole }
export interface Me extends User { org_id: string; orgs: Organization[]; permissions: string[]; platform_role: "super_admin" | null; mfa_enabled: boolean; mfa_required: boolean }
export interface PermissionGroup { group: string; items: { key: string; label: string }[] }
export type BaseRole = "owner" | "admin" | "member" | "guest";
export interface AccessProfile { id: string; name: string; description: string; base_role: BaseRole; permissions: string[]; is_system: boolean; member_count: number }
export interface MemberAccess { role: BaseRole; profile_id: string | null; overrides: Record<string, boolean>; profile_permissions: string[]; effective: string[] }
export interface Invitation { id: string; name: string; email: string; profile_id: string | null; profile_name: string | null; created_at: string }
export interface InviteResult { sent: boolean; link?: string }
export interface ReceivedInvitation { id: string; org_name: string; profile_name: string; created_at: string }
export interface SessionInfo { id: string; ip: string | null; user_agent: string | null; created_at: string; last_seen_at: string; current: boolean }
export interface AdminUser { id: string; name: string; email: string; status: "active" | "invited" | "pending" | "suspended" | "rejected"; platform_role: string | null; totp_enabled: boolean; last_login_at: string | null; access_request_note: string | null; active_sessions: number; orgs: { org_id: string; org_name: string; role: string }[] }
export interface AdminOrg { id: string; name: string; profiles: { id: string; name: string; base_role: BaseRole }[] }
export interface SecurityEvent { id: string; kind: string; ip: string | null; data: Record<string, unknown>; created_at: string; user_name: string | null; actor_name: string | null }
export interface OrgUser extends User { org_role: OrgRole; unit_id: string | null; profile_id: string | null; status: string }
export interface OrgUnit {
  id: string; org_id: string; parent_id: string | null; name: string; kind: string; manager_id: string | null;
  position: number; depth: number; member_count: number; team_count: number;
}
export type TeamVisibility = "public" | "request" | "private";
export interface Team {
  id: string; org_id: string; unit_id: string | null; name: string; description: string; visibility: TeamVisibility; color: string;
  member_count: number; project_count: number; my_role: "lead" | "member" | null; request_pending: boolean;
}
export interface TeamDetail extends Team {
  members: { user_id: string; role: "lead" | "member" }[];
  projects: ProjectSummary[];
  requests: { id: string; user_id: string; created_at: string }[];
}
export interface Section { id: string; project_id: string; name: string; position: number }
export interface ProjectSummary {
  id: string; key: string; team_id: string | null; team_name: string | null; access: "team" | "private"; name: string; description: string; color: string; icon: string; status: ProjectStatus;
  due_on: string | null; owner_id: string | null; created_at: string; role: Role;
  task_count: number; done_count: number; overdue_count: number; members: string[];
}
export interface ProjectDetail extends Omit<ProjectSummary, "task_count" | "done_count" | "overdue_count" | "members"> {
  sections: Section[]; members: { user_id: string; role: Role; source: "explicit" | "team" }[]; archived: boolean;
}
export interface Task {
  id: string; number: number; key: string; project_id: string; section_id: string | null; parent_id: string | null;
  title: string; description: string; assignee_id: string | null; creator_id: string | null; priority: Priority;
  start_on: string | null; due_on: string | null; completed: boolean; completed_at: string | null; position: number;
  tags: string[]; created_at: string; updated_at: string; subtask_count?: number; subtask_done?: number; comment_count?: number;
}
export interface Comment { id: string; task_id: string; author_id: string; body: string; ai_run_id: string | null; created_at: string; edited_at: string | null }
export interface Activity { id: string; project_id: string | null; task_id: string | null; actor_id: string; kind: string; data: Record<string, unknown>; created_at: string }
export interface Attachment { id: string; task_id: string; comment_id: string | null; uploader_id: string; filename: string; mime: string; size: number; created_at: string }
export type AttachmentPreviewData =
  | { kind: "image" | "pdf" | "none" }
  | { kind: "document" | "text"; text: string; truncated: boolean }
  | { kind: "sheets"; sheets: { name: string; rows: string[][] }[]; truncated: boolean };
export interface ImportSubtask { title: string; assignee_id: string | null; due_on: string | null }
export interface ImportTask { title: string; description: string; section: string; assignee_id: string | null; due_on: string | null; priority: Priority; completed: boolean; subtasks: ImportSubtask[] }
export interface ImportProposal { name: string; description: string; due_on: string | null; sections: string[]; tasks: ImportTask[]; notes: string[] }
export interface ImportAnalysis { filename: string; truncated: boolean; proposal: ImportProposal }
export interface TaskDetail extends Task {
  role: Role;
  attachments: Attachment[];
  project: { id: string; name: string; color: string; icon: string; description: string; key: string; org_id: string };
  section: Section | null; parent: { id: string; number: number; key: string; title: string } | null;
  subtasks: Task[]; comments: Comment[]; activity: Activity[];
}
export interface Notification {
  id: string; kind: string; title: string; body: string; task_id: string | null; project_id: string | null;
  approval_id: string | null; actor_id: string | null; read: boolean; created_at: string;
}
export interface Stats {
  total: number; done: number; overdue: number; due_this_week: number; unassigned: number;
  bySection: { id: string; name: string; open: number; done: number }[];
  byPriority: { priority: Priority; open: number }[];
  byAssignee: { user_id: string | null; open: number; done: number; overdue: number }[];
  burnup: { day: string; done: number; total: number }[];
}
export type RunStatus = "queued" | "running" | "waiting_approval" | "done" | "failed" | "cancelled";
export interface AiRun {
  id: string; agent_id: string; kind: "task" | "mention" | "rule" | "assistant"; task_id: string | null; project_id: string | null;
  requested_by: string | null; rule_id: string | null; status: RunStatus; summary: string | null; error: string | null;
  provider: string; created_at: string; finished_at: string | null; step_count?: number; pending_approvals?: number;
}
export interface AiStep { id: string; run_id: string; seq: number; kind: string; tool: string | null; input: Record<string, unknown> | null; output: unknown; status: string; created_at: string }
export interface AiApproval {
  id: string; run_id: string; agent_id: string; task_id: string | null; project_id: string | null; tool: string;
  input: Record<string, unknown>; summary: string; status: "pending" | "approved" | "rejected" | "expired";
  decided_by: string | null; decided_at: string | null; created_at: string;
}
export interface AiRunDetail extends AiRun { steps: AiStep[]; approvals: AiApproval[] }
export interface AiRule {
  id: string; project_id: string; name: string; trigger: "task_created" | "task_moved" | "task_overdue"; section_id: string | null;
  agent_id: string; instructions: string; auto_approve: boolean; enabled: boolean; created_by: string | null; created_at: string;
}
export interface StatusProposal { status: "on_track" | "at_risk" | "off_track"; headline: string; summary: string; risks: string[]; next_steps: string[] }
export interface ParsedTask { title: string; description: string; assignee_id: string | null; due_on: string | null; priority: Priority; section_id: string | null }
