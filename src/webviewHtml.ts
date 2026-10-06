import * as vscode from "vscode";

export function chatHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "chat.js"));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "chat.css"));
  const nonce = String(Math.random()).slice(2);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>Code Agent</title>
</head>
<body>
  <header class="top">
    <div class="title">
      <strong>Code Agent</strong>
      <span id="model" class="muted"></span>
    </div>
    <div class="actions">
      <button id="modelButton" type="button" title="Select model">Model</button>
      <button id="newChat" type="button" title="New chat">New</button>
    </div>
  </header>
  <main id="transcript"></main>
  <p id="notice" class="notice" hidden></p>
  <form id="composer">
    <textarea id="input" rows="3" placeholder="Ask Code Agent…"></textarea>
    <div class="composer-row">
      <span id="account" class="muted"></span>
      <button id="submit" type="submit">Send</button>
    </div>
  </form>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
