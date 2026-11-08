import Anthropic from "@anthropic-ai/sdk";
import type { ToolDef } from "./tools.js";

export const MODEL = process.env.CADENCE_MODEL || "claude-opus-5-5";

export type TextBlock = { type: "text"; text: string };
export type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
export type ContentBlock = TextBlock | ToolUseBlock | { type: string; [k: string]: unknown };
export type ToolResultBlock = { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };
export type Msg =
  | { role: "user"; content: string | (ToolResultBlock | TextBlock)[] }
  | { role: "assistant"; content: string | ContentBlock[] };

export type AgentMode = "teammate" | "mention" | "assistant";

export interface TurnRequest {
  system: string;
  messages: Msg[];
  tools: ToolDef[];
  onText?: (delta: string) => void;
  signal?: AbortSignal;
  /** Indications utilisées uniquement par le fournisseur de démonstration. */
  hint: { mode: AgentMode; actorId: string; projectId?: string | null; taskId?: string | null; requesterId?: string | null };
}
export interface TurnResult { stop_reason: string; content: ContentBlock[] }

export interface JsonRequest { system: string; prompt: string; schema: Record<string, unknown>; hint: { kind: string; data: unknown } }

export interface AiProvider {
  name: "anthropic" | "demo";
  turn(req: TurnRequest): Promise<TurnResult>;
  json<T>(req: JsonRequest): Promise<T>;
}

export class RefusalError extends Error {}

/** Fournisseur réel : Claude via le SDK officiel. */
export class AnthropicProvider implements AiProvider {
  name = "anthropic" as const;
  private client: Anthropic;
  constructor(client?: Anthropic) {
    this.client = client ?? new Anthropic();
  }

  async turn(req: TurnRequest): Promise<TurnResult> {
    const stream = this.client.beta.messages.stream(
      {
        model: MODEL,
        max_tokens: 32000,
        system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
        tools: req.tools as never,
        messages: req.messages as never,
        output_config: { effort: "medium" },
        // Repli automatique si les garde-fous du modèle déclinent la requête.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      } as never,
      { signal: req.signal },
    );
    if (req.onText) stream.on("text", (delta: string) => req.onText!(delta));
    const msg = await stream.finalMessage();
    if (msg.stop_reason === "refusal") throw new RefusalError("Le modèle a décliné cette demande.");
    return { stop_reason: String(msg.stop_reason), content: msg.content as unknown as ContentBlock[] };
  }

  async json<T>(req: JsonRequest): Promise<T> {
    const msg = await this.client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: req.system,
      messages: [{ role: "user", content: req.prompt }],
      output_config: { effort: "low", format: { type: "json_schema", schema: req.schema } },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    } as never);
    const m = msg as unknown as { stop_reason: string; content: ContentBlock[] };
    if (m.stop_reason === "refusal") throw new RefusalError("Le modèle a décliné cette demande.");
    const text = m.content.find((b): b is TextBlock => b.type === "text")?.text ?? "";
    return JSON.parse(text) as T;
  }
}
