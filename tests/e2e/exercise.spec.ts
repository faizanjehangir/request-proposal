import { expect, test, type Locator } from "@playwright/test";
import Database from "better-sqlite3";
import { resolve } from "node:path";
import { sampleWorkbookName } from "../../src/intake/import-rfp";
import type { QuoteLane } from "../../src/quotes/contracts";

const airportLabel = (origin: string, destination: string) => `${origin} → ${destination}`;

async function openLane(routing: Locator, origin: string, destination: string) {
  await routing.getByLabel("Find a lane").fill(`${origin} to ${destination}`);
  const lane = routing.locator(".review-lane").filter({ hasText: airportLabel(origin, destination) });
  const summary = lane.locator(":scope > summary");
  if (await lane.getAttribute("open") === null) await summary.press("Enter");
  return lane;
}

async function saveDisposition(lane: Locator, disposition: "offer" | "alternative", reason = "") {
  await lane.getByText("Confirm disposition", { exact: true }).click();
  await lane.getByLabel("Lane disposition").selectOption(disposition);
  if (reason) await lane.getByLabel("Reason for an alternative or no offer").fill(reason);
  await lane.getByRole("button", { name: "Save disposition" }).click();
  await expect(lane.locator(".saved-disposition")).toContainText(disposition === "offer" ? "Compliant offer" : "Offer with disclosed gap");
}

test("the workbook becomes one accepted proposal and one simulated kickoff", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("RFP workbook").setInputFiles(resolve(sampleWorkbookName));
  await page.getByLabel("Shipper email").setInputFiles(resolve("fixtures/shipper-email.txt"));
  await page.getByRole("button", { name: "Import workbook", exact: true }).click();
  await page.waitForURL("**/rfps/*");
  const rfpId = Number(new URL(page.url()).pathname.split("/").at(-1));

  const routing = page.locator("#routing");
  const pricing = page.locator("#pricing");
  const quote = page.locator("#quote");
  const closeout = page.locator("#closeout");
  await expect(page.getByRole("region", { name: "Shipper lane table" }).locator("tbody tr")).toHaveCount(100);
  await routing.getByRole("button", { name: "Extract requirements and find routes" }).click();
  await expect(routing.getByText("Showing 100 of 100 lanes")).toBeVisible();
  await routing.getByLabel("Disposition filter").selectOption("decided");
  await expect(routing.getByText("No lanes match.", { exact: false })).toBeVisible();
  await routing.getByLabel("Disposition filter").selectOption("all");

  const mex = await openLane(routing, "MEX", "CDG");
  await expect(routing.getByText("Showing 1 of 100 lanes")).toBeVisible();
  await mex.getByText("Original requirement evidence", { exact: true }).click();
  await expect(mex.getByRole("link", { name: "shipper-email.txt" })).toHaveAttribute("href", "#shipper-email-source");
  await mex.getByText("Flight legs and service evidence", { exact: true }).click();
  await expect(mex.getByRole("link", { name: "Transit row 46" })).toHaveAttribute("href", "#flight-row-46");
  await expect(mex.getByText(/11 days/).first()).toBeVisible();
  await saveDisposition(mex, "offer");

  const gru = await openLane(routing, "GRU", "SIN");
  await expect(gru.getByText("Service gap", { exact: true })).toBeVisible();
  await saveDisposition(gru, "alternative", "The direct route will use standard handling. Fragile handling is unavailable.");

  await pricing.getByRole("button", { name: "Send simulated Pricing email" }).click();
  await pricing.getByRole("button", { name: "Simulate incomplete reply" }).click();
  await expect(pricing.getByRole("status")).toHaveText("1 of 2 rates matched · Quote blocked");
  await expect(quote.getByRole("button", { name: "Create quote draft" })).toHaveCount(0);

  await gru.getByText("Correct requirements", { exact: true }).click();
  await gru.getByLabel("Fragile handling", { exact: true }).uncheck();
  await gru.getByLabel("Correction reason").fill("Check the standard-handling route for this exercise.");
  await gru.getByRole("button", { name: "Save and reroute" }).click();
  await expect(pricing.getByRole("status")).toHaveText("Offer scope changed · Previous rates are stale");
  const updatedGru = await openLane(routing, "GRU", "SIN");
  const correction = updatedGru.locator("details.review-edit").filter({ hasText: "Correct requirements" });
  if (await correction.getAttribute("open") === null) await correction.locator(":scope > summary").click();
  await updatedGru.getByLabel("Fragile handling", { exact: true }).check();
  await updatedGru.getByLabel("Correction reason").fill("Restore the shipper’s fragile-handling request.");
  await updatedGru.getByRole("button", { name: "Save and reroute" }).click();
  await expect(updatedGru.getByText("Service gap", { exact: true })).toBeVisible();
  await saveDisposition(await openLane(routing, "GRU", "SIN"), "alternative", "Disclose that fragile handling is unavailable.");

  await routing.getByText("Mark remaining lanes as no offer", { exact: true }).click();
  await routing.getByLabel("Reason for marking these lanes as no offer").fill("No offer on this lane under the exercise proposal.");
  await routing.getByRole("button", { name: "Mark 98 lanes as no offer" }).click();
  await pricing.getByRole("button", { name: "Send updated Pricing request" }).click();
  await pricing.getByRole("button", { name: "Simulate complete reply" }).click();
  await expect(pricing.getByRole("status")).toHaveText("Rates ready for quote drafting");
  await pricing.getByRole("link", { name: "Open customer quote" }).click();

  await quote.getByRole("button", { name: "Create quote draft" }).click();
  await quote.getByRole("button", { name: "Approve quote v1" }).click();
  await quote.getByText("Edit email wording", { exact: true }).click();
  await quote.getByLabel("Opening", { exact: true }).fill("Hello from our air freight team.");
  await quote.getByRole("button", { name: "Save as new version" }).click();
  await expect(quote.getByRole("status")).toHaveText("Quote v2 awaiting approval");
  await expect(quote.getByRole("button", { name: "Send simulated quote" })).toHaveCount(0);
  const approvedBody = await quote.getByRole("region", { name: "Quote v2 email preview" }).textContent();
  expect(approvedBody).toContain("Requested services unavailable: Fragile handling");
  await quote.getByRole("button", { name: "Approve quote v2" }).click();
  await quote.getByRole("button", { name: "Send simulated quote" }).click();
  await expect(quote.getByRole("status")).toHaveText("Quote v2 delivered to the simulated customer");
  await quote.getByRole("link", { name: "Open acceptance and kickoff" }).click();

  await closeout.getByRole("button", { name: "Simulate partial acceptance" }).click();
  await expect(closeout.getByRole("status")).toHaveText("Partial acceptance · Human review needed");
  await expect(closeout.getByText(/View accepted proposal in SQLite/)).toHaveCount(0);
  await closeout.getByLabel("Simulate a temporary calendar failure").check();
  await closeout.getByRole("button", { name: "Simulate full acceptance" }).click();
  await expect(closeout.getByRole("status")).toHaveText("Proposal accepted · Kickoff scheduling failed");
  await closeout.getByRole("button", { name: "Retry kickoff scheduling" }).click();
  await expect(closeout.getByRole("status")).toHaveText("Proposal accepted · Kickoff booked");
  await closeout.getByRole("button", { name: "Replay acceptance reply" }).click();
  await expect(page.getByRole("heading", { name: "Replay existing acceptance" })).toBeVisible();
  await page.reload();
  await expect(closeout.getByRole("status")).toHaveText("Proposal accepted · Kickoff booked");
  await closeout.getByText(/View accepted proposal in SQLite/).click();
  await expect(closeout.getByRole("region", { name: "Accepted lane details" }).locator("tbody tr")).toHaveCount(100);

  const db = new Database(process.env.RFP_E2E_DB_PATH!, { readonly: true });
  try {
    const proposals = db.prepare("select id, body, lanes from accepted_proposals where rfpId = ?").all(rfpId) as
      { id: number; body: string; lanes: string }[];
    expect(proposals).toHaveLength(1);
    expect(proposals[0].body).toBe(approvedBody);
    const lanes = JSON.parse(proposals[0].lanes) as QuoteLane[];
    expect(lanes).toHaveLength(100);
    expect(lanes.find((lane) => lane.origin === "GRU" && lane.destination === "SIN")).toMatchObject({
      disposition: "alternative", unavailable: ["Fragile handling"], amountCents: 224000,
    });
    expect(db.prepare("select providerId from kickoff_invites where proposalId = ?").all(proposals[0].id)).toEqual([
      { providerId: `CAL-${proposals[0].id}` },
    ]);
    expect(db.prepare("select body from email_messages where rfpId = ? and messageKey like 'customer-quote-delivery:%'").all(rfpId))
      .toEqual([{ body: approvedBody }]);
  } finally {
    db.close();
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(closeout.getByRole("heading", { name: "Simulated kickoff invitation" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});
