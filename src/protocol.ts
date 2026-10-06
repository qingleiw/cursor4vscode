export type HostRequest =
  | { id: number; type: "authStatus" }
  | { id: number; type: "login" }
  | { id: number; type: "logout" }
  | { id: number; type: "listModels" }
  // agentId and carry say how to continue the conversation when the host holds no agent for it:
  // resume that agent, or failing that tell a new one what carry says.
  | { id: number; type: "configure"; model: string; cwd?: string; agentId?: string; carry?: string }
  | { id: number; type: "send"; text: string }
  | { id: number; type: "compact" }
  | { id: number; type: "cancel" }
  | { id: number; type: "reset" };

export type ToolStatus = "running" | "completed" | "error" | "stopped";

// A tool call as the transcript shows it. The host trims it before sending,
// so file contents and long output never travel with every state update.
export interface ToolView {
  name: string;
  label: string;
  target?: string;
  path?: string;
  meta?: string;
  output?: string;
  diff?: boolean;
}

export type HostEvent =
  | { type: "ready" }
  | { type: "delta"; text: string }
  | { type: "thinking"; text: string; durationMs?: number }
  | { type: "tool"; callId: string; status: ToolStatus; view: ToolView }
  // Prompt tokens a turn sent in total, and how many model requests it took to send them.
  | { type: "usage"; promptTokens: number; requests: number }
  // Cursor summarized earlier context on its own, mid-turn.
  | { type: "summarized" }
  | { type: "status"; status: string; message?: string }
  | { type: "loginUrl"; url: string }
  | {
      id: number;
      type: "result";
      ok: boolean;
      message?: string;
      status?: string;
      email?: string;
      signedIn?: boolean;
      models?: Array<{ id: string; displayName?: string }>;
      text?: string;
      agentId?: string;
    };

export type ChatBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string; durationMs?: number; done?: boolean }
  | { type: "compact"; text: string; auto?: boolean }
  | ({ type: "tool"; callId: string; status: ToolStatus } & ToolView);

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  blocks?: ChatBlock[];
  pending?: boolean;
}
