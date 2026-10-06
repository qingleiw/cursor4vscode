import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { AgentProcess } from "./agentProcess";
import type { ChatMessage } from "./protocol";
import { chatHtml } from "./webviewHtml";

interface Surface {
  webview: vscode.Webview;
  reveal?: () => void;
}

export class ChatSession implements vscode.Disposable {
  private readonly process: AgentProcess;
  private readonly surfaces = new Set<Surface>();
  private messages: ChatMessage[] = [];
  private busy = false;
  private account: string | undefined;
  private notice: string | undefined;
  private readonly viewProvider: vscode.WebviewViewProvider;

  constructor(private readonly context: vscode.ExtensionContext) {
    const output = vscode.window.createOutputChannel("Code Agent");
    this.process = new AgentProcess(context.extensionUri.fsPath, output);
    this.process.onDelta = (text) => this.appendDelta(text);
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
      vscode.window.registerWebviewViewProvider("codeAgent.chat", this.viewProvider, {
        webviewOptions: { retainContextWhenHidden: true },
      })
    );
    void this.refreshAccount();
  }

  focus(): void {
    void vscode.commands.executeCommand("codeAgent.chat.focus");
  }

  openInEditor(): void {
    const panel = vscode.window.createWebviewPanel(
      "codeAgent.chatPanel",
      "Code Agent",
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [this.context.extensionUri] }
    );
    this.prepare(panel.webview);
    const surface: Surface = { webview: panel.webview, reveal: () => panel.reveal(undefined, true) };
    this.surfaces.add(surface);
    panel.onDidDispose(() => this.surfaces.delete(surface));
    this.postState(panel.webview);
  }

  async newChat(): Promise<void> {
    if (this.busy) {
      await this.cancel();
    }
    this.messages = [];
    this.notice = undefined;
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
      await vscode.workspace.getConfiguration("codeAgent").update("model", picked.description, vscode.ConfigurationTarget.Global);
      await this.process.request("reset");
    });
  }

  async send(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || this.busy) {
      return;
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      this.notice = "Open a folder before chatting. The agent runs against the current workspace.";
      this.broadcast();
      return;
    }
    this.notice = undefined;
    this.messages.push({ role: "user", text: trimmed });
    this.messages.push({ role: "assistant", text: "", pending: true });
    this.busy = true;
    this.broadcast();
    try {
      const storageDir = path.join(this.context.globalStorageUri.fsPath, "agents");
      await fs.promises.mkdir(storageDir, { recursive: true });
      await this.process.request("configure", {
        cwd: folder.uri.fsPath,
        model: this.modelId(),
        storageDir,
      });
      const result = await this.process.request("send", { text: trimmed });
      const assistant = this.messages.at(-1);
      if (assistant?.role === "assistant") {
        assistant.pending = false;
        if (!assistant.text && result.text) {
          assistant.text = result.text;
        }
      }
      if (result.status === "error") {
        this.notice = result.message || "The reply failed.";
      }
    } catch (error) {
      const assistant = this.messages.at(-1);
      if (assistant?.role === "assistant") {
        assistant.pending = false;
      }
      this.notice = error instanceof Error ? error.message : String(error);
    } finally {
      this.busy = false;
      this.broadcast();
    }
  }

  async cancel(): Promise<void> {
    try {
      await this.process.request("cancel");
    } catch (error) {
      this.notice = error instanceof Error ? error.message : String(error);
    } finally {
      const assistant = this.messages.at(-1);
      if (assistant?.pending) {
        assistant.pending = false;
      }
      this.busy = false;
      this.broadcast();
    }
  }

  dispose(): void {
    this.process.dispose();
    this.surfaces.clear();
  }

  private prepare(webview: vscode.Webview): void {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };
    webview.html = chatHtml(webview, this.context.extensionUri);
    webview.onDidReceiveMessage((message: { type?: string; text?: string }) => {
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
      } else if (message.type === "pickModel") {
        void this.selectModel();
      }
    });
  }

  private appendDelta(text: string): void {
    const assistant = this.messages.at(-1);
    if (assistant?.role === "assistant") {
      assistant.text += text;
      this.broadcast();
    }
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
      this.notice = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(this.notice);
    } finally {
      this.broadcast();
    }
  }

  private modelId(): string {
    return vscode.workspace.getConfiguration("codeAgent").get<string>("model") || "composer-2.5";
  }

  private broadcast(): void {
    for (const surface of this.surfaces) {
      this.postState(surface.webview);
    }
  }

  private postState(webview: vscode.Webview): void {
    void webview.postMessage({
      type: "state",
      messages: this.messages,
      busy: this.busy,
      model: this.modelId(),
      account: this.account ?? "",
      notice: this.notice ?? "",
    });
  }
}
