import * as vscode from "vscode";
import { AgentProcess } from "./agentProcess";
import type { ChatBlock, ChatMessage, ToolStatus, ToolView } from "./protocol";
import { installSdk, SDK_MISSING } from "./sdk";
import type { SavedSession } from "./sessionsView";
import { chatHtml } from "./webviewHtml";

interface Surface {
  webview: vscode.Webview;
  reveal?: () => void;
}

export class ChatSession implements vscode.Disposable {
  private readonly process: AgentProcess;
  private readonly output: vscode.OutputChannel;
  // Whether the Cursor SDK, which the extension does not ship, is on this machine.
  private sdk: "missing" | "installing" | "ready";
  private readonly surfaces = new Set<Surface>();
  private messages: ChatMessage[] = [];
  private busy = false;
  private account: string | undefined;
  private notice: string | undefined;
  private activity = "";
  private target = "";
  // Estimated size of the conversation as last sent to the model, in tokens. 0 when unknown.
  private contextTokens = 0;
  // The SDK agent that holds this conversation, once a message has been answered.
  private agentId: string | undefined;
  // Summary a compact left for the next agent; cleared once a message has delivered it.
  private carry = "";
  private sessionId: string = crypto.randomUUID();
  private broadcastTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly viewProvider: vscode.WebviewViewProvider;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly onSessionsChanged: () => void
  ) {
    const output = vscode.window.createOutputChannel("cursor4vscode");
    this.output = output;
    this.process = new AgentProcess(context.extensionUri.fsPath, context.globalStorageUri.fsPath, output);
    this.sdk = this.process.sdkFolder() ? "ready" : "missing";
    this.process.onDelta = (text) => {
      this.activity = "";
      this.appendDelta(text);
    };
    this.process.onThinking = (text, durationMs) => {
      this.activity = "";
      this.appendThinking(text, durationMs);
    };
    this.process.onTool = (callId, status, view) => {
      this.activity = "";
      this.updateTool(callId, status, view);
    };
    this.process.onUsage = (promptTokens, requests) => {
      if (!this.replying()) {
        return;
      }
      // The SDK reports a turn's prompt tokens in total, not the size of the context. Each request in a
      // turn is larger than the one before, starting near where the last turn ended, so the turn ends
      // near twice its average minus that start.
      const average = promptTokens / Math.max(requests, 1);
      const start = this.contextTokens || average;
      this.contextTokens = Math.round(requests > 1 ? Math.max(average, 2 * average - start) : average);
      this.scheduleBroadcast();
    };
    this.process.onSummarized = () => {
      const assistant = this.replying();
      if (!assistant) {
        return;
      }
      const blocks = (assistant.blocks ??= []);
      closeThinking(blocks);
      blocks.push({ type: "compact", text: "", auto: true });
      this.contextTokens = 0;
      this.scheduleBroadcast();
    };
    this.process.onStatus = (status, message) => {
      if (!this.busy) {
        return;
      }
      this.activity = message || statusLabel(status);
      this.broadcast();
    };
    this.process.onLoginUrl = (url) => {
      void vscode.env.openExternal(vscode.Uri.parse(url));
    };
    context.subscriptions.push(output);

    this.viewProvider = {
      resolveWebviewView: (view) => {
        this.prepare(view.webview);
        const surface: Surface = {
          webview: view.webview,
          reveal: () => view.show?.(true),
        };
        this.surfaces.add(surface);
        view.onDidDispose(() => this.surfaces.delete(surface));
        this.postState(view.webview);
      },
    };
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider("cursor4vscode.sideChat", this.viewProvider, {
        webviewOptions: { retainContextWhenHidden: true },
      })
    );
    if (this.sdk === "ready") {
      void this.refreshAccount();
    }
  }

  // Downloads the Cursor SDK to this machine, or brings it up to date.
  async installSdk(): Promise<void> {
    if (this.sdk === "installing" || this.busy) {
      return;
    }
    this.sdk = "installing";
    this.notice = undefined;
    this.broadcast();
    try {
      await installSdk(this.context.globalStorageUri.fsPath, this.output);
      // A host that is already running has the old copy loaded; the next request starts a new one.
      this.process.dispose();
      this.sdk = "ready";
      await this.refreshAccount();
    } catch (error) {
      this.sdk = this.process.sdkFolder() ? "ready" : "missing";
      this.notice = friendly(error instanceof Error ? error.message : String(error));
    } finally {
      this.broadcast();
    }
  }

  focus(): void {
    void vscode.commands.executeCommand("workbench.view.extension.cursor4vscode-side");
  }

  openInEditor(): void {
    const panel = vscode.window.createWebviewPanel(
      "cursor4vscode.sideChat",
      "Cursor",
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [this.context.extensionUri] }
    );
    this.prepare(panel.webview, panel);
    const surface: Surface = { webview: panel.webview, reveal: () => panel.reveal(undefined, true) };
    this.surfaces.add(surface);
    panel.onDidDispose(() => this.surfaces.delete(surface));
    this.postState(panel.webview);
  }

  async newChat(): Promise<void> {
    if (this.busy) {
      await this.cancel();
    }
    await this.persist();
    this.sessionId = crypto.randomUUID();
    this.messages = [];
    this.agentId = undefined;
    this.carry = "";
    this.notice = undefined;
    this.activity = "";
    this.contextTokens = 0;
    this.onSessionsChanged();
    try {
      await this.process.request("reset");
    } catch {
      // The host resets itself the next time a message is sent.
    }
    this.broadcast();
  }

  async signIn(): Promise<void> {
    await this.withNotice(async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Signing in to Cursor…" },
        async () => {
          const result = await this.process.request("login");
          this.account = result.email || "Signed in";
        }
      );
    });
  }

  async signOut(): Promise<void> {
    await this.withNotice(async () => {
      await this.process.request("logout");
      this.account = undefined;
      this.messages = [];
      this.agentId = undefined;
      this.carry = "";
      this.contextTokens = 0;
    });
  }

  async selectModel(): Promise<void> {
    await this.withNotice(async () => {
      const result = await this.process.request("listModels");
      const models = result.models ?? [];
      if (models.length === 0) {
        throw new Error("No Cursor models are available for this account.");
      }
      const current = this.modelId();
      const picked = await vscode.window.showQuickPick(
        models.map((model) => ({
          label: model.displayName || model.id,
          description: model.id,
          picked: model.id === current,
        })),
        { placeHolder: "Select a Cursor model" }
      );
      if (!picked?.description) {
        return;
      }
      await this.setModel(picked.description);
    });
  }

  // The host passes the model with the next message, so switching keeps the conversation.
  private async setModel(id: string): Promise<void> {
    await vscode.workspace.getConfiguration("cursor4vscode").update("model", id, vscode.ConfigurationTarget.Global);
    this.broadcast();
  }

  private async sendModels(webview: vscode.Webview): Promise<void> {
    let models: Array<{ id: string; displayName?: string }> = [];
    await this.withNotice(async () => {
      models = (await this.process.request("listModels")).models ?? [];
    });
    void webview.postMessage({ type: "models", models, current: this.modelId() });
  }

  // Replaces what the agent remembers with a summary of it. The transcript stays as it is.
  async compact(): Promise<void> {
    if (this.busy || this.messages.length === 0) {
      return;
    }
    const session = this.sessionId;
    const continuation = this.continuation();
    const marker: ChatMessage = { role: "assistant", text: "", blocks: [], pending: true };
    this.notice = undefined;
    this.activity = "Compacting the conversation…";
    this.messages.push(marker);
    this.busy = true;
    this.broadcast();
    try {
      await this.process.request("configure", continuation);
      const result = await this.process.request("compact");
      if (session !== this.sessionId) {
        return;
      }
      settle(marker);
      marker.blocks = [{ type: "compact", text: result.text ?? "" }];
      this.agentId = undefined;
      this.carry = result.text ?? "";
      this.contextTokens = 0;
    } catch (error) {
      if (session === this.sessionId) {
        this.messages = this.messages.filter((message) => message !== marker);
        this.notice = friendly(error instanceof Error ? error.message : String(error));
      }
    } finally {
      // Another conversation may have been opened meanwhile; its state is not this one's to settle.
      if (session === this.sessionId) {
        this.busy = false;
        this.activity = "";
        await this.persist();
        this.broadcast();
      }
    }
  }

  // What the host needs to carry this conversation on if it holds no agent for it: the agent to
  // resume, and what to tell a new one when that agent is gone.
  private continuation(): { model: string; cwd?: string; agentId?: string; carry: string } {
    return {
      model: this.modelId(),
      cwd: this.folderPath(),
      agentId: this.agentId,
      carry: this.carry || recap(this.messages),
    };
  }

  private folderPath(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  async send(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || this.busy) {
      return;
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      this.notice = "Open a folder, then send a message.";
      this.broadcast();
      return;
    }
    if (this.sdk !== "ready") {
      this.notice = SDK_MISSING;
      this.broadcast();
      return;
    }
    if (!this.account) {
      this.notice = "Sign in to Cursor, then send the message again.";
      this.broadcast();
      return;
    }
    const session = this.sessionId;
    // Taken before the new message joins the transcript, so the recap does not repeat it.
    const continuation = this.continuation();
    this.target = folder.name;
    this.notice = undefined;
    this.activity = "Starting the agent…";
    this.messages.push({ role: "user", text: trimmed });
    this.messages.push({ role: "assistant", text: "", blocks: [], pending: true });
    this.busy = true;
    this.broadcast();
    try {
      await this.process.request("configure", continuation);
      const result = await this.process.request("send", { text: trimmed });
      if (session !== this.sessionId) {
        return;
      }
      this.agentId = result.agentId ?? this.agentId;
      this.carry = "";
      const assistant = this.messages.at(-1);
      if (assistant?.role === "assistant") {
        settle(assistant);
        if (!assistant.text && result.text) {
          assistant.text = result.text;
          (assistant.blocks ??= []).push({ type: "text", text: result.text });
        }
      }
      if (result.status === "error") {
        this.notice = friendly(result.message || "The reply failed.");
      }
    } catch (error) {
      if (session === this.sessionId) {
        const assistant = this.messages.at(-1);
        if (assistant?.role === "assistant") {
          settle(assistant);
        }
        this.notice = friendly(error instanceof Error ? error.message : String(error));
      }
    } finally {
      // Another conversation may have been opened meanwhile; its state is not this one's to settle.
      if (session === this.sessionId) {
        this.busy = false;
        this.activity = "";
        await this.persist();
        this.broadcast();
      }
    }
  }

  async openSaved(id: string): Promise<void> {
    const found = this.savedSessions().find((session) => session.id === id);
    if (!found || found.id === this.sessionId) {
      return;
    }
    if (this.busy) {
      await this.cancel();
    }
    await this.persist();
    this.sessionId = found.id;
    this.messages = found.messages.map((message) => ({
      role: message.role,
      text: message.text,
      blocks: message.blocks?.map((block) => ({ ...block })),
    }));
    this.agentId = found.agentId;
    this.carry = found.carry ?? "";
    this.notice = undefined;
    this.activity = "";
    this.contextTokens = 0;
    this.broadcast();
    try {
      // Lets go of the agent of the conversation being left. This one's is resumed by its next message.
      await this.process.request("reset");
    } catch {
      // A host that is gone holds no agent either.
    }
    await vscode.commands.executeCommand("workbench.view.extension.cursor4vscode-side");
  }

  private sendSessions(webview: vscode.Webview): void {
    const cwd = this.folderPath();
    // An agent belongs to the folder it worked in, so only this folder's conversations can be carried on here.
    const sessions = this.savedSessions()
      .filter((session) => !session.cwd || session.cwd === cwd)
      .map(({ id, title, updated }) => ({ id, title, updated }));
    void webview.postMessage({ type: "sessions", sessions, current: this.sessionId });
  }

  async cancel(): Promise<void> {
    try {
      await this.process.request("cancel");
    } catch (error) {
      this.notice = friendly(error instanceof Error ? error.message : String(error));
    } finally {
      const assistant = this.messages.at(-1);
      if (assistant?.pending) {
        settle(assistant);
      }
      this.busy = false;
      this.activity = "";
      this.broadcast();
    }
  }

  dispose(): void {
    clearTimeout(this.broadcastTimer);
    this.process.dispose();
    this.surfaces.clear();
  }

  private prepare(webview: vscode.Webview, panel?: vscode.WebviewPanel): void {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };
    webview.html = chatHtml(webview, this.context.extensionUri);
    webview.onDidReceiveMessage((message: { type?: string; text?: string; path?: string; model?: string; id?: string }) => {
      if (message.type === "ready") {
        this.postState(webview);
      } else if (message.type === "send" && message.text) {
        void this.send(message.text);
      } else if (message.type === "cancel") {
        void this.cancel();
      } else if (message.type === "newChat") {
        void this.newChat();
      } else if (message.type === "signIn") {
        void this.signIn();
      } else if (message.type === "listModels") {
        void this.sendModels(webview);
      } else if (message.type === "setModel" && message.model) {
        void this.setModel(message.model);
      } else if (message.type === "compact") {
        void this.compact();
      } else if (message.type === "installSdk") {
        void this.installSdk();
      } else if (message.type === "listSessions") {
        this.sendSessions(webview);
      } else if (message.type === "openSession" && message.id) {
        void this.openSaved(message.id);
      } else if (message.type === "openFile" && message.path) {
        void this.openFile(message.path, panel);
      }
    });
  }

  private async openFile(file: string, panel?: vscode.WebviewPanel): Promise<void> {
    // From a chat that is itself an editor tab, open the file in another column.
    const column = panel
      ? panel.viewColumn === vscode.ViewColumn.One
        ? vscode.ViewColumn.Two
        : vscode.ViewColumn.One
      : undefined;
    try {
      await vscode.window.showTextDocument(vscode.Uri.file(file), { viewColumn: column, preview: true });
    } catch {
      void vscode.window.showWarningMessage(`Could not open ${file}.`);
    }
  }

  // The reply being written. Nothing when idle: events of a reply that was stopped, or left for
  // another conversation, can still arrive and belong to no message here.
  private replying(): ChatMessage | undefined {
    const last = this.messages.at(-1);
    return this.busy && last?.role === "assistant" ? last : undefined;
  }

  private appendDelta(text: string): void {
    const assistant = this.replying();
    if (assistant) {
      assistant.text += text;
      const blocks = (assistant.blocks ??= []);
      const last = blocks.at(-1);
      if (last?.type === "text") {
        last.text += text;
      } else {
        closeThinking(blocks);
        blocks.push({ type: "text", text });
      }
      this.scheduleBroadcast();
    }
  }

  // The SDK sends thinking as deltas, then an empty one carrying the duration.
  private appendThinking(text: string, durationMs?: number): void {
    const assistant = this.replying();
    if (!assistant) {
      return;
    }
    const blocks = (assistant.blocks ??= []);
    const last = blocks.at(-1);
    const open = last?.type === "thinking" && !last.done ? last : undefined;
    if (!text) {
      if (open) {
        open.done = true;
        open.durationMs = durationMs;
      }
    } else if (open) {
      open.text += text;
    } else {
      blocks.push({ type: "thinking", text });
    }
    this.scheduleBroadcast();
  }

  private updateTool(callId: string, status: ToolStatus, view: ToolView): void {
    const assistant = this.replying();
    if (!assistant) {
      return;
    }
    const blocks = (assistant.blocks ??= []);
    const existing = blocks.find((block): block is ToolBlock => block.type === "tool" && block.callId === callId);
    if (existing) {
      // Later updates can omit what an earlier one carried, so merge.
      Object.assign(existing, view, { status });
    } else {
      closeThinking(blocks);
      blocks.push({ type: "tool", callId, status, ...view });
    }
    this.scheduleBroadcast();
  }

  private async refreshAccount(): Promise<void> {
    try {
      const result = await this.process.request("authStatus");
      this.account = result.signedIn ? result.email || "Signed in" : undefined;
      this.broadcast();
    } catch {
      // The host starts when the chat is opened.
    }
  }

  private async withNotice(action: () => Promise<void>): Promise<void> {
    try {
      this.notice = undefined;
      await action();
    } catch (error) {
      this.notice = friendly(error instanceof Error ? error.message : String(error));
      void vscode.window.showErrorMessage(this.notice);
    } finally {
      this.broadcast();
    }
  }

  private savedSessions(): SavedSession[] {
    return this.context.globalState.get<SavedSession[]>("cursor4vscode.sessions", []);
  }

  private async persist(): Promise<void> {
    const messages = this.messages
      .filter((message) => message.text.trim() || message.blocks?.length)
      .map((message) => ({ role: message.role, text: message.text, blocks: message.blocks?.map(slim) }));
    if (messages.length === 0) {
      return;
    }
    const next: SavedSession[] = [
      {
        id: this.sessionId,
        title: this.title(),
        updated: Date.now(),
        messages,
        agentId: this.agentId,
        carry: this.carry || undefined,
        cwd: this.folderPath(),
      },
      ...this.savedSessions().filter((session) => session.id !== this.sessionId),
    ].slice(0, 30);
    await this.context.globalState.update("cursor4vscode.sessions", next);
    this.onSessionsChanged();
  }

  private modelId(): string {
    return vscode.workspace.getConfiguration("cursor4vscode").get<string>("model") || "composer-2.5";
  }

  // The SDK does not report a model's window, so the indicator measures against a setting.
  private contextWindow(): number {
    return vscode.workspace.getConfiguration("cursor4vscode").get<number>("contextWindow") || 200000;
  }

  private title(): string {
    const first = this.messages.find((message) => message.role === "user")?.text.split("\n")[0] ?? "";
    return first.slice(0, 80) || "New chat";
  }

  // Streaming events arrive faster than the webview needs to repaint.
  private scheduleBroadcast(): void {
    this.broadcastTimer ??= setTimeout(() => this.broadcast(), 50);
  }

  private broadcast(): void {
    clearTimeout(this.broadcastTimer);
    this.broadcastTimer = undefined;
    for (const surface of this.surfaces) {
      this.postState(surface.webview);
    }
  }

  private postState(webview: vscode.Webview): void {
    void webview.postMessage({
      type: "state",
      session: this.sessionId,
      sdk: this.sdk,
      title: this.title(),
      messages: this.messages,
      busy: this.busy,
      model: this.modelId(),
      account: this.account ?? "",
      notice: this.notice ?? "",
      activity: this.activity,
      target: this.target || vscode.workspace.workspaceFolders?.[0]?.name || "",
      context: { tokens: this.contextTokens, window: this.contextWindow() },
    });
  }
}

type ToolBlock = Extract<ChatBlock, { type: "tool" }>;

function closeThinking(blocks: ChatBlock[]): void {
  const last = blocks.at(-1);
  if (last?.type === "thinking") {
    last.done = true;
  }
}

// A reply that ends, fails or is stopped leaves nothing spinning.
function settle(message: ChatMessage): void {
  message.pending = false;
  for (const block of message.blocks ?? []) {
    if (block.type === "thinking") {
      block.done = true;
    } else if (block.type === "tool" && block.status === "running") {
      block.status = "stopped";
    }
  }
}

const RECAP_LIMIT = 12000;

// What a new agent is told about a conversation whose own agent can no longer be resumed: the
// last compact summary, if there was one, and what was said since. Long transcripts keep their end.
function recap(messages: ChatMessage[]): string {
  let summary = "";
  let since = 0;
  messages.forEach((message, index) => {
    const compacted = message.blocks?.find((block) => block.type === "compact" && !block.auto && block.text);
    if (compacted?.type === "compact") {
      summary = compacted.text;
      since = index + 1;
    }
  });
  const said = messages
    .slice(since)
    .filter((message) => message.text.trim())
    .map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.text.trim()}`);
  const parts = summary ? [`Summary of the conversation before this point:\n${summary}`, ...said] : said;
  const text = parts.join("\n\n");
  return text.length > RECAP_LIMIT ? `…\n${text.slice(-RECAP_LIMIT)}` : text;
}

// Saved sessions keep what the agent did, not the output of every step.
function slim(block: ChatBlock): ChatBlock {
  if (block.type === "tool") {
    const { output, diff, ...rest } = block;
    return rest;
  }
  if (block.type === "thinking") {
    return { ...block, text: "" };
  }
  return block;
}

function statusLabel(status: string): string {
  switch (status) {
    case "CREATING":
      return "Starting the agent…";
    case "RUNNING":
      return "Working…";
    case "FINISHED":
      return "";
    case "CANCELLED":
      return "Stopped.";
    case "ERROR":
      return "The agent failed.";
    default:
      return status;
  }
}

function friendly(message: string): string {
  if (/API key is required/i.test(message)) {
    return "Sign in to Cursor, then send the message again.";
  }
  return message;
}
