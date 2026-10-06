import * as vscode from "vscode";

const LOGO = `<svg class="logo" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2.1 13.7 8.3 20 10l-6.3 1.7L12 17.9 10.3 11.7 4 10l6.3-1.7L12 2.1z"/>
      <path d="M18.1 14.2 18.8 16.6 21.2 17.3 18.8 18 18.1 20.4 17.4 18 15 17.3 17.4 16.6 18.1 14.2z"/>
    </svg>`;

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
  <title>Cursor</title>
</head>
<body>
  <header class="top">
    <button id="history" type="button" class="title" title="Past conversations">
      <span id="title">New chat</span>
      <svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>
    </button>
    <span class="grow"></span>
    <button id="newChat" type="button" class="ghost" title="New chat">
      <svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>
    </button>
  </header>
  <main id="transcript" hidden></main>
  <section id="welcome" class="welcome" hidden>
    ${LOGO}
    <h2>What should we work on?</h2>
    <p>The agent reads, edits and runs things in <strong id="folder">this folder</strong>.</p>
    <div class="suggestions">
      <button type="button" class="suggestion">Explain how this project is organized</button>
      <button type="button" class="suggestion">Find likely bugs and propose fixes</button>
      <button type="button" class="suggestion">Add tests for the code that has none</button>
    </div>
    <span id="account" class="muted"></span>
  </section>
  <section id="gate" class="welcome" hidden>
    ${LOGO}
    <h2>Sign in to get started</h2>
    <p>Use your Cursor account to run the agent in this folder.</p>
    <button id="signIn" type="button" class="primary">Sign in</button>
  </section>
  <p id="notice" class="notice" hidden></p>
  <div id="hint" class="hint" hidden>
    <span id="hintText"></span>
    <button id="hintCompact" type="button" class="link">Compact</button>
  </div>
  <form id="composer">
    <div id="menu" class="menu" hidden></div>
    <div class="input-box">
      <textarea id="input" rows="1" placeholder="Ask Cursor to do something, or type / for commands"></textarea>
      <div class="input-row">
        <button id="modelButton" type="button" class="ghost chip" title="Switch model">
          <span id="model"></span>
          <svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>
        </button>
        <span class="grow"></span>
        <button id="context" type="button" class="ghost context" hidden>
          <svg class="ring" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="8" cy="8" r="6"/>
            <circle id="contextRing" cx="8" cy="8" r="6" transform="rotate(-90 8 8)"/>
          </svg>
          <span id="contextText"></span>
        </button>
        <button id="submit" type="submit" class="send" title="Send">
          <svg class="icon icon-send" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3.5M3.5 8 8 3.5 12.5 8"/></svg>
          <svg class="icon icon-stop" viewBox="0 0 16 16" aria-hidden="true"><rect x="4.5" y="4.5" width="7" height="7" rx="1.5"/></svg>
        </button>
      </div>
    </div>
  </form>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
