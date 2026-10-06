import * as vscode from "vscode";
import type { ChatMessage } from "./protocol";

export interface SavedSession {
  id: string;
  title: string;
  updated: number;
  messages: ChatMessage[];
  // What it takes to continue the conversation: the SDK agent that holds it, or failing that
  // a summary to tell a fresh one, and the folder the agent belongs to.
  agentId?: string;
  carry?: string;
  cwd?: string;
}

export class SessionsView implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly change = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.change.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  refresh(): void {
    this.change.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.TreeItem[] {
    return this.list().map((session) => {
      const item = new vscode.TreeItem(session.title, vscode.TreeItemCollapsibleState.None);
      item.description = new Date(session.updated).toLocaleString();
      item.command = {
        command: "cursor4vscode.openSession",
        title: "Open Session",
        arguments: [session.id],
      };
      return item;
    });
  }

  list(): SavedSession[] {
    return this.context.globalState.get<SavedSession[]>("cursor4vscode.sessions", []);
  }

  dispose(): void {
    this.change.dispose();
  }
}
