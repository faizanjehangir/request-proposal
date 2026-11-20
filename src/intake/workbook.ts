import readExcelFile, { type CellValue, type Row, type Sheet } from "read-excel-file/node";
import { z } from "zod";
import type { ImportIssue } from "../db/schema";

export const laneSheetName = "Shipper RFP";
export const transitSheetName = "Transit Table";
export const maxWorkbookBytes = 5 * 1024 * 1024;
export const maxEmailBytes = 256 * 1024;
export const maxIssues = 30;
const maxDataRows = 5000;
type ExcelNumber = { numeric: string };

type Lane = {
  sourceRow: number;
  origin: string;
  destination: string;
  tons: string;
  maxTransitDays: string;
  shipperNote: string | null;
};
type Flight = {
  sourceRow: number;
  origin: string;
  destination: string;
  transitDays: string;
  services: string[];
};

export class InvalidImport extends Error {
  constructor(public readonly issues: ImportIssue[]) {
    super("Import could not be completed.");
    this.name = "InvalidImport";
  }
}

const airportSchema = z.string().regex(/^[A-Z]{3}$/);
const decimalSchemaPattern = /^\+?(\d*)(?:\.(\d+))?(?:e([+-]?\d+))?$/i;
const decimalSchema = z.string().max(64);

function textValue(value: CellValue<ExcelNumber> | null) {
  return typeof value === "string" ? value : null;
}

function positiveDecimal(value: CellValue<ExcelNumber> | null) {
  const raw = value && typeof value === "object" && "numeric" in value
    ? value.numeric
    : textValue(value)?.trim();
  const parsed = decimalSchema.safeParse(raw);
  if (!parsed.success) return null;

  const parts = parsed.data.match(decimalSchemaPattern);
  if (!parts) return null;
  const [, whole, fraction = "", exponent = "0"] = parts;
  const digits = whole + fraction;
  const offset = whole.length + Number(exponent);
  if (!/[1-9]/.test(digits) || !Number.isInteger(offset) || Math.abs(offset) > 64) return null;

  const padded = "0".repeat(Math.max(-offset, 0)) + digits;
  const split = Math.max(offset, 0);
  const integral = padded.slice(0, split).padEnd(split, "0").replace(/^0+/, "") || "0";
  const fractional = padded.slice(split).replace(/0+$/, "");
  return fractional ? `${integral}.${fractional}` : integral;
}

const originHeader = "Origin (airport)";
const destinationHeader = "Destination (airport)";
const tonsHeader = "Tons of freight";
const limitHeader = "Maximum transit time (days)";
const noteHeader = "Shipper email / special requirements";
const durationHeader = "Transit time (days)";
const servicesHeader = "Available special requirements";

function visitRows(
  workbook: Sheet<ExcelNumber>[],
  sheetName: string,
  requiredHeaders: string[],
  report: (issue: ImportIssue) => void,
  visit: (row: Row<ExcelNumber>, rowNumber: number, fields: Map<string, number>) => void,
) {
  const sheet = workbook.find((entry) => entry.sheet === sheetName)?.data;
  if (!sheet) {
    report({ source: sheetName, message: `Add the “${sheetName}” worksheet.` });
    return;
  }
  if (sheet.length > maxDataRows + 1) {
    report({ source: sheetName, message: `Keep the worksheet within ${maxDataRows.toLocaleString("en-US")} data rows.` });
    return;
  }

  const fieldNames = new Map([...requiredHeaders, noteHeader].map((name) => [name.toLowerCase(), name]));
  const fields = new Map<string, number>();
  let duplicateHeader = false;
  (sheet[0] ?? []).forEach((cell, column) => {
    const recognized = fieldNames.get(textValue(cell)?.trim().replace(/\s+/g, " ").toLowerCase() ?? "");
    if (!recognized) return;
    if (fields.has(recognized)) {
      duplicateHeader = true;
      report({ source: sheetName, row: 1, field: recognized, message: "Keep only one column with this header." });
    }
    fields.set(recognized, column);
  });

  const missing = requiredHeaders.filter((name) => !fields.has(name));
  for (const field of missing) {
    report({ source: sheetName, row: 1, field, message: `Add the “${field}” column.` });
  }
  if (missing.length || duplicateHeader) return;

  let dataRows = 0;
  sheet.slice(1).forEach((row, index) => {
    const hasData = [...fields.values()].some((column) => row[column] != null && textValue(row[column])?.trim() !== "");
    if (!hasData) return;
    dataRows++;
    visit(row, index + 2, fields);
  });
  if (!dataRows) report({ source: sheetName, message: "Add at least one data row below the headers." });
}

function readRow(row: Row<ExcelNumber>, fields: Map<string, number>, addIssue: (field: string, message: string) => void) {
  function value(field: string) {
    const column = fields.get(field);
    return column === undefined ? null : row[column] ?? null;
  }
  function airport(field: string) {
    const parsed = airportSchema.safeParse(textValue(value(field))?.trim().toUpperCase());
    if (parsed.success) return parsed.data;
    addIssue(field, "Enter a three-letter airport code.");
    return null;
  }
  function decimal(field: string) {
    const result = positiveDecimal(value(field));
    if (result === null) addIssue(field, "Enter a positive number.");
    return result;
  }
  function optionalText(field: string) {
    const raw = value(field);
    if (raw === null || raw === undefined) return null;
    const text = textValue(raw);
    if (text === null) addIssue(field, "Enter text or leave this cell empty.");
    return text;
  }

  const origin = airport(originHeader);
  const destination = airport(destinationHeader);
  if (origin && origin === destination) {
    addIssue(destinationHeader, "Use a destination different from the origin.");
  }
  return { origin, destination, decimal, optionalText };
}

export async function parseWorkbook(bytes: Buffer) {
  let workbook: Sheet<ExcelNumber>[];
  try {
    workbook = await readExcelFile(bytes, { trim: false, parseNumber: (numeric) => ({ numeric }) });
  } catch {
    throw new InvalidImport([{ source: "Workbook", message: "Choose a readable .xlsx workbook." }]);
  }

  const issues: ImportIssue[] = [];
  const lanes: Lane[] = [];
  const flights: Flight[] = [];
  const laneRows = new Map<string, number>();
  const report = (issue: ImportIssue) => {
    if (issues.length < maxIssues) issues.push(issue);
  };

  visitRows(workbook, laneSheetName, [originHeader, destinationHeader, tonsHeader, limitHeader], report, (row, rowNumber, fields) => {
    const addIssue = (field: string, message: string) => report({ source: laneSheetName, row: rowNumber, field, message });
    const { origin, destination, decimal, optionalText } = readRow(row, fields, addIssue);
    const tons = decimal(tonsHeader);
    const maxTransitDays = decimal(limitHeader);
    const shipperNote = optionalText(noteHeader);
    if (!origin || !destination || !tons || !maxTransitDays) return;

    const key = `${origin} → ${destination}`;
    const firstRow = laneRows.get(key);
    if (firstRow !== undefined) {
      addIssue(destinationHeader, `Lane ${key} already appears on row ${firstRow}.`);
      return;
    }
    laneRows.set(key, rowNumber);
    lanes.push({ sourceRow: rowNumber, origin, destination, tons, maxTransitDays, shipperNote });
  });

  visitRows(workbook, transitSheetName, [originHeader, destinationHeader, durationHeader, servicesHeader], report, (row, rowNumber, fields) => {
    const addIssue = (field: string, message: string) => report({ source: transitSheetName, row: rowNumber, field, message });
    const { origin, destination, decimal, optionalText } = readRow(row, fields, addIssue);
    const transitDays = decimal(durationHeader);
    const services = (optionalText(servicesHeader) ?? "").split(";").map((name) => name.trim()).filter(Boolean);
    if (origin && destination && transitDays) flights.push({ sourceRow: rowNumber, origin, destination, transitDays, services });
  });

  if (issues.length) throw new InvalidImport(issues);
  return { lanes, flights };
}
