import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

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
