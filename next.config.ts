import type { NextConfig } from "next";

const config: NextConfig = {
  devIndicators: false,
  agentRules: false,
  outputFileTracingIncludes: {
    "/**": ["./Air_Freight_RFP_Mock_Data.xlsx", "./drizzle/**/*"],
  },
};

export default config;
