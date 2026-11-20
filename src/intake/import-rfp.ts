import { extname } from "node:path";
import { demoReviewerId, type AppDb } from "../db/client";
import { activityEvents, flightLegs, lanes, rfps, sourceFiles, transitSnapshots } from "../db/schema";
import {
  InvalidImport, laneSheetName, maxEmailBytes, maxWorkbookBytes, parseWorkbook, transitSheetName,
} from "./workbook";

export const sampleWorkbookName = "Air_Freight_RFP_Mock_Data.xlsx";

function validateFile(source: string, file: File, extension: string, maxBytes: number, sizeLabel: string) {
  if (extname(file.name).toLowerCase() !== extension || !file.size || file.size > maxBytes) {
    throw new InvalidImport([{ source, message: `Choose a nonempty ${extension} file up to ${sizeLabel}.` }]);
  }
}

async function readEmail(file: File) {
  validateFile("Shipper email", file, ".txt", maxEmailBytes, "256 KB");
  const content = Buffer.from(await file.arrayBuffer());
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
    if (text.trim() && !text.includes("\0")) return { content, text };
  } catch {
    // An invalid byte sequence is reported alongside other unsupported text files.
  }
  throw new InvalidImport([{ source: "Shipper email", message: "Choose a nonempty UTF-8 text file." }]);
}

export async function importRfp(db: AppDb, workbook: File, email: File | null, sample = false) {
  validateFile("Workbook", workbook, ".xlsx", maxWorkbookBytes, "5 MB");
  const workbookContent = Buffer.from(await workbook.arrayBuffer());
  const emailSource = email ? await readEmail(email) : null;
  const { lanes: laneRows, flights } = await parseWorkbook(workbookContent);
  const importedAt = new Date().toISOString();

  return db.transaction(async (tx) => {
    const { id: rfpId } = await tx.insert(rfps).values({
      title: sample ? "Sample air freight RFP" : workbook.name,
      reviewerId: demoReviewerId,
      importedAt,
    }).returning().get();
    const { id: sourceFileId } = await tx.insert(sourceFiles).values({
      rfpId,
      kind: "workbook",
      name: workbook.name,
      content: workbookContent,
    }).returning().get();

    if (email && emailSource) {
      await tx.insert(sourceFiles).values({
        rfpId, kind: "shipper_email", name: email.name, content: emailSource.content, emailText: emailSource.text,
      }).run();
    }

    const { id: snapshotId } = await tx.insert(transitSnapshots).values({
      rfpId, sourceFileId, sheetName: transitSheetName,
    }).returning().get();

    // Use small batches to stay within SQLite's bound-parameter limits.
    for (let i = 0; i < laneRows.length; i += 100) {
      await tx.insert(lanes).values(laneRows.slice(i, i + 100).map((row) => ({ rfpId, ...row }))).run();
    }
    for (let i = 0; i < flights.length; i += 100) {
      await tx.insert(flightLegs).values(flights.slice(i, i + 100).map((row) => ({ snapshotId, ...row }))).run();
    }

    await tx.insert(activityEvents).values([
      {
        rfpId, stage: "Read source files", status: "complete", sourceName: workbook.name,
        target: "sources", result: email ? `Original workbook and ${email.name} stored.` : "Original workbook stored.",
        nextAction: "Open the source files for import context.", occurredAt: importedAt,
      },
      {
        rfpId, stage: "Validate shipper lanes", status: "complete", sourceName: laneSheetName,
        target: "lanes", result: `${laneRows.length} shipper ${laneRows.length === 1 ? "lane" : "lanes"} imported.`,
        nextAction: "Inspect the lane details and original shipper notes.", occurredAt: importedAt,
      },
      {
        rfpId, stage: "Store transit snapshot", status: "complete", sourceName: transitSheetName,
        target: "transit", result: `${flights.length} directed flight ${flights.length === 1 ? "leg" : "legs"} stored.`,
        nextAction: "Inspect the captured flight inventory.", occurredAt: importedAt,
      },
    ]).run();

    return rfpId;
  }, { behavior: "immediate" });
}

export async function recordImportFailure(db: AppDb, sourceName: string, error: InvalidImport) {
  await db.insert(activityEvents).values({
    stage: "Validate upload",
    status: "failed",
    sourceName,
    result: "Import rejected. No RFP created.",
    nextAction: "Correct the listed errors, then upload again.",
    occurredAt: new Date().toISOString(),
    issues: error.issues,
  }).run();
}
