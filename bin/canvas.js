#!/usr/bin/env bun
/**
 * The published launcher for `canvas`. The shebang asks for `bun`, and both
 * `bunx` and `npx` honor a bin's shebang, so this normally runs under Bun and
 * hands straight over to the raw-TypeScript CLI.
 *
 * It is plain JavaScript so it can still say something useful when Node runs
 * it anyway (`node bin/canvas.js`, or a package manager that ignores the
 * shebang): Node cannot execute the TypeScript behind it, and a syntax error
 * would not tell anyone that Bun is what is missing.
 *
 * Do not give this file a `#!/usr/bin/env node` shebang: `bunx` honors it too,
 * which would route every `bunx @frebreco/canvas` through Node.
 */

if (typeof Bun === "undefined") {
  console.error(
    [
      "",
      "  canvas requires Bun.",
      "",
      "  This package ships raw TypeScript and runs on the Bun runtime.",
      "  Install Bun:  https://bun.sh/docs/installation",
      "  Then run:     bunx @frebreco/canvas serve",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

await import("../src/cli.ts");
