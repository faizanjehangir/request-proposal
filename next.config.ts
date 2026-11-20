import type { NextConfig } from "next";

const config: NextConfig = {
  serverExternalPackages: ["better-sqlite3"],
  devIndicators: false,
  agentRules: false,
};

export default config;
