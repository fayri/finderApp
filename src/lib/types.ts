export const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;
export const MAX_ROWS = 500;
export const MAX_UNIQUE_EANS = 50;

export type ResultStatus = "matched" | "not-found" | "invalid" | "error" | "pending";
export type FileKind = "csv" | "xlsx";

export interface ParsedSource {
  fileName: string;
  fileKind: FileKind;
  headers: string[];
  rows: string[][];
  eanColumnIndex: number;
  headerRowNumber: number | null;
}

export interface LookupResult {
  ean: string;
  imageUrl: string;
  title: string;
  pack: string;
  size: string;
  productUrl: string;
  status: "matched" | "not-found" | "error";
  note?: string;
}

export interface ProductResult extends Omit<LookupResult, "status"> {
  rowNumber: number;
  status: ResultStatus;
  note?: string;
}

export interface LookupProgress {
  completed: number;
  total: number;
  currentEan: string;
  cooldownSeconds: number;
}
