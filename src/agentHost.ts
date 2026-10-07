import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import { pathToFileURL } from "url";
import type { Run, SDKAgent } from "@cursor/sdk";
import type { HostEvent, HostRequest } from "./protocol";
import { describeTool, toolStatus } from "./toolSummary";

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port <= 0) {
  console.error("cursor4vscode host requires a port.");
  process.exit(1);
}

// The folder whose node_modules holds the Cursor SDK. The extension does not ship the SDK,
// so it cannot be imported by name from here.
const sdkFolder = process.argv[3] ?? "";
if (!sdkFolder) {
  console.error("cursor4vscode host requires the folder that holds the Cursor SDK.");
  process.exit(1);
}
// The SDK finds its platform package (ripgrep, the sandbox, native parsers) by walking up from the
// entry script. This script ships with the extension, away from the SDK, so the walk has to start
// from inside the SDK's folder instead.
process.argv[1] = path.join(sdkFolder, "node_modules", "@cursor", "sdk", "package.json");
let loaded: Promise<typeof import("@cursor/sdk")> | undefined;

const socket = net.connect(port, "127.0.0.1");
let buffer = "";
let agent: SDKAgent | undefined;
let run: Run | undefined;
let model = "composer-2.5";
let cwd = process.cwd();
// What a fresh agent is told with the next message: the summary left by a compact,
// or a recap of a conversation whose agent could not be resumed.
let carry = "";
// The conversation's agent when the host does not hold it, resumed when the next message is sent.
let resumeId: string | undefined;
// A resumed agent may still hold a run from a host that died mid-reply.
let resumed = false;

const COMPACT_PROMPT =
  "Summarize this conversation so that it can continue from your summary alone. Do not use any tools. " +
  "Cover what the user asked for, the decisions made, the files created or changed and how, " +
  "the commands run and what they showed, and anything still unfinished. Reply with the summary only.";

socket.setEncoding("utf8");
socket.on("data", (chunk: string) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) {
      void handleLine(line);
    }
    newline = buffer.indexOf("\n");
  }
});

void start();

async function start(): Promise<void> {
  try {
    await sdk();
    emit({ type: "ready" });
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

async function handleLine(line: string): Promise<void> {
  let request: HostRequest;
  try {
    request = JSON.parse(line) as HostRequest;
  } catch {
    return;
  }
  try {
    if (request.type === "authStatus") {
      const status = await (await sdk()).Cursor.auth.status();
      emit({
        id: request.id,
        type: "result",
        ok: true,
        signedIn: status.status === "logged-in",
        email: "email" in status ? status.email : undefined,
      });
      return;
    }
    if (request.type === "login") {
      const loggedIn = await (await sdk()).Cursor.auth.login({
        apiKeyName: "cursor4vscode",
        openBrowser: false,
        onLoginUrl: (url: string) => emit({ type: "loginUrl", url }),
      });
      emit({
        id: request.id,
        type: "result",
        ok: true,
        email: loggedIn.email,
        signedIn: true,
      });
      return;
    }
    if (request.type === "logout") {
      carry = "";
      resumeId = undefined;
      await disposeAgent();
      await (await sdk()).Cursor.auth.logout();
      emit({ id: request.id, type: "result", ok: true, signedIn: false });
      return;
    }
    if (request.type === "listModels") {
      const models = await (await sdk()).Cursor.models.list();
      emit({
        id: request.id,
        type: "result",
        ok: true,
        models: models.map((item: { id: string; displayName?: string }) => ({
          id: item.id,
          displayName: item.displayName,
        })),
      });
      return;
    }
    if (request.type === "configure") {
      const nextCwd = request.cwd || cwd;
      // A new model is passed with the next send, which keeps the conversation.
      // A new folder needs a new agent.
      if (nextCwd !== cwd) {
        await disposeAgent();
      }
      model = request.model;
      cwd = nextCwd;
      // With no agent in memory (a saved conversation, a compact, a restarted host), the next
      // message resumes the conversation's own agent, or failing that tells a new one the recap.
      if (!agent) {
        resumeId = request.agentId;
        carry = request.carry ?? "";
      }
      emit({ id: request.id, type: "result", ok: true });
      return;
    }
    if (request.type === "reset") {
      carry = "";
      resumeId = undefined;
      await disposeAgent();
      emit({ id: request.id, type: "result", ok: true });
      return;
    }
    if (request.type === "compact") {
      const current = agent ?? (await resumeSaved());
      if (!current) {
        emit({ id: request.id, type: "result", ok: false, message: "There is nothing to compact yet." });
        return;
      }
      const active = await current.send(COMPACT_PROMPT, {
        model: { id: model || "composer-2.5" },
        ...(resumed ? { local: { force: true } } : {}),
      });
      resumed = false;
      run = active;
      // wait() alone does not always carry the text, so read it off the stream as well.
      let written = "";
      for await (const event of active.stream()) {
        if (event.type === "assistant") {
          for (const block of event.message.content) {
            if (block.type === "text") {
              written += block.text;
            }
          }
        }
      }
      const result = await active.wait();
      run = undefined;
      const summary = result.status === "finished" ? (written || result.result || "").trim() : "";
      if (!summary) {
        emit({
          id: request.id,
          type: "result",
          ok: false,
          status: result.status,
          message: result.error?.message || "The conversation could not be summarized.",
        });
        return;
      }
      // The SDK has no way to drop history, so the summary replaces it:
      // the next message goes to a fresh agent that is told the summary first.
      await disposeAgent();
      carry = summary;
      emit({ id: request.id, type: "result", ok: true, text: summary });
      return;
    }
    if (request.type === "cancel") {
      if (run?.supports("cancel")) {
        await run.cancel();
      }
      emit({ id: request.id, type: "result", ok: true, status: "cancelled" });
      return;
    }
    if (request.type === "send") {
      const status = await (await sdk()).Cursor.auth.status();
      if (status.status !== "logged-in") {
        emit({
          id: request.id,
          type: "result",
          ok: false,
          signedIn: false,
          message: "Sign in to Cursor, then send the message again.",
        });
        return;
      }
      const current = await ensureAgent();
      emit({ type: "status", status: "CREATING", message: "Starting the agent…" });
      let toolRounds = 0;
      const active = await current.send(carry ? continued(carry, request.text) : request.text, {
        model: { id: model || "composer-2.5" },
        ...(resumed ? { local: { force: true } } : {}),
        onDelta: ({ update }) => {
          if (update.type === "tool-requests-listed") {
            toolRounds += 1;
          } else if (update.type === "summary-started") {
            emit({ type: "status", status: "SUMMARIZING", message: "Summarizing earlier context…" });
          } else if (update.type === "summary-completed") {
            emit({ type: "summarized" });
          }
        },
      });
      carry = "";
      resumed = false;
      run = active;
      let sent = "";
      for await (const event of active.stream()) {
        if (event.type === "status") {
          emit({ type: "status", status: event.status, message: event.message });
        } else if (event.type === "assistant") {
          for (const block of event.message.content) {
            if (block.type !== "text" || !block.text) {
              continue;
            }
            const extra = block.text.startsWith(sent) ? block.text.slice(sent.length) : block.text;
            sent = block.text.startsWith(sent) ? block.text : sent + block.text;
            if (extra) {
              emit({ type: "delta", text: extra });
            }
          }
        } else if (event.type === "thinking") {
          emit({ type: "thinking", text: event.text, durationMs: event.thinking_duration_ms });
        } else if (event.type === "tool_call") {
          emit({
            type: "tool",
            callId: event.call_id,
            status: toolStatus(event.status, event.result),
            view: describeTool(event.name, event.args, event.result, cwd),
          });
        } else if (event.type === "usage") {
          const { inputTokens, cacheReadTokens, cacheWriteTokens } = event.usage;
          emit({
            type: "usage",
            promptTokens: inputTokens + cacheReadTokens + cacheWriteTokens,
            // One request per round of tool calls, plus the one that ends the turn.
            requests: toolRounds + 1,
          });
        }
      }
      const result = await active.wait();
      run = undefined;
      emit({
        id: request.id,
        type: "result",
        ok: result.status !== "error",
        status: result.status,
        text: result.result,
        message: result.error?.message,
        agentId: current.agentId,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if ("id" in request) {
      emit({ id: request.id, type: "result", ok: false, message });
    } else {
      console.error(message);
    }
  }
}

async function ensureAgent(): Promise<SDKAgent> {
  if (agent) {
    return agent;
  }
  const saved = await resumeSaved();
  if (saved) {
    return saved;
  }
  const { Agent } = await sdk();
  const created = await Agent.create({
    model: { id: model || "composer-2.5" },
    local: { cwd },
  });
  agent = created;
  return created;
}

// Brings back the conversation's agent, if the SDK still has its state on disk.
async function resumeSaved(): Promise<SDKAgent | undefined> {
  if (!resumeId) {
    return undefined;
  }
  const id = resumeId;
  resumeId = undefined;
  try {
    const { Agent } = await sdk();
    agent = await Agent.resume(id, { model: { id: model || "composer-2.5" }, local: { cwd } });
  } catch {
    // Its state is gone. A new agent takes over and is told the recap instead.
    return undefined;
  }
  // It remembers the conversation itself, so the recap is not needed.
  carry = "";
  resumed = true;
  return agent;
}

function continued(summary: string, text: string): string {
  return (
    "Earlier messages in this conversation are no longer available to you. This is what they covered:\n\n" +
    `${summary}\n\n` +
    "The conversation continues with the user's next message:\n\n" +
    text
  );
}

async function disposeAgent(): Promise<void> {
  const current = agent;
  agent = undefined;
  run = undefined;
  resumed = false;
  await current?.[Symbol.asyncDispose]();
}

function sdk(): Promise<typeof import("@cursor/sdk")> {
  loaded ??= import(pathToFileURL(sdkEntry()).href);
  return loaded;
}

// The file the SDK's own manifest names for import.
function sdkEntry(): string {
  const root = path.join(sdkFolder, "node_modules", "@cursor", "sdk");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const entry = manifest.exports?.["."];
  return path.join(root, entry?.import ?? entry?.default ?? manifest.main ?? "index.js");
}

function emit(event: HostEvent): void {
  socket.write(`${JSON.stringify(event)}\n`);
}
