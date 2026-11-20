import { loadEnvConfig } from "@next/env";
import { setTimeout as delay } from "node:timers/promises";
import { openDb } from "../src/db/client";
import { processKickoff } from "../src/closeout/calendar";
import { processQuoteEmail } from "../src/quotes/outbox";
import { processPricingEmail } from "../src/pricing/outbox";

async function run() {
  loadEnvConfig(process.cwd());
  const connection = await openDb();
  const stop = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => stop.abort());
  console.log("Simulated workflow worker is polling the SQLite outbox.");

  try {
    while (!stop.signal.aborted) {
      const pricingProcessed = await processPricingEmail(connection.db);
      const quoteProcessed = await processQuoteEmail(connection.db);
      const kickoffProcessed = await processKickoff(connection.db);
      if (!pricingProcessed && !quoteProcessed && !kickoffProcessed) await delay(500, undefined, { signal: stop.signal });
    }
  } catch (error) {
    if (!stop.signal.aborted) throw error;
  } finally {
    connection.close();
  }
}

run().catch((error) => {
  console.error("Workflow worker stopped", error);
  process.exitCode = 1;
});
