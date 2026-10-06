export type HostRequest =
  | { id: number; type: "authStatus" }
  | { id: number; type: "login" }
  | { id: number; type: "logout" }
  | { id: number; type: "listModels" }
  | { id: number; type: "configure"; cwd: string; model: string; storageDir: string }
  | { id: number; type: "send"; text: string }
  | { id: number; type: "cancel" }
  | { id: number; type: "reset" };

export type HostEvent =
  | { type: "ready" }
  | { type: "delta"; text: string }
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
    };

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  pending?: boolean;
}
