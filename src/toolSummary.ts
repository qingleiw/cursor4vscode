import * as path from "path";
import type { ToolStatus, ToolView } from "./protocol";

const TARGET_LIMIT = 200;
const OUTPUT_LIMIT = 4000;
const DIFF_LIMIT = 8000;

type Fields = Record<string, unknown>;

export function describeTool(name: string, args: unknown, result: unknown, cwd: string): ToolView {
  const a = fields(args);
  const outcome = fields(result);
  const value = fields(outcome.value);
  const view: ToolView = { name, label: name };

  const file = (raw: unknown, open = true): void => {
    const given = text(raw);
    if (!given) {
      return;
    }
    const absolute = path.isAbsolute(given) ? given : path.resolve(cwd, given);
    const relative = path.relative(cwd, absolute);
    view.target = relative.startsWith("..") || path.isAbsolute(relative) ? absolute : relative || ".";
    if (open) {
      view.path = absolute;
    }
  };

  switch (name) {
    case "shell": {
      view.label = "Run";
      const command = text(a.command).trim();
      view.target = oneLine(command);
      const out = [text(value.stdout), text(value.stderr)].filter((part) => part.trim()).join("\n");
      // A command too long for the title is repeated in full above its output.
      const full = !command || view.target === command ? undefined : head(`$ ${command}`, OUTPUT_LIMIT);
      view.output = [full, tail(out, OUTPUT_LIMIT)].filter(Boolean).join("\n\n") || undefined;
      if (typeof value.exitCode === "number" && value.exitCode !== 0) {
        view.meta = `exit ${value.exitCode}`;
      }
      break;
    }
    case "read":
      view.label = "Read";
      file(a.path);
      view.meta = count(value.totalLines, "line");
      break;
    case "write":
      view.label = "Write";
      file(a.path);
      view.meta = count(value.linesCreated, "line");
      break;
    case "edit": {
      view.label = "Edit";
      file(a.path);
      const added = typeof value.linesAdded === "number" ? value.linesAdded : undefined;
      const removed = typeof value.linesRemoved === "number" ? value.linesRemoved : undefined;
      if (added !== undefined || removed !== undefined) {
        view.meta = `+${added ?? 0} −${removed ?? 0}`;
      }
      const diff = text(value.diffString);
      if (diff) {
        // The SDK creates files with this tool too.
        if (diff.startsWith("--- /dev/null")) {
          view.label = "Create";
        }
        // The card already names the file; the diff header repeats it as an absolute path.
        view.output = head(diff.replace(/^--- .*\n\+\+\+ .*\n/, ""), DIFF_LIMIT);
        view.diff = true;
      }
      break;
    }
    case "delete":
      view.label = "Delete";
      file(a.path, false);
      break;
    case "ls":
      view.label = "List";
      file(a.path, false);
      break;
    case "glob":
      view.label = "Find files";
      view.target = oneLine(text(a.globPattern));
      view.meta = count(value.totalFiles, "file");
      break;
    case "grep":
      view.label = "Search";
      view.target = oneLine([text(a.pattern), text(a.glob) || text(a.path)].filter(Boolean).join(" in "));
      break;
    case "semSearch":
      view.label = "Search code";
      view.target = oneLine(text(a.query));
      break;
    case "readLints":
      view.label = "Check problems";
      break;
    case "updateTodos":
      view.label = "Update to-dos";
      view.meta = Array.isArray(a.todos) ? count(a.todos.length, "item") : undefined;
      break;
    case "createPlan":
      view.label = "Plan";
      view.output = head(text(a.plan), OUTPUT_LIMIT);
      break;
    case "task":
      view.label = "Subagent";
      view.target = oneLine(text(a.description));
      break;
    case "mcp":
      view.label = text(a.toolName) || "MCP tool";
      view.target = oneLine(text(a.providerIdentifier));
      break;
    default:
      view.target = oneLine(text(a.query) || text(a.url) || text(a.description) || text(a.path));
  }

  if (outcome.status === "error") {
    const error = fields(outcome.error);
    view.output = tail(text(error.message) || text(outcome.error) || "The tool failed.", OUTPUT_LIMIT);
    view.diff = false;
  }
  return defined(view);
}

// The SDK reports a finished call as completed even when the tool itself
// failed or a command exited non-zero; the failure is only in the result.
export function toolStatus(status: ToolStatus, result: unknown): ToolStatus {
  if (status !== "completed") {
    return status;
  }
  const outcome = fields(result);
  const exitCode = fields(outcome.value).exitCode;
  return outcome.status === "error" || (typeof exitCode === "number" && exitCode !== 0) ? "error" : status;
}

function fields(value: unknown): Fields {
  return value && typeof value === "object" ? (value as Fields) : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function count(value: unknown, noun: string): string | undefined {
  return typeof value === "number" ? `${value} ${noun}${value === 1 ? "" : "s"}` : undefined;
}

function oneLine(value: string): string | undefined {
  const lines = value.trim().split("\n");
  const first = lines[0].trim();
  if (!first) {
    return undefined;
  }
  return first.length > TARGET_LIMIT || lines.length > 1 ? `${first.slice(0, TARGET_LIMIT)}…` : first;
}

function head(value: string, limit: number): string | undefined {
  const trimmed = value.replace(/\s+$/, "");
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}\n…` : trimmed;
}

function tail(value: string, limit: number): string | undefined {
  const trimmed = value.replace(/\s+$/, "");
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length > limit ? `…\n${trimmed.slice(-limit)}` : trimmed;
}

function defined(view: ToolView): ToolView {
  for (const key of Object.keys(view) as Array<keyof ToolView>) {
    if (view[key] === undefined) {
      delete view[key];
    }
  }
  return view;
}
