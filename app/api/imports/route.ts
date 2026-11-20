import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getDb } from "@/src/db/client";
import { importRfp, recordImportFailure, sampleWorkbookName } from "@/src/intake/import-rfp";
import { InvalidImport, maxEmailBytes, maxWorkbookBytes } from "@/src/intake/workbook";

const maxRequestBytes = maxWorkbookBytes + maxEmailBytes + 64 * 1024;

async function readForm(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!request.body || !contentType.toLowerCase().startsWith("multipart/form-data;")) {
    throw new InvalidImport([{ source: "Upload", message: "Submit the files using the workbook upload form." }]);
  }

  let bytes = 0;
  let tooLarge = false;
  const limitedBody = request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > maxRequestBytes) {
        tooLarge = true;
        controller.error(new Error("Upload exceeds the size limit."));
      } else {
        controller.enqueue(chunk);
      }
    },
  }));

  try {
    return await new Response(limitedBody, { headers: { "content-type": contentType } }).formData();
  } catch {
    const message = tooLarge
      ? "Choose a workbook up to 5 MB and an optional shipper email up to 256 KB."
      : "The upload could not be read. Select the files and try again.";
    throw new InvalidImport([{ source: "Upload", message }]);
  }
}

function formFile(form: FormData, field: string, source: string) {
  const file = form.get(field);
  if (file === null || (file instanceof File && !file.name && !file.size)) return null;
  if (file instanceof File) return file;
  throw new InvalidImport([{ source, message: "Choose a file to upload." }]);
}

export async function POST(request: Request) {
  const db = await getDb();
  let sourceName = "Workbook upload";
  try {
    const form = await readForm(request);
    const sample = form.get("mode") === "sample";
    const workbook = sample
      ? new File([new Uint8Array(await readFile(resolve(sampleWorkbookName)))], sampleWorkbookName)
      : formFile(form, "workbook", "Workbook");
    if (!workbook) {
      throw new InvalidImport([{ source: "Workbook", message: "Choose an .xlsx workbook with both required sheets." }]);
    }
    sourceName = workbook.name;
    const email = formFile(form, "email", "Shipper email");
    const id = await importRfp(db, workbook, email, sample);
    return Response.json({ id }, { status: 201 });
  } catch (error) {
    if (error instanceof InvalidImport) {
      await recordImportFailure(db, sourceName, error);
      return Response.json({ message: error.message, issues: error.issues }, { status: 422 });
    }

    console.error("RFP import failed", error);
    return Response.json({ message: "The import could not be saved. Try again." }, { status: 500 });
  }
}
