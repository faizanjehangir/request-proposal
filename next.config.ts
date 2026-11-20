import type { NextConfig } from "next";

const config: NextConfig = {
  serverExternalPackages: ["better-sqlite3"],
  outputFileTracingIncludes: {
    "/*": ["./Air_Freight_RFP_Mock_Data.xlsx", "./drizzle/**/*.sql", "./drizzle/meta/_journal.json"],
  },
  devIndicators: false,
  agentRules: false,
};

export default config;
