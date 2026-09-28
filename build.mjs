import { build } from "esbuild";
import { chmod, rm } from "node:fs/promises";

const distWipe = { force: true, recursive: true };
await rm("dist", distWipe);
await build({
  entryPoints: ["src/cli/main.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  external: ["typescript", "ignore"],
  banner: { js: "#!/usr/bin/env node" },
  logLevel: "warning",
});
await chmod("dist/index.js", 0o755);
