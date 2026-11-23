import Papa from "papaparse";
import type { FileKind, ParsedSource, ProductResult } from "@/lib/types";
import { MAX_FILE_SIZE_BYTES, MAX_ROWS } from "@/lib/types";

const RESULT_HEADERS = ["Image URL", "Title", "EAN", "Pack", "Size", "Status"];
const RESULT_WIDTHS = [58, 44, 18, 12, 18, 16];

function textValue(value: unknown): string {
  return String(value ?? "").replace(/\u0000/g, "").trim();
}

export function normalizeEan(value: string): string | null {
  const compact = value.trim().replace(/[\s-]/g, "");
  return /^\d{8,14}$/.test(compact) ? compact : null;
}

function hasEanHeader(value: string): boolean {
  return /ean|gtin|upc|bar\s?code|barcode/i.test(value);
}

function findHeaderRow(rows: string[][]): { index: number; headerless: boolean; eanColumn: number } {
  const firstNonEmpty = rows.findIndex((row) => row.some((cell) => cell.trim()));
  if (firstNonEmpty < 0) {
    throw new Error("This file does not contain any rows to read.");
  }

  const searchEnd = Math.min(rows.length, firstNonEmpty + 10);
  for (let rowIndex = firstNonEmpty; rowIndex < searchEnd; rowIndex += 1) {
    const columnIndex = rows[rowIndex].findIndex(hasEanHeader);
    if (columnIndex >= 0) {
      return { index: rowIndex, headerless: false, eanColumn: columnIndex };
    }
  }

  const firstRowEanColumn = rows[firstNonEmpty].findIndex((cell) => normalizeEan(cell) !== null);
  if (firstRowEanColumn >= 0) {
    return { index: firstNonEmpty, headerless: true, eanColumn: firstRowEanColumn };
  }

  return { index: firstNonEmpty, headerless: false, eanColumn: 0 };
}

export async function parseSpreadsheet(file: File): Promise<ParsedSource> {
  if (file.size > MAX_FILE_SIZE_BYTES) {
    throw new Error("Files must be 5 MB or smaller.");
  }

  const extension = file.name.split(".").pop()?.toLowerCase();
  let fileKind: FileKind;
  let matrix: string[][];

  if (extension === "csv") {
    fileKind = "csv";
    const parsed = Papa.parse<string[]>(await file.text(), {
      skipEmptyLines: "greedy",
      dynamicTyping: false,
    });
    const fatalParseError = parsed.errors.find((error) => error.code === "MissingQuotes");
    if (fatalParseError) {
      throw new Error("The CSV has an unfinished quoted field. Please check the file and try again.");
    }
    matrix = parsed.data.map((row) => row.map(textValue));
  } else if (extension === "xlsx") {
    fileKind = "xlsx";
    const { default: ExcelJS } = await import("exceljs");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await file.arrayBuffer());
    const worksheet = workbook.worksheets[0];

    if (!worksheet) {
      throw new Error("This workbook does not contain a worksheet.");
    }
    if (worksheet.columnCount > 100) {
      throw new Error("The first worksheet has more than 100 columns. Please simplify it and try again.");
    }

    matrix = [];
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      matrix[rowNumber - 1] = Array.from({ length: worksheet.columnCount }, (_, index) =>
        textValue(row.getCell(index + 1).text),
      );
    });
  } else {
    throw new Error("Choose an .xlsx or .csv file.");
  }

  if (matrix.length > MAX_ROWS + 10) {
    throw new Error("This file has too many rows. A maximum of 500 data rows is supported per run.");
  }

  const { index: headerIndex, headerless, eanColumn } = findHeaderRow(matrix);
  const columnCount = Math.max(...matrix.map((row) => row?.length ?? 0));
  if (!columnCount || columnCount > 100) {
    throw new Error("This file needs between 1 and 100 columns.");
  }

  const headers = headerless
    ? Array.from({ length: columnCount }, (_, index) => `Column ${index + 1}`)
    : Array.from({ length: columnCount }, (_, index) =>
        matrix[headerIndex][index]?.trim() || `Column ${index + 1}`,
      );
  const dataStart = headerless ? headerIndex : headerIndex + 1;
  const rows = matrix
    .slice(dataStart)
    .filter((row) => row?.some((cell) => cell.trim()))
    .map((row) => Array.from({ length: columnCount }, (_, index) => row?.[index] ?? ""));

  if (!rows.length) {
    throw new Error("No data rows were found below the header.");
  }
  if (rows.length > MAX_ROWS) {
    throw new Error("A maximum of 500 data rows is supported per run.");
  }

  const detectedColumn = headerless
    ? eanColumn
    : headers.findIndex(hasEanHeader);

  return {
    fileName: file.name,
    fileKind,
    headers,
    rows,
    eanColumnIndex: detectedColumn >= 0 ? detectedColumn : 0,
    headerRowNumber: headerless ? null : headerIndex + 1,
  };
}

function safeSpreadsheetValue(value: string): string {
  const cleaned = value.replace(/[\u0000-\u0008]/g, "");
  return /^[\s]*[=+@\-]/.test(cleaned) ? `'${cleaned}` : cleaned;
}

function statusLabel(status: ProductResult["status"]): string {
  switch (status) {
    case "matched":
      return "Found";
    case "not-found":
      return "Not found";
    case "invalid":
      return "Invalid EAN";
    case "error":
      return "Lookup error";
    default:
      return "Pending";
  }
}

function exportRows(results: ProductResult[]): string[][] {
  return results.map((result) =>
    [
      result.imageUrl,
      result.title,
      result.ean,
      result.pack,
      result.size,
      statusLabel(result.status),
    ].map(safeSpreadsheetValue),
  );
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function baseFileName(fileName: string | undefined): string {
  const name = (fileName ?? "regal-results").replace(/\.[^.]+$/, "");
  return name.replace(/[^a-z0-9-_]+/gi, "-").replace(/^-+|-+$/g, "") || "regal-results";
}

export function downloadCsv(results: ProductResult[], fileName?: string): void {
  const csv = Papa.unparse([RESULT_HEADERS, ...exportRows(results)], { quotes: true });
  downloadBlob(
    new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }),
    `${baseFileName(fileName)}-regal-results.csv`,
  );
}

export async function downloadXlsx(
  results: ProductResult[],
  file: File | null,
  fileKind: FileKind | null,
): Promise<void> {
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();

  if (file && fileKind === "xlsx") {
    await workbook.xlsx.load(await file.arrayBuffer());
  }

  let sheetName = "Regal Results";
  let suffix = 2;
  while (workbook.getWorksheet(sheetName)) {
    sheetName = `Regal Results ${suffix}`;
    suffix += 1;
  }

  const worksheet = workbook.addWorksheet(sheetName, {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  worksheet.columns = RESULT_HEADERS.map((header, index) => ({
    header,
    key: `field${index}`,
    width: RESULT_WIDTHS[index],
  }));
  worksheet.addRows(exportRows(results));
  worksheet.autoFilter = {
    from: "A1",
    to: `F${Math.max(1, results.length + 1)}`,
  };
  worksheet.getRow(1).height = 24;
  worksheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  worksheet.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF1B2A4D" },
  };
  worksheet.getColumn(1).numFmt = "@";
  worksheet.getColumn(3).numFmt = "@";

  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([new Uint8Array(buffer)], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  downloadBlob(blob, `${baseFileName(file?.name)}-regal-results.xlsx`);
}
