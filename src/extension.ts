import * as vscode from "vscode";
import { ChatSession } from "./session";

let session: ChatSession | undefined;

export function activate(context: vscode.ExtensionContext): void {
  session = new ChatSession(context);
  context.subscriptions.push(session);

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.text = "$(sparkle) cursor4vscode";
  status.tooltip = "Open cursor4vscode chat";
  status.command = "cursor4vscode.chat.focus";
  status.show();
  context.subscriptions.push(status);

  context.subscriptions.push(
    vscode.commands.registerCommand("cursor4vscode.newChat", () => session?.newChat()),
    vscode.commands.registerCommand("cursor4vscode.openInEditor", () => session?.openInEditor()),
    vscode.commands.registerCommand("cursor4vscode.signIn", () => session?.signIn()),
    vscode.commands.registerCommand("cursor4vscode.signOut", () => session?.signOut()),
    vscode.commands.registerCommand("cursor4vscode.selectModel", () => session?.selectModel())
  );
}

export function deactivate(): void {
  session?.dispose();
  session = undefined;
}
