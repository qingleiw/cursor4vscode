import * as vscode from "vscode";
import { ChatSession } from "./session";
import { SessionsView } from "./sessionsView";

let session: ChatSession | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const sessions = new SessionsView(context);
  session = new ChatSession(context, () => sessions.refresh());
  context.subscriptions.push(session, sessions);
  void openOnTheRight();

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.text = "$(sparkle) Cursor";
  status.tooltip = "Open Cursor chat";
  status.command = "workbench.view.extension.cursor4vscode-side";
  status.show();
  context.subscriptions.push(status);

  context.subscriptions.push(
    vscode.commands.registerCommand("cursor4vscode.newChat", () => session?.newChat()),
    vscode.commands.registerCommand("cursor4vscode.openInEditor", () => session?.openInEditor()),
    vscode.commands.registerCommand("cursor4vscode.signIn", () => session?.signIn()),
    vscode.commands.registerCommand("cursor4vscode.signOut", () => session?.signOut()),
    vscode.commands.registerCommand("cursor4vscode.selectModel", () => session?.selectModel()),
    vscode.commands.registerCommand("cursor4vscode.compact", () => session?.compact()),
    vscode.commands.registerCommand("cursor4vscode.installSdk", () => session?.installSdk()),
    vscode.commands.registerCommand("cursor4vscode.openSession", (id: string) => session?.openSaved(id))
  );
}

export function deactivate(): void {
  session?.dispose();
  session = undefined;
}

async function openOnTheRight(): Promise<void> {
  await vscode.commands.executeCommand("workbench.action.focusAuxiliaryBar");
  await vscode.commands.executeCommand("workbench.view.extension.cursor4vscode-side");
}
