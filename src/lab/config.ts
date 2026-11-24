export function labEnabled() {
  const flag = process.env.RFP_V2_ENABLED;
  // Enable the hosted lab explicitly while validating its deployment.
  if (process.env.VERCEL === "1") return flag === "1";
  return flag !== "0";
}
