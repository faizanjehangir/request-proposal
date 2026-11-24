import { expect, test, type Page } from "@playwright/test";
import Database from "better-sqlite3";

async function prepareQuote(page: Page, testGap: boolean) {
  const routing = page.locator("#routing");
  const pricing = page.locator("#pricing");
  const quote = page.locator("#quote");
  async function offer(lane: string, disposition: "offer" | "alternative", reason?: string) {
    await routing.getByLabel("Find a lane").fill(lane);
    const row = routing.locator(".review-lane");
    await row.locator(":scope > summary").click();
    await row.getByText("Decide what to offer", { exact: true }).click();
    await row.getByLabel("Lane decision").selectOption(disposition);
    if (reason) await row.getByLabel("Reason for an alternative or no offer").fill(reason);
    await row.getByRole("button", { name: "Save decision" }).click();
    await expect(row.locator(".saved-disposition")).toBeVisible();
  }
  await offer("MEX to CDG", "offer");
  await offer("GRU to SIN", "alternative", "Fragile handling is unavailable.");
  await pricing.getByRole("button", { name: "Send simulated Pricing email" }).click();
  if (testGap) {
    await pricing.getByRole("button", { name: "Simulate incomplete reply" }).click();
    await expect(pricing.getByRole("status")).toHaveText("1 of 2 rates matched · Quote blocked");
    await expect(quote.getByRole("button", { name: "Create quote draft" })).toHaveCount(0);
  }
  await pricing.getByRole("button", { name: "Simulate complete reply" }).click();
  await routing.getByText("Bulk decisions", { exact: true }).click();
  await routing.getByText("Mark remaining lanes as no offer", { exact: true }).click();
  await routing.getByLabel("Reason for marking these lanes as no offer").fill("No offer under this exercise.");
  await routing.getByRole("button", { name: "Mark 98 lanes as no offer" }).click();
  await expect(pricing.getByRole("status")).toHaveText("Rates ready for quote drafting");
  await quote.getByRole("button", { name: "Create quote draft" }).click();
  await expect(quote.getByRole("region", { name: "Quote v1 email preview" })).toContainText("Requested services unavailable: Fragile handling");
  return quote;
}

test("AI Lab pauses, compares real flight legs and leaves the original review untouched", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Load sample RFP" }).click();
  await page.waitForURL("**/rfps/*");
  const original = new URL(page.url()).pathname;
  const rfp = original.split("/").at(-1)!;
  await page.goto("/");
  await page.getByRole("link", { name: "AI Lab", exact: true }).click();
  await expect(page.getByRole("heading", { name: "AI Lab", exact: true })).toBeVisible();
  await page.getByRole("link", { name: new RegExp(`RFP ${rfp} ·`) }).click();
  await page.getByRole("checkbox", { name: "Add a simulated ambiguous instruction" }).check();
  await page.getByRole("button", { name: "Extract in AI Lab" }).click();
  await page.waitForURL("**/lab/*?run=*");
  await expect(page.getByRole("status")).toContainText("Paused for requirement review");
  await page.reload();
  await expect(page.getByText("Please confirm which lanes need temperature controlled handling", { exact: false })).toBeVisible();
  const fai = page.getByRole("region", { name: "Extracted lanes" }).locator("details").filter({ hasText: "FAI → SIN" });
  await fai.locator("summary").click();
  await fai.getByRole("checkbox", { name: "Temperature controlled (2-8 C)", exact: true }).check();
  await fai.getByRole("checkbox", { name: "Confirm this service selection for FAI to SIN" }).check();
  await page.getByLabel("Review note").fill("The shipper confirmed temperature control applies only to FAI to SIN.");
  await page.getByRole("button", { name: "Confirm requirements and compare routes" }).click();

  const comparison = page.getByRole("region", { name: "Compare flight routes" });
  const gru = comparison.getByRole("article", { name: "GRU to SIN route options" });
  await expect(gru.getByText("Service gap · Disclosure required")).toBeVisible();
  await expect(gru.getByText("4d · Missing Fragile handling")).toBeVisible();
  await expect(gru.getByText("Full service · Over time limit")).toBeVisible();
  await expect(gru.getByText("11 days", { exact: true })).toBeVisible();
  await gru.getByText("DXB → MIA", { exact: true }).click();
  await expect(gru.getByText(/Transit row 58/)).toBeVisible();

  const mex = comparison.getByRole("article", { name: "MEX to CDG route options" });
  await expect(mex.getByText("3d · Missing Dangerous goods")).toBeVisible();
  const unreachable = comparison.getByRole("article", { name: "FAI to SIN route options" });
  await expect(unreachable.getByText("20-day limit · Temperature controlled (2-8 C)")).toBeVisible();
  await expect(unreachable.getByText("No directed path in the inventory", { exact: false })).toBeVisible();

  const assistant = page.getByRole("complementary", { name: "Route assistant" });
  const conversation = assistant.getByRole("log");
  await assistant.getByRole("button", { name: "Show blocked routes" }).click();
  await expect(conversation.getByText(/I applied the filter/)).toBeVisible();
  await expect(comparison.getByRole("button", { name: /^No offer eligible/ })).toHaveAttribute("aria-pressed", "true");
  await expect(gru).toHaveCount(0);
  await assistant.getByLabel("Ask about this run").fill("Why does GRU to SIN have a handling gap?");
  await assistant.getByRole("button", { name: "Send", exact: true }).click();
  await expect(conversation.getByText(/takes 4 days.*11 days.*Transit rows: 71/)).toBeVisible();
  await expect(gru).toBeVisible();
  await expect(mex).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole("link", { name: "Compare V1 and V2" }).click();
  await expect(page.getByText("Run routing analysis in the", { exact: false })).toBeVisible();
  const compareUrl = page.url();
  await page.goto(original);
  const analyze = page.getByRole("button", { name: "Extract requirements and find routes" });
  await expect(analyze).toBeVisible();
  await analyze.click();
  await expect(page.getByText("Showing 100 of 100 lanes")).toBeVisible();
  await page.goto(compareUrl);
  await expect(page.getByRole("heading", { name: "Compare V1 and V2" })).toBeVisible();
  await page.getByRole("link", { name: "Differences only" }).click();
  const differences = page.getByRole("region", { name: "V1 and V2 lane comparison" });
  await expect(differences.getByRole("row").filter({ hasText: "FAI → SIN" })).toContainText("Temperature controlled (2-8 C)");
  await expect(differences.getByRole("row").filter({ hasText: "MEX → CDG" })).toHaveCount(0);
  await page.getByRole("link", { name: "Back to lab run" }).click();
  await expect(page.getByRole("region", { name: "Compare flight routes" })).toBeVisible();
  const openProposal = page.getByRole("button", { name: "Open lab proposal" });
  const proposalButton = await openProposal.boundingBox();
  const compareButton = await page.getByRole("link", { name: "Compare V1 and V2" }).boundingBox();
  expect(proposalButton?.y).toBeCloseTo(compareButton!.y, 0);
  await openProposal.click();
  await expect(page.getByRole("heading", { name: "Lab proposal" })).toBeVisible();
  const proposalUrl = page.url();
  const quote = await prepareQuote(page, true);
  await expect(quote.getByRole("button", { name: "Send simulated quote" })).toHaveCount(0);
  await quote.getByRole("button", { name: "Approve quote v1" }).click();
  await quote.getByRole("button", { name: "Send simulated quote" }).click();
  const closeout = page.locator("#closeout");
  await closeout.getByRole("button", { name: "Simulate partial acceptance" }).click();
  await expect(closeout.getByRole("status")).toHaveText("Partial acceptance · Human review needed");
  await closeout.getByLabel("Simulate a temporary calendar failure").check();
  await closeout.getByRole("button", { name: "Simulate full acceptance" }).click();
  await expect(closeout.getByRole("status")).toHaveText("Proposal accepted · Kickoff scheduling failed");
  await closeout.getByRole("button", { name: "Retry kickoff scheduling" }).click();
  await expect(closeout.getByRole("status")).toHaveText("Proposal accepted · Kickoff booked");
  await closeout.getByRole("button", { name: "Replay acceptance reply" }).click();
  await expect(closeout.getByRole("status")).toHaveText("Proposal accepted · Kickoff booked");
  await page.reload();
  await expect(closeout.getByRole("status")).toHaveText("Proposal accepted · Kickoff booked");

  const originalDb = new Database(process.env.RFP_E2E_DB_PATH!, { readonly: true });
  const labDb = new Database(`${process.env.RFP_E2E_DB_PATH}.lab.sqlite`, { readonly: true });
  try {
    expect(originalDb.prepare("select id from accepted_proposals where rfpId = ?").all(Number(rfp))).toEqual([]);
    expect(labDb.prepare("select id from accepted_proposals").all()).toHaveLength(1);
    expect(labDb.prepare("select providerId from kickoff_invites").all()).toHaveLength(1);
  } finally {
    labDb.close();
    originalDb.close();
  }

  await page.goto(original);
  await expect(page.locator("#routing").getByRole("status").first()).toContainText("100 of 100 lanes awaiting a decision");
  await expect(page.locator("#closeout").getByRole("status")).toHaveText("Waiting for a customer quote to be sent");
  await prepareQuote(page, false);
  await page.goto(compareUrl);
  await expect(page.getByText("Commercial terms match for all 100 lanes.")).toBeVisible();
  await page.goto(proposalUrl);
  await expect(page.locator("#closeout").getByRole("status")).toHaveText("Proposal accepted · Kickoff booked");
});
