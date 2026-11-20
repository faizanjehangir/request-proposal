const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const { delimiter, dirname, join } = require("node:path");

let executable = process.execPath;
if (Number(process.versions.node.split(".")[0]) < 22) {
  // Homebrew's versioned Node can be installed without being the shell default.
  const homebrew = [
    process.env.HOMEBREW_PREFIX,
    "/opt/homebrew",
    "/usr/local",
  ].filter(Boolean);
  executable = process.platform === "darwin"
    ? homebrew.map((prefix) => join(prefix, "opt/node@22/bin/node")).find(existsSync)
    : undefined;
}

if (!executable) {
  console.error(`This app needs Node.js 22 or later. The shell is using ${process.version}.`);
  console.error("Select Node 22 (for example, nvm use), then reinstall dependencies with npm ci.");
  process.exit(1);
}

const child = spawn(executable, process.argv.slice(2), {
  stdio: "inherit",
  env: {
    ...process.env,
    PATH: [dirname(executable), process.env.PATH].filter(Boolean).join(delimiter),
  },
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal === "SIGINT" ? 130 : 143);
});
