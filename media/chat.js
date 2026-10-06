const vscode = acquireVsCodeApi();

const transcript = document.getElementById("transcript");
const input = document.getElementById("input");
const form = document.getElementById("composer");
const submit = document.getElementById("submit");
const notice = document.getElementById("notice");
const model = document.getElementById("model");
const account = document.getElementById("account");

let busy = false;

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (busy) {
    vscode.postMessage({ type: "cancel" });
    return;
  }
  const text = input.value.trim();
  if (!text) {
    return;
  }
  input.value = "";
  vscode.postMessage({ type: "send", text });
});

input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});

document.getElementById("newChat").addEventListener("click", () => {
  vscode.postMessage({ type: "newChat" });
});

document.getElementById("modelButton").addEventListener("click", () => {
  vscode.postMessage({ type: "pickModel" });
});

account.addEventListener("click", () => {
  vscode.postMessage({ type: "signIn" });
});

window.addEventListener("message", (event) => {
  const message = event.data;
  if (message?.type !== "state") {
    return;
  }
  busy = Boolean(message.busy);
  model.textContent = message.model || "";
  account.textContent = message.account || "Sign in";
  submit.textContent = busy ? "Stop" : "Send";
  input.disabled = false;
  if (message.notice) {
    notice.hidden = false;
    notice.textContent = message.notice;
  } else {
    notice.hidden = true;
    notice.textContent = "";
  }
  renderMessages(message.messages || []);
});

function renderMessages(messages) {
  transcript.replaceChildren();
  if (messages.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Ask a question. Replies stream from the Cursor model you select. This chat does not edit files.";
    transcript.appendChild(empty);
    return;
  }
  for (const message of messages) {
    const row = document.createElement("article");
    row.className = `message ${message.role}${message.pending ? " pending" : ""}`;
    const role = document.createElement("div");
    role.className = "role";
    role.textContent = message.role === "user" ? "You" : "cursor4vscode";
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.innerHTML = renderMarkdown(message.text || (message.pending ? "…" : ""));
    row.append(role, bubble);
    transcript.appendChild(row);
  }
  transcript.scrollTop = transcript.scrollHeight;
}

function renderMarkdown(source) {
  const escaped = escapeHtml(source);
  const parts = escaped.split("```");
  let html = "";
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      html += renderInline(parts[i]);
    } else {
      const body = parts[i].replace(/^[\w-]*\n?/, "");
      html += `<pre><code>${body.replace(/\n$/, "")}</code></pre>`;
    }
  }
  return html;
}

function renderInline(text) {
  const lines = text.split("\n");
  const blocks = [];
  let list = [];
  const flushList = () => {
    if (list.length) {
      blocks.push(`<ul>${list.map((item) => `<li>${inline(item)}</li>`).join("")}</ul>`);
      list = [];
    }
  };
  for (const line of lines) {
    const item = /^(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
    if (item) {
      list.push(item[1]);
      continue;
    }
    flushList();
    if (line.trim() === "") {
      continue;
    }
    blocks.push(`<p>${inline(line)}</p>`);
  }
  flushList();
  return blocks.join("");
}

function inline(text) {
  return text
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

vscode.postMessage({ type: "ready" });
