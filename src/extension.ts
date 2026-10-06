import * as vscode from "vscode";
import { ChatSession } from "./session";

let session: ChatSession | undefined;

export function activate(context: vscode.ExtensionContext): void {
  session = new ChatSession(context);
  context.subscriptions.push(session);

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.text = "$(sparkle) Code Agent";
  status.tooltip = "Open Code Agent chat";
  status.command = "codeAgent.chat.focus";
  status.show();
  context.subscriptions.push(status);

  context.subscriptions.push(
    vscode.commands.registerCommand("codeAgent.newChat", () => session?.newChat()),
    vscode.commands.registerCommand("codeAgent.openInEditor", () => session?.openInEditor()),
    vscode.commands.registerCommand("codeAgent.signIn", () => session?.signIn()),
    vscode.commands.registerCommand("codeAgent.signOut", () => session?.signOut()),
    vscode.commands.registerCommand("codeAgent.selectModel", () => session?.selectModel())
  );
}

export function deactivate(): void {
  session?.dispose();
  session = undefined;
}
