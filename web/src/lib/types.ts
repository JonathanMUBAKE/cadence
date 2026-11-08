export type Role = "viewer" | "commenter" | "editor" | "admin";
export type Priority = "none" | "low" | "medium" | "high" | "urgent";
export type ProjectStatus = "on_track" | "at_risk" | "off_track" | "done";

export interface User {
  id: string; name: string; email: string | null; title: string | null; avatar_color: string;
  is_ai: boolean; ai_role: string | null; ai_instructions: string | null;
}
export interface Section { id: string; project_id: string; name: string; position: number }
export interface ProjectSummary {
  id: string; name: string; description: string; color: string; icon: string; status: ProjectStatus;
  due_on: string | null; owner_id: string | null; created_at: string; role: Role;
  task_count: number; done_count: number; overdue_count: number; members: string[];
}
export interface ProjectDetail extends Omit<ProjectSummary, "task_count" | "done_count" | "overdue_count" | "members"> {
  sections: Section[]; members: { user_id: string; role: Role }[];
}
export interface Task {
  id: string; number: number; project_id: string; section_id: string | null; parent_id: string | null;
  title: string; description: string; assignee_id: string | null; creator_id: string | null; priority: Priority;
  start_on: string | null; due_on: string | null; completed: boolean; completed_at: string | null; position: number;
  tags: string[]; created_at: string; updated_at: string; subtask_count?: number; subtask_done?: number; comment_count?: number;
}
export interface Comment { id: string; task_id: string; author_id: string; body: string; ai_run_id: string | null; created_at: string }
export interface Activity { id: string; project_id: string | null; task_id: string | null; actor_id: string; kind: string; data: Record<string, unknown>; created_at: string }
export interface TaskDetail extends Task {
  role: Role;
  project: { id: string; name: string; color: string; icon: string; description: string };
  section: Section | null; parent: { id: string; number: number; title: string } | null;
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
