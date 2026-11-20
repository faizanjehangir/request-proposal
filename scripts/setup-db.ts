import { loadEnvConfig } from "@next/env";
import { openDb } from "../src/db/client";

loadEnvConfig(process.cwd());
const connection = openDb();
connection.close();
console.log("SQLite is ready.");
