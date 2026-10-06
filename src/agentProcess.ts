import * as cp from "child_process";
import * as net from "net";
import * as path from "path";
import * as vscode from "vscode";
import type { HostEvent } from "./protocol";

interface Pending {
  resolve: (value: HostEvent & { type: "result" }) => void;
  reject: (error: Error) => void;
}

export interface NodeLaunch {
  command: string;
  env: NodeJS.ProcessEnv;
}

export class AgentProcess {
  private child: cp.ChildProcess | undefined;
  private socket: net.Socket | undefined;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private ready: Promise<void> | undefined;
  readonly output: vscode.OutputChannel;

  onDelta: ((text: string) => void) | undefined;
  onLoginUrl: ((url: string) => void) | undefined;

  constructor(private readonly extensionPath: string, output: vscode.OutputChannel) {
    this.output = output;
  }

  start(): Promise<void> {
    if (!this.ready) {
      this.ready = this.spawn().catch((error: unknown) => {
        this.ready = undefined;
        throw error;
      });
    }
    return this.ready;
  }

  async request(type: string, body: Record<string, unknown> = {}): Promise<HostEvent & { type: "result" }> {
    await this.start();
    const id = this.nextId++;
    const result = new Promise<HostEvent & { type: "result" }>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.send({ id, type, ...body });
    return result;
  }

  dispose(): void {
    this.rejectAll(new Error("Code Agent host stopped."));
    this.socket?.destroy();
    this.child?.kill();
    this.socket = undefined;
    this.child = undefined;
    this.ready = undefined;
  }

  private async spawn(): Promise<void> {
    const launch = resolveNode();
    const script = path.join(this.extensionPath, "out", "agentHost.js");
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Could not listen for the Code Agent host.");
    }

    const connected = new Promise<net.Socket>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Code Agent host did not connect.")), 20000);
      server.once("connection", (socket) => {
        clearTimeout(timer);
        resolve(socket);
      });
    });

    this.child = cp.spawn(launch.command, [script, String(address.port)], {
      cwd: this.extensionPath,
      env: launch.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.stdout?.on("data", (chunk: Buffer) => {
      this.output.append(chunk.toString());
    });
    this.child.stderr?.on("data", (chunk: Buffer) => {
      this.output.append(chunk.toString());
    });
    this.child.once("exit", (code) => {
      this.rejectAll(new Error(`Code Agent host exited (${code ?? "unknown"}).`));
      this.ready = undefined;
    });

    try {
      this.socket = await connected;
    } catch (error) {
      this.child.kill();
      server.close();
      throw error;
    }
    server.close();
    this.socket.setEncoding("utf8");
    this.socket.on("data", (chunk: string) => this.onData(chunk));
    this.socket.on("error", (error) => this.rejectAll(error));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Code Agent host did not become ready.")), 20000);
      const previous = this.onReady;
      this.onReady = () => {
        clearTimeout(timer);
        this.onReady = previous;
        resolve();
      };
    });
  }

  private onReady: (() => void) | undefined;

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) {
        this.onLine(line);
      }
      newline = this.buffer.indexOf("\n");
    }
  }

  private onLine(line: string): void {
    let event: HostEvent;
    try {
      event = JSON.parse(line) as HostEvent;
    } catch {
      this.output.appendLine(line);
      return;
    }
    if (event.type === "ready") {
      this.onReady?.();
      return;
    }
    if (event.type === "delta") {
      this.onDelta?.(event.text);
      return;
    }
    if (event.type === "loginUrl") {
      this.onLoginUrl?.(event.url);
      return;
    }
    const waiter = this.pending.get(event.id);
    if (!waiter) {
      return;
    }
    this.pending.delete(event.id);
    if (event.ok) {
      waiter.resolve(event);
    } else {
      waiter.reject(new Error(event.message || "Code Agent request failed."));
    }
  }

  private send(message: object): void {
    this.socket?.write(`${JSON.stringify(message)}\n`);
  }

  private rejectAll(error: Error): void {
    for (const waiter of this.pending.values()) {
      waiter.reject(error);
    }
    this.pending.clear();
  }
}

export function resolveNode(): NodeLaunch {
  const configured = vscode.workspace.getConfiguration("codeAgent").get<string>("nodePath")?.trim();
  if (configured) {
    return { command: configured, env: { ...process.env } };
  }
  const [major, minor] = process.versions.node.split(".").map((part) => Number(part));
  if (major > 22 || (major === 22 && minor >= 13)) {
    return {
      command: process.execPath,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    };
  }
  return { command: "node", env: { ...process.env } };
}
