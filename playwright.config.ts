import { defineConfig } from "@playwright/test";

const dbPath = process.env.RFP_E2E_DB_PATH;
if (!dbPath) throw new Error("Use npm run test:e2e to prepare a fresh SQLite database.");

const port = Number(process.env.RFP_E2E_PORT ?? 3187);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Choose a valid RFP_E2E_PORT.");
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 90_000,
  use: {
    baseURL,
    browserName: "chromium",
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `npm run start -- --port ${port}`,
    url: baseURL,
    reuseExistingServer: false,
    env: { RFP_DB_PATH: dbPath, RFP_V2_MODEL_MODE: "fixture" },
  },
});
