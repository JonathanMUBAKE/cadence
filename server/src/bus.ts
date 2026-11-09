import { EventEmitter } from "node:events";

/** Événements métier émis par les services. Le temps réel (SSE) et l'IA s'y abonnent. */
export type DomainEvent =
  | { type: "task.created"; actorId: string; projectId: string; taskId: string }
  | { type: "task.updated"; actorId: string; projectId: string; taskId: string; changes: string[]; previous: Record<string, unknown> }
  | { type: "task.deleted"; actorId: string; projectId: string; taskId: string }
  | { type: "comment.created"; actorId: string; projectId: string; taskId: string; commentId: string; mentions: string[] }
  | { type: "project.changed"; actorId: string; projectId: string }
  | { type: "project.deleted"; actorId: string; projectId: string; members: string[] }
  | { type: "notification"; userId: string }
  | { type: "ai.run"; runId: string; projectId: string | null; taskId: string | null; agentId: string; status: string }
  | { type: "ai.step"; runId: string; projectId: string | null; taskId: string | null }
  | { type: "ai.delta"; runId: string; userId: string; delta: string }
  | { type: "ai.approval"; approvalId: string; runId: string; projectId: string | null; taskId: string | null };

export class Bus {
  private ee = new EventEmitter();
  constructor() {
    this.ee.setMaxListeners(1000);
  }
  emit(e: DomainEvent) {
    this.ee.emit("event", e);
  }
  on(fn: (e: DomainEvent) => void) {
    this.ee.on("event", fn);
    return () => this.ee.off("event", fn);
  }
}
