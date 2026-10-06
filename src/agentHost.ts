import * as net from "net";
import type { Run, SDKAgent } from "@cursor/sdk";
import type { HostEvent, HostRequest } from "./protocol";

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port <= 0) {
  console.error("cursor4vscode host requires a port.");
  process.exit(1);
}

const socket = net.connect(port, "127.0.0.1");
let buffer = "";
let agent: SDKAgent | undefined;
let run: Run | undefined;
let cwd = "";
let model = "composer-2.5";
let storageDir = "";

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
    await import("@cursor/sdk");
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
      const changed = request.cwd !== cwd || request.model !== model || request.storageDir !== storageDir;
      cwd = request.cwd;
      model = request.model;
      storageDir = request.storageDir;
      if (changed) {
        await disposeAgent();
      }
      emit({ id: request.id, type: "result", ok: true });
      return;
    }
    if (request.type === "reset") {
      await disposeAgent();
      emit({ id: request.id, type: "result", ok: true });
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
      const current = await ensureAgent();
      const active = await current.send(request.text, {
        onDelta: ({ update }) => {
          if (update.type === "text-delta" && update.text) {
            emit({ type: "delta", text: update.text });
          }
        },
      });
      run = active;
      const result = await active.wait();
      run = undefined;
      emit({
        id: request.id,
        type: "result",
        ok: result.status !== "error",
        status: result.status,
        text: result.result,
        message: result.error?.message,
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
  if (!cwd || !storageDir) {
    throw new Error("Open a folder before sending a message.");
  }
  const { Agent, JsonlLocalAgentStore } = await sdk();
  const created = await Agent.create({
    model: { id: model || "composer-2.5" },
    tools: [],
    local: {
      cwd,
      store: new JsonlLocalAgentStore(storageDir),
    },
  });
  agent = created;
  return created;
}

async function disposeAgent(): Promise<void> {
  const current = agent;
  agent = undefined;
  run = undefined;
  await current?.[Symbol.asyncDispose]();
}

async function sdk(): Promise<typeof import("@cursor/sdk")> {
  return import("@cursor/sdk");
}

function emit(event: HostEvent): void {
  socket.write(`${JSON.stringify(event)}\n`);
}
