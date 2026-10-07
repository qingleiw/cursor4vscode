# cursor4vscode

An **unofficial** chat panel for VS Code that runs a [Cursor](https://cursor.com) agent in the folder you have open. It is not made, endorsed or supported by Cursor or Anysphere.

The panel sits in the secondary side bar, next to Chat. You talk to the agent there; it reads, edits and runs things in your workspace and shows each step as it goes.

## Before you install

- **The agent acts without asking.** It edits files and runs shell commands in the open folder, with no confirmation step. Use it in folders you can afford to have changed, ideally under version control.
- **You need a Cursor account.** Requests go to Cursor through its SDK and count against your Cursor plan.
- **The Cursor SDK is not included.** It is Cursor's own software. The first time you open the panel, it offers to download the SDK from npm to your machine (about 50 MB). Using the SDK is subject to [Cursor's Terms of Service](https://cursor.com/terms-of-service).

## Requirements

- VS Code 1.106 or newer.
- Node.js with npm on your PATH, for the one-time SDK download. If the editor's built-in Node.js is older than 22.13, the agent also runs on that Node.js, so it must be 22.13 or newer.
- With Remote-SSH, WSL or a dev container, both apply to the remote machine: the extension runs where your folder is.

## Getting started

1. Open a folder.
2. Open the **Cursor** panel in the secondary side bar, or click the status bar item.
3. Choose **Download the Cursor SDK**, then **Sign in** with your Cursor account.
4. Type a request.

## What it does

- Shows the agent's work: tool calls as cards with diffs and command output, and its thinking.
- Switches model from the input box without losing the conversation.
- Keeps past conversations per folder. Open them from the title; they continue with their memory.
- Estimates how full the context is and warns when it is nearly full.
- `/compact` summarizes the conversation to free up context. Other commands: `/new`, `/model`, `/resume`.
- Renders Markdown, code blocks with a copy button, tables and LaTeX formulas.

## Things to know

- The context figure is an estimate. The SDK reports neither the size of the context nor a model's window, so the extension works it out from token usage and measures it against the `cursor4vscode.contextWindow` setting.
- Compacting costs one extra request: the agent writes a summary, and a new agent continues from it.

## Settings

| Setting | What it is for |
| --- | --- |
| `cursor4vscode.model` | Model used for chat. Easier to change from the panel. |
| `cursor4vscode.contextWindow` | Context window, in tokens, that the indicator measures against. Default 200000. |
| `cursor4vscode.nodePath` | Path to a Node.js 22.13 or newer binary, if the editor's own is older. |
| `cursor4vscode.sdkPath` | A folder that already holds the SDK (`node_modules/@cursor/sdk`), used instead of the downloaded copy. |

## License

The extension is MIT licensed. It includes [KaTeX](https://katex.org), also MIT. The Cursor SDK is © Anysphere Inc. and is not distributed with this extension.

Cursor is a product of Anysphere Inc. This project is independent of it and uses the name only to say what it works with.
