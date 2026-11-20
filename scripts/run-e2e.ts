import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function main() {
  const directory = await mkdtemp(join(tmpdir(), "rfp-e2e-"));
  try {
    const child = spawn(process.execPath, ["node_modules/@playwright/test/cli.js", "test", ...process.argv.slice(2)], {
      stdio: "inherit",
      env: {
        ...process.env,
        RFP_E2E_DB_PATH: join(directory, "rfp.sqlite"),
        RFP_EXTRACTION_MODE: "fixture",
        RFP_KICKOFF_TIMEZONE: "America/Toronto",
        RFP_KICKOFF_START: "",
        NEXT_TELEMETRY_DISABLED: "1",
      },
    });

    const interrupt = () => child.kill("SIGINT");
    const terminate = () => child.kill("SIGTERM");
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", terminate);
    try {
      process.exitCode = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve(code ?? (signal === "SIGINT" ? 130 : 143)));
      });
    } finally {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
