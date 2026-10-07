const vscode = acquireVsCodeApi();

const transcript = document.getElementById("transcript");
const welcome = document.getElementById("welcome");
const title = document.getElementById("title");
const historyButton = document.getElementById("history");
const folder = document.getElementById("folder");
const input = document.getElementById("input");
const form = document.getElementById("composer");
const submit = document.getElementById("submit");
const notice = document.getElementById("notice");
const model = document.getElementById("model");
const account = document.getElementById("account");
const gate = document.getElementById("gate");
const menu = document.getElementById("menu");
const context = document.getElementById("context");
const contextText = document.getElementById("contextText");
const contextRing = document.getElementById("contextRing");
const hint = document.getElementById("hint");
const hintText = document.getElementById("hintText");

const RING = 2 * Math.PI * 6;
const WARN_AT = 0.8;

let busy = false;
let activity = "";
let session = "";
let usage = { tokens: 0, window: 0 };
// Which collapsible blocks the user opened or closed, so a repaint keeps them that way.
const toggled = new Map();

// One popup serves the slash commands, the model list, the context details and past conversations.
// It sits above the input, or under the header when the title opened it.
let menuKind = "";
let menuItems = [];
let menuActive = -1;
let menuTop = false;

const commands = [
  { label: "/compact", detail: "Summarize the conversation to free up context", run: () => vscode.postMessage({ type: "compact" }) },
  { label: "/new", detail: "Start a new chat", run: () => vscode.postMessage({ type: "newChat" }) },
  { label: "/model", detail: "Switch model", run: () => openModels() },
  { label: "/resume", detail: "Open a past conversation", run: () => openHistory(false) },
];

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
  fitInput();
  vscode.postMessage({ type: "send", text });
});

input.addEventListener("keydown", (event) => {
  // Enter also confirms an IME composition; that must not send.
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    form.requestSubmit();
  }
});

input.addEventListener("input", () => {
  fitInput();
  const typed = input.value.toLowerCase();
  const matches = /^\/[a-z]*$/.test(typed) ? commands.filter((command) => command.label.startsWith(typed)) : [];
  if (matches.length) {
    openMenu("slash", matches);
  } else if (menuKind === "slash") {
    closeMenu();
  }
});

// Runs before the input's own handler, so Enter picks from an open menu instead of sending.
document.addEventListener(
  "keydown",
  (event) => {
    if (menu.hidden) {
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      moveMenu(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Enter" && !event.isComposing && menuActive >= 0) {
      runMenu(menuActive);
    } else if (event.key === "Escape") {
      closeMenu();
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  },
  true
);

document.addEventListener("mousedown", (event) => {
  const inside = event.target instanceof Element && event.target.closest("#menu, #modelButton, #context, #history");
  if (!menu.hidden && !inside) {
    closeMenu();
  }
});

document.getElementById("newChat").addEventListener("click", () => {
  vscode.postMessage({ type: "newChat" });
});

historyButton.addEventListener("click", () => {
  if (menuKind === "history") {
    closeMenu();
  } else {
    openHistory(true);
  }
});

document.getElementById("modelButton").addEventListener("click", () => {
  if (menuKind === "models") {
    closeMenu();
  } else {
    openModels();
  }
  input.focus();
});

context.addEventListener("click", () => {
  if (menuKind === "context") {
    closeMenu();
  } else {
    openMenu("context", [
      { label: `About ${count(usage.tokens)} of ${count(usage.window)} tokens in context. This is an estimate.` },
      commands[0],
      commands[1],
    ]);
  }
  input.focus();
});

document.getElementById("hintCompact").addEventListener("click", () => {
  vscode.postMessage({ type: "compact" });
});

document.getElementById("signIn").addEventListener("click", () => {
  vscode.postMessage({ type: "signIn" });
});

for (const suggestion of document.querySelectorAll(".suggestion")) {
  suggestion.addEventListener("click", () => {
    input.value = suggestion.textContent;
    fitInput();
    input.focus();
  });
}

transcript.addEventListener("click", (event) => {
  const button = event.target.closest(".copy");
  if (!button) {
    return;
  }
  void navigator.clipboard.writeText(button.closest(".code").querySelector("code").textContent).then(() => {
    button.textContent = "Copied";
    setTimeout(() => {
      button.textContent = "Copy";
    }, 1200);
  });
});

window.addEventListener("message", (event) => {
  const message = event.data;
  if (message?.type === "models") {
    showModels(message);
    return;
  }
  if (message?.type === "sessions") {
    showHistory(message);
    return;
  }
  if (message?.type !== "state") {
    return;
  }
  busy = Boolean(message.busy);
  activity = message.activity || "";
  if (message.session !== session) {
    session = message.session;
    toggled.clear();
  }
  const signedIn = Boolean(message.account);
  const messages = message.messages || [];
  title.textContent = message.title || "New chat";
  model.textContent = message.model;
  folder.textContent = message.target || "this folder";
  account.textContent = message.account || "";
  gate.hidden = signedIn;
  form.hidden = !signedIn;
  welcome.hidden = !signedIn || messages.length > 0;
  transcript.hidden = !signedIn || messages.length === 0;
  submit.classList.toggle("busy", busy);
  submit.title = busy ? "Stop" : "Send";
  fitInput();
  if (message.notice) {
    notice.hidden = false;
    notice.textContent = message.notice;
  } else {
    notice.hidden = true;
    notice.textContent = "";
  }
  renderContext(message.context);
  renderMessages(messages);
});

function fitInput() {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
  submit.disabled = !busy && !input.value.trim();
}

function renderContext(next) {
  usage = { tokens: next?.tokens || 0, window: next?.window || 0 };
  const share = usage.window ? Math.min(usage.tokens / usage.window, 1) : 0;
  const percent = Math.round(share * 100);
  const full = share >= WARN_AT;
  context.hidden = !usage.tokens;
  context.classList.toggle("warn", full);
  context.title = `About ${count(usage.tokens)} of ${count(usage.window)} tokens in context (estimate)`;
  contextText.textContent = `${percent}%`;
  contextRing.setAttribute("stroke-dasharray", `${(share * RING).toFixed(2)} ${RING.toFixed(2)}`);
  hint.hidden = !full || busy;
  hintText.textContent = `Context is about ${percent}% full. Compact the conversation or start a new chat.`;
}

function count(tokens) {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}

function openModels() {
  openMenu("models", [{ label: "Loading models…" }]);
  vscode.postMessage({ type: "listModels" });
}

function showModels(message) {
  if (menuKind !== "models") {
    return;
  }
  const models = message.models || [];
  if (models.length === 0) {
    openMenu("models", [{ label: "No models are available for this account." }]);
    return;
  }
  openMenu(
    "models",
    models.map((item) => ({
      label: item.displayName || item.id,
      detail: item.displayName && item.displayName !== item.id ? item.id : "",
      checked: item.id === message.current,
      run: () => vscode.postMessage({ type: "setModel", model: item.id }),
    }))
  );
}

function openHistory(top) {
  openMenu("history", [{ label: "Loading conversations…" }], top);
  vscode.postMessage({ type: "listSessions" });
}

function showHistory(message) {
  if (menuKind !== "history") {
    return;
  }
  const sessions = message.sessions || [];
  if (sessions.length === 0) {
    openMenu("history", [{ label: "No earlier conversations in this folder." }], menuTop);
    return;
  }
  openMenu(
    "history",
    sessions.map((item) => ({
      label: item.title,
      detail: ago(item.updated),
      checked: item.id === message.current,
      run: () => vscode.postMessage({ type: "openSession", id: item.id }),
    })),
    menuTop
  );
}

function ago(time) {
  const minutes = Math.round((Date.now() - time) / 60000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  if (minutes < 60 * 24) {
    return `${Math.round(minutes / 60)}h ago`;
  }
  if (minutes < 60 * 24 * 7) {
    return `${Math.round(minutes / 60 / 24)}d ago`;
  }
  return new Date(time).toLocaleDateString();
}

function openMenu(kind, items, top = false) {
  menuKind = kind;
  menuItems = items;
  menuTop = top;
  menu.classList.toggle("under-header", top);
  const checked = items.findIndex((item) => item.checked);
  menuActive = checked >= 0 ? checked : items.findIndex((item) => item.run);
  menu.hidden = false;
  renderMenu();
}

function closeMenu() {
  menuKind = "";
  menuItems = [];
  menuActive = -1;
  menu.hidden = true;
  menu.replaceChildren();
}

function moveMenu(step) {
  const choices = menuItems.map((item, index) => (item.run ? index : -1)).filter((index) => index >= 0);
  if (choices.length === 0) {
    return;
  }
  const at = choices.indexOf(menuActive);
  menuActive = choices[(at + step + choices.length) % choices.length];
  renderMenu();
}

function runMenu(index) {
  const item = menuItems[index];
  if (!item?.run) {
    return;
  }
  if (menuKind === "slash") {
    input.value = "";
  }
  closeMenu();
  fitInput();
  item.run();
}

function renderMenu() {
  menu.replaceChildren();
  for (const [index, item] of menuItems.entries()) {
    if (!item.run) {
      const note = document.createElement("div");
      note.className = "menu-note";
      note.textContent = item.label;
      menu.appendChild(note);
      continue;
    }
    const row = document.createElement("button");
    row.type = "button";
    row.className = `menu-item${index === menuActive ? " active" : ""}`;
    const label = document.createElement("span");
    label.className = "menu-label";
    label.textContent = item.label;
    row.appendChild(label);
    if (item.detail) {
      const detail = document.createElement("span");
      detail.className = "menu-detail";
      detail.textContent = item.detail;
      row.appendChild(detail);
    }
    if (item.checked) {
      const check = document.createElement("span");
      check.className = "menu-check";
      check.textContent = "✓";
      row.appendChild(check);
    }
    // Keep the caret in the input while the mouse picks.
    row.addEventListener("mousedown", (event) => event.preventDefault());
    row.addEventListener("click", () => runMenu(index));
    menu.appendChild(row);
  }
  menu.querySelector(".active")?.scrollIntoView({ block: "nearest" });
}

function renderMessages(messages) {
  // Follow new output only while the reader is already at the bottom.
  const top = transcript.scrollTop;
  const follow = transcript.scrollHeight - top - transcript.clientHeight < 40;
  transcript.replaceChildren();
  for (const [index, message] of messages.entries()) {
    const row = document.createElement("article");
    row.className = `message ${message.role}${message.pending ? " pending" : ""}`;
    const blocks = message.blocks?.length ? message.blocks : [{ type: "text", text: message.text }];
    for (const [position, block] of blocks.entries()) {
      const element = renderBlock(block, `${index}:${block.callId || position}`);
      if (element) {
        row.appendChild(element);
      }
    }
    if (message.pending && isSettled(blocks.at(-1))) {
      const waiting = document.createElement("div");
      waiting.className = "activity";
      waiting.textContent = activity || "Working…";
      row.appendChild(waiting);
    }
    transcript.appendChild(row);
  }
  transcript.scrollTop = follow ? transcript.scrollHeight : top;
}

// True when the last block shows nothing in motion, so the reply needs its own activity line.
function isSettled(block) {
  if (!block || (block.type === "text" && !block.text)) {
    return true;
  }
  if (block.type === "thinking") {
    return Boolean(block.done);
  }
  return block.type === "compact" || (block.type === "tool" && block.status !== "running");
}

function renderBlock(block, key) {
  if (block.type === "thinking") {
    return renderThinking(block, key);
  }
  if (block.type === "tool") {
    return renderTool(block, key);
  }
  if (block.type === "compact") {
    return renderCompact(block, key);
  }
  if (!block.text) {
    return null;
  }
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.innerHTML = renderMarkdown(block.text);
  return bubble;
}

function renderThinking(block, key) {
  let label = "Thinking…";
  if (block.done) {
    label = block.durationMs >= 1000 ? `Thought for ${Math.round(block.durationMs / 1000)}s` : "Thought";
  }
  if (!block.text) {
    const line = document.createElement("div");
    line.className = "thinking";
    line.textContent = label;
    return line;
  }
  const details = collapsible("thinking", key, false);
  details.firstChild.textContent = label;
  const body = document.createElement("div");
  body.className = "thinking-text";
  body.textContent = block.text;
  details.appendChild(body);
  return details;
}

// A divider where the agent's memory was replaced by a summary; the summary opens on click.
function renderCompact(block, key) {
  const label = block.auto ? "Earlier context was summarized" : "Conversation compacted";
  if (!block.text) {
    const line = document.createElement("div");
    line.className = "compact";
    const text = document.createElement("span");
    text.textContent = label;
    line.appendChild(text);
    return line;
  }
  const details = collapsible("compact", key, false);
  const text = document.createElement("span");
  text.textContent = label;
  details.firstChild.appendChild(text);
  const body = document.createElement("div");
  body.className = "bubble compact-text";
  body.innerHTML = renderMarkdown(block.text);
  details.appendChild(body);
  return details;
}

function renderTool(block, key) {
  // Diffs start open: what the agent changed is the part worth seeing unasked.
  const card = block.output ? collapsible(`tool ${block.status}`, key, Boolean(block.diff)) : document.createElement("div");
  const head = block.output ? card.firstChild : document.createElement("div");
  if (!block.output) {
    card.className = `tool ${block.status}`;
    card.appendChild(head);
  }
  head.className = "tool-head";

  const state = document.createElement("span");
  state.className = "tool-state";
  state.title = block.status;
  const label = document.createElement("span");
  label.className = "tool-label";
  label.textContent = block.label || block.name;
  head.append(state, label);

  if (block.target) {
    const target = document.createElement(block.path ? "button" : "code");
    target.className = "tool-target";
    target.textContent = block.target;
    target.title = block.path || block.target;
    if (block.path) {
      target.type = "button";
      target.addEventListener("click", (event) => {
        // Inside a summary, a click would also fold the card.
        event.preventDefault();
        vscode.postMessage({ type: "openFile", path: block.path });
      });
    }
    head.appendChild(target);
  }
  const space = document.createElement("span");
  space.className = "grow";
  head.appendChild(space);
  if (block.meta) {
    const meta = document.createElement("span");
    meta.className = "tool-meta";
    meta.textContent = block.meta;
    head.appendChild(meta);
  }

  if (block.output) {
    const output = document.createElement("pre");
    output.className = "tool-output";
    if (block.diff) {
      output.appendChild(renderDiff(block.output));
    } else {
      output.textContent = block.output;
    }
    card.appendChild(output);
  }
  return card;
}

function renderDiff(diff) {
  const lines = document.createElement("div");
  lines.className = "diff";
  for (const text of diff.split("\n")) {
    const line = document.createElement("span");
    if (text.startsWith("@@")) {
      line.className = "hunk";
    } else if (text.startsWith("+") && !text.startsWith("+++")) {
      line.className = "add";
    } else if (text.startsWith("-") && !text.startsWith("---")) {
      line.className = "del";
    }
    line.textContent = text || " ";
    lines.appendChild(line);
  }
  return lines;
}

function collapsible(className, key, openByDefault) {
  const details = document.createElement("details");
  details.className = className;
  details.open = toggled.has(key) ? toggled.get(key) : openByDefault;
  details.addEventListener("toggle", () => {
    toggled.set(key, details.open);
  });
  details.appendChild(document.createElement("summary"));
  return details;
}

// The source is escaped first, so every tag below is one this file wrote.
function renderMarkdown(source) {
  const parts = escapeHtml(source).split("```");
  let html = "";
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      html += renderProse(parts[i]);
      continue;
    }
    const newline = parts[i].indexOf("\n");
    const first = newline < 0 ? "" : parts[i].slice(0, newline).trim();
    const language = /^[\w+#.-]*$/.test(first) ? first : "";
    const body = (newline >= 0 && language === first ? parts[i].slice(newline + 1) : parts[i]).replace(/\n$/, "");
    html += `<div class="code"><div class="code-head"><span>${language}</span><button type="button" class="copy">Copy</button></div><pre><code>${body}</code></pre></div>`;
  }
  return html;
}

function renderProse(text) {
  // Formulas are rendered first and set aside behind placeholders, so the Markdown rules below
  // neither see them nor touch the * and _ inside them.
  const formulas = [];
  const source = setAsideMath(text, formulas);
  const blocks = [];
  let list = null;
  let table = [];
  let quote = [];
  const flush = () => {
    if (list) {
      const open = list.tag === "ol" && list.start !== "1" ? `<ol start="${list.start}">` : `<${list.tag}>`;
      blocks.push(`${open}${list.items.map((item) => `<li>${inline(item)}</li>`).join("")}</${list.tag}>`);
      list = null;
    }
    if (table.length) {
      blocks.push(renderTable(table));
      table = [];
    }
    if (quote.length) {
      blocks.push(`<blockquote>${quote.map((line) => `<p>${inline(line)}</p>`).join("")}</blockquote>`);
      quote = [];
    }
  };
  for (const line of source.split("\n")) {
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const tag = bullet ? "ul" : "ol";
      if (list?.tag !== tag) {
        flush();
        list = { tag, start: numbered ? numbered[1] : "1", items: [] };
      }
      list.items.push(bullet ? bullet[1] : numbered[2]);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      if (table.length === 0) {
        flush();
      }
      table.push(line);
      continue;
    }
    const quoted = /^\s*&gt;\s?(.*)$/.exec(line);
    if (quoted) {
      if (quote.length === 0) {
        flush();
      }
      quote.push(quoted[1]);
      continue;
    }
    flush();
    if (line.trim() === "") {
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
    } else if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push("<hr>");
    } else {
      blocks.push(`<p>${inline(line)}</p>`);
    }
  }
  flush();
  return blocks.join("").replace(MATH_PLACEHOLDER, (_, index) => formulas[index]);
}

// A character that does not occur in text, around the index of a formula that was set aside.
const MATH_MARK = "";
const MATH_PLACEHOLDER = new RegExp(`${MATH_MARK}(\\d+)${MATH_MARK}`, "g");

// Replaces each formula in the text with a placeholder and adds its rendering to formulas.
function setAsideMath(text, formulas) {
  const keep = (tex, display) => {
    formulas.push(renderMath(tex, display));
    return `${MATH_MARK}${formulas.length - 1}${MATH_MARK}`;
  };
  return text
    .split(MATH_MARK)
    .join("")
    .split(/(`[^`\n]+`)/)
    .map((part, index) =>
      // Odd parts are `code spans`, where a dollar sign or a backslash is just that.
      index % 2
        ? part
        : part
            .replace(/\\\[([\s\S]+?)\\\]/g, (_, tex) => `\n${keep(tex, true)}\n`)
            .replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => `\n${keep(tex, true)}\n`)
            .replace(/\\\((.+?)\\\)/g, (_, tex) => keep(tex, false))
            // A lone pair of dollar signs is a formula only when what it holds looks like one: "$5 and $10" does not.
            .replace(/\$(?=\S)([^$\n]*?[\\^_={][^$\n]*?)(?<=\S)\$(?!\d)/g, (_, tex) => keep(tex, false))
    )
    .join("");
}

function renderMath(tex, display) {
  // The text was escaped for HTML before it got here; KaTeX needs it as written.
  const source = tex.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&").trim();
  let html;
  try {
    html = katex.renderToString(source, { output: "html", displayMode: display, throwOnError: true });
  } catch {
    // Not valid LaTeX, still being written, or KaTeX did not load: show it as written.
    html = `<code>${tex.trim()}</code>`;
  }
  return display ? `<span class="math-block">${html}</span>` : html;
}

function renderTable(lines) {
  const rows = lines.map((line) =>
    line
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((cell) => cell.trim())
  );
  // Without a separator row these are just lines that happen to have pipes in them.
  if (rows.length < 2 || !rows[1].every((cell) => /^:?-+:?$/.test(cell))) {
    return lines.map((line) => `<p>${inline(line)}</p>`).join("");
  }
  const head = rows[0].map((cell) => `<th>${inline(cell)}</th>`).join("");
  const body = rows
    .slice(2)
    .map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join("")}</tr>`)
    .join("");
  return `<div class="table"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function inline(text) {
  return text
    .split(/(`[^`]+`)/)
    .map((part) => {
      if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
        return `<code>${part.slice(1, -1)}</code>`;
      }
      return part
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
    })
    .join("");
}

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

vscode.postMessage({ type: "ready" });
