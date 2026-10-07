import * as cp from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

// The Cursor SDK is Cursor's own software and is not part of this extension. Each machine
// downloads it from npm, which also picks the build for that machine's platform.
export const SDK_PACKAGE = "@cursor/sdk@^1.0.36";

export const SDK_MISSING = "The Cursor SDK is not on this machine yet. Download it from the Cursor panel.";

// The folder whose node_modules holds the SDK: one the user points at, the extension's own
// (a development checkout), or the copy this extension downloaded.
export function findSdk(extensionPath: string, storagePath: string): string | undefined {
  const configured = vscode.workspace.getConfiguration("cursor4vscode").get<string>("sdkPath")?.trim();
  return [configured, extensionPath, storagePath].find((folder) => folder && hasSdk(folder)) || undefined;
}

function hasSdk(folder: string): boolean {
  return fs.existsSync(path.join(folder, "node_modules", "@cursor", "sdk", "package.json"));
}

// Downloads the SDK into the extension's storage, or brings the copy there up to date.
export async function installSdk(storagePath: string, output: vscode.OutputChannel): Promise<void> {
  await fs.promises.mkdir(storagePath, { recursive: true });
  const manifest = path.join(storagePath, "package.json");
  if (!fs.existsSync(manifest)) {
    await fs.promises.writeFile(manifest, `${JSON.stringify({ name: "cursor4vscode-sdk", private: true }, null, 2)}\n`);
  }
  output.appendLine(`npm install ${SDK_PACKAGE} (in ${storagePath})`);
  await new Promise<void>((resolve, reject) => {
    const child = cp.spawn("npm", ["install", SDK_PACKAGE, "--no-audit", "--no-fund"], {
      cwd: storagePath,
      // On Windows npm is a .cmd file, which only a shell can start.
      shell: process.platform === "win32",
      windowsHide: true,
    });
    let tail = "";
    const collect = (chunk: Buffer): void => {
      const text = chunk.toString();
      output.append(text);
      tail = (tail + text).slice(-600);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.once("error", (error: NodeJS.ErrnoException) => {
      reject(new Error(error.code === "ENOENT" ? "npm was not found. Install Node.js, which includes npm, then try again." : error.message));
    });
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        const last = tail.trim().split("\n").at(-1) ?? "";
        reject(new Error(`npm could not install the Cursor SDK (exit ${code ?? "unknown"}). ${last}`.trim()));
      }
    });
  });
  if (!hasSdk(storagePath)) {
    throw new Error("npm finished, but the Cursor SDK is not where it was expected.");
  }
}
