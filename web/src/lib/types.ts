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
export interface Me extends User { org_id: string; orgs: Organization[] }
export interface OrgUser extends User { org_role: OrgRole; unit_id: string | null }
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
export interface TaskDetail extends Task {
  role: Role;
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
export type Level = "high" | "medium" | "low";
export interface Finding { severity: Level | "positive"; code: string; message: string }
export interface TaskRef { key: string; title: string; assignee: string | null; priority: Priority; due_on: string | null; days: number }
export interface WorkloadEntry { user_id: string | null; name: string; is_ai: boolean; open: number; overdue: number; high_priority_open: number; completed_in_period: number }
interface MetricsBase {
  period: { from: string; to: string; days: number };
  totals: {
    total: number; open: number; done: number; completion_rate: number; completed_in_period: number; created_in_period: number; previous_completed: number; velocity_per_week: number;
    overdue: number; avg_days_late: number | null; max_days_late: number | null; due_next_7_days: number; unassigned_open: number; no_due_open: number; stale: number;
    on_time_rate: number | null; on_time_sample: number; cycle_median_days: number | null; cycle_p85_days: number | null; cycle_sample: number;
  };
  weekly: { from: string; to: string; completed: number; created: number }[];
  workload: WorkloadEntry[]; overdue_tasks: TaskRef[]; stale_tasks: TaskRef[]; findings: Finding[];
}
export interface ProjectMetrics extends MetricsBase {
  scope: "project"; project: { id: string; key: string; name: string; status: ProjectStatus; due_on: string | null };
  sections: { section: string; open: number; overdue: number; avg_age_days: number | null }[];
  forecast: { remaining: number; projected_end: string | null; due_on: string | null; margin_days: number | null; confidence: "low" | "medium" | "high" };
}
export interface PortfolioMetrics extends MetricsBase {
  scope: "portfolio"; excluded_projects: number;
  projects: { project_id: string; key: string; name: string; status: ProjectStatus; due_on: string | null; open: number; done: number; overdue: number; completed_in_period: number; velocity_per_week: number; margin_days: number | null; health: "good" | "watch" | "critical" }[];
}
export type ReportMetrics = ProjectMetrics | PortfolioMetrics;
export interface ReportContent {
  title: string; status: "on_track" | "at_risk" | "off_track"; executive_summary: string; focus_answer: string | null; highlights: string[];
  risks: { title: string; severity: Level; evidence: string; recommendation: string }[];
  team_analysis: string; recommendations: { action: string; owner: string | null; priority: Level }[]; next_period_focus: string[];
}
export interface ReportSummary {
  id: string; project_id: string | null; scope: "project" | "portfolio"; agent_id: string; created_by: string; period_days: number; focus: string;
  status: "generating" | "ready" | "failed"; provider: string; error: string | null; created_at: string; finished_at: string | null; title: string | null; health: "on_track" | "at_risk" | "off_track" | null;
}
export interface Report extends Omit<ReportSummary, "title" | "health"> { metrics: ReportMetrics; content: ReportContent | null }
export interface StatusProposal { status: "on_track" | "at_risk" | "off_track"; headline: string; summary: string; risks: string[]; next_steps: string[] }
export interface ParsedTask { title: string; description: string; assignee_id: string | null; due_on: string | null; priority: Priority; section_id: string | null }
