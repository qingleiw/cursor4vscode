import * as esbuild from "esbuild";
import { copyFile, mkdir, readdir } from "node:fs/promises";

const watch = process.argv.includes("--watch");

// The webview loads KaTeX as plain files, so its script, stylesheet and fonts ship under media/.
const katex = "node_modules/katex/dist";
await mkdir("media/katex/fonts", { recursive: true });
await copyFile(`${katex}/katex.min.js`, "media/katex/katex.min.js");
await copyFile(`${katex}/katex.min.css`, "media/katex/katex.min.css");
await copyFile("node_modules/katex/LICENSE", "media/katex/LICENSE");
for (const font of await readdir(`${katex}/fonts`)) {
  // The stylesheet lists woff2 first, which is the only format a webview asks for.
  if (font.endsWith(".woff2")) {
    await copyFile(`${katex}/fonts/${font}`, `media/katex/fonts/${font}`);
  }
}

/** @type {import("esbuild").BuildOptions} */
const options = {
  entryPoints: {
    extension: "src/extension.ts",
    agentHost: "src/agentHost.ts",
  },
  outdir: "out",
  bundle: true,
  external: ["vscode", "@cursor/sdk"],
  format: "cjs",
  platform: "node",
  target: "node22",
  sourcemap: true,
  logLevel: "info",
  plugins: [
    {
      name: "watch-log",
      setup(build) {
        build.onStart(() => {
          console.log("[watch] build started");
        });
        build.onEnd((result) => {
          if (result.errors.length === 0) {
            console.log("[watch] build finished");
          }
        });
      },
    },
  ],
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
