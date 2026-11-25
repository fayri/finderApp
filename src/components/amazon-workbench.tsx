"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { ToolNavigation } from "@/components/tool-navigation";
import {
  ArrowRight,
  Check,
  Clock3,
  Download,
  ExternalLink,
  FileSpreadsheet,
  FileText,
  ShieldCheck,
  Sparkles,
  Upload,
  X,
} from "lucide-react";
import Papa from "papaparse";
import { AmazonMatchCard } from "@/components/amazon-match-card";
import { AmazonSingleItemTest } from "@/components/amazon-single-item-test";
import type {
  AmazonMatchResponse,
  AmazonMatchRow,
  AmazonMatchStatus,
  AmazonProductInput,
  AmazonSearchCandidate,
} from "@/lib/amazon-types";
import type { ParsedSource } from "@/lib/types";
import { fallbackCategory } from "@/lib/amazon-categories";
import { getApiErrorMessage } from "@/lib/amazon-api-errors";
import { verifyAmazonCandidates } from "@/lib/amazon-visual-matching";
import { normalizeEan, parseSpreadsheet } from "@/lib/spreadsheet";

const MAX_PRODUCTS_PER_RUN = 100;
const MAX_CONCURRENT_PRODUCTS = 2;

interface ColumnMapping {
  ean: number;
  title: number | null;
  brand: number | null;
  variant: number | null;
  size: number | null;
  pack: number | null;
  image: number | null;
}

interface MappedProduct extends AmazonProductInput {
  rowNumber: number;
  key: string;
  category?: string;
}

interface AmazonProgress {
  completed: number;
  total: number;
  activeProducts: Array<{ key: string; title: string; stage: "label" | "search" | "visual" }>;
}

const initialProgress: AmazonProgress = { completed: 0, total: 0, activeProducts: [] };

function detectedColumn(headers: string[], pattern: RegExp): number | null {
  const index = headers.findIndex((header) => pattern.test(header.trim()));
  return index >= 0 ? index : null;
}

function initialMapping(source: ParsedSource): ColumnMapping {
  return {
    ean: source.eanColumnIndex,
    title: detectedColumn(source.headers, /description|product\s*name|item\s*name|title|^name$/i),
    brand: detectedColumn(source.headers, /^brand$|manufacturer/i),
    variant: detectedColumn(source.headers, /variant|flavou?r|scent|colour|color/i),
    size: detectedColumn(source.headers, /^size$|volume|weight|net\s*content/i),
    pack: detectedColumn(source.headers, /^pack$|pack\s*size|case\s*qty/i),
    image: detectedColumn(source.headers, /image|picture|photo|img/i),
  };
}

function cell(row: string[], index: number | null): string {
  return index === null ? "" : (row[index] ?? "").trim();
}

function cleanSupplierText(value: string): string {
  return value.replace(/\^+/g, "").replace(/\s+/g, " ").trim();
}

function mappedProducts(source: ParsedSource, mapping: ColumnMapping): MappedProduct[] {
  return source.rows.map((row, index) => {
    const rawEan = cell(row, mapping.ean);
    const input: AmazonProductInput = {
      ean: normalizeEan(rawEan) ?? "",
      title: cleanSupplierText(cell(row, mapping.title)).slice(0, 240),
      brand: cleanSupplierText(cell(row, mapping.brand)).slice(0, 120),
      variant: cleanSupplierText(cell(row, mapping.variant)).slice(0, 120),
      size: cleanSupplierText(cell(row, mapping.size)).slice(0, 80),
      pack: cleanSupplierText(cell(row, mapping.pack)).slice(0, 40),
      regalImageUrl: cell(row, mapping.image).slice(0, 2048),
    };
    const key = JSON.stringify([
      input.ean,
      input.title.toLowerCase(),
      input.brand.toLowerCase(),
      input.variant.toLowerCase(),
      input.size.toLowerCase(),
      input.pack.toLowerCase(),
      input.regalImageUrl,
    ]);
    return { ...input, rowNumber: index + 1, key };
  });
}

function uniqueProducts(products: MappedProduct[]): MappedProduct[] {
  const unique = new Map<string, MappedProduct>();
  for (const product of products) {
    if (!product.ean && !product.title) continue;
    if (!unique.has(product.key)) unique.set(product.key, product);
  }
  return Array.from(unique.values());
}

async function readImageLabelText(
  product: AmazonProductInput,
  signal: AbortSignal,
): Promise<{ imageTerms: string; warning: string }> {
  if (!product.regalImageUrl) return { imageTerms: "", warning: "" };

  try {
    const response = await fetch("/api/amazon/image-query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: product.title,
        size: product.size,
        pack: product.pack,
        imageUrl: product.regalImageUrl,
      }),
      signal,
    });
    const payload = (await response.json().catch(() => null)) as { labelText?: unknown } | null;
    if (!response.ok || !payload || typeof payload.labelText !== "string") {
      return {
        imageTerms: "",
        warning: "Image label reading was unavailable; matching continued with the supplied product details.",
      };
    }

    const imageTerms = payload.labelText.replace(/\s+/g, " ").trim().slice(0, 180);
    return {
      imageTerms,
      warning: imageTerms
        ? ""
        : "No readable product-label text was found; matching continued with the supplied product details.",
    };
  } catch (error) {
    if (signal.aborted) throw error;
    return {
      imageTerms: "",
      warning: "Image label reading was unavailable; matching continued with the supplied product details.",
    };
  }
}

function emptyRow(product: MappedProduct, status: AmazonMatchStatus, message: string): AmazonMatchRow {
  return {
    ...product,
    status,
    message,
    regalImageUrl: "",
    bestCandidate: null,
    candidates: [],
    decision: null,
  };
}

function formulaSafe(value: string): string {
  const cleaned = value.replace(/[\u0000-\u0008]/g, "");
  return /^[\s]*[=+@\-]/.test(cleaned) ? `'${cleaned}` : cleaned;
}

function sameAmazonListing(left: AmazonSearchCandidate, right: AmazonSearchCandidate): boolean {
  if (left.asin && right.asin) return left.asin === right.asin;
  if (left.productUrl && right.productUrl) return left.productUrl === right.productUrl;
  return left.title === right.title;
}

function downloadResults(results: AmazonMatchRow[], fileName: string): void {
  const headers = [
    "Row",
    "EAN",
    "Brand",
    "Product",
    "Image label text",
    "Variant",
    "Source size",
    "Pack",
    "Match tier",
    "Review decision",
    "Amazon title",
    "Amazon ASIN",
    "Amazon seller",
    "Amazon selling price",
    "AI visual review",
    "AI image match estimate",
    "Title match %",
    "Amazon URL",
    "Match notes",
  ];
  const rows = results.map((result) =>
    [
      String(result.rowNumber),
      result.ean,
      result.brand,
      result.title,
      result.imageTerms ?? "",
      result.variant,
      result.size,
      result.pack,
      result.status,
      result.decision ?? "",
      result.bestCandidate?.amazonTitle || result.bestCandidate?.title || "",
      result.bestCandidate?.asin ?? "",
      result.bestCandidate?.seller ?? "",
      result.bestCandidate?.price ?? "",
      result.bestCandidate?.visualVerdict ?? "",
      typeof result.bestCandidate?.imageMatchScore === "number"
        ? `${Math.round(result.bestCandidate.imageMatchScore)}%`
        : "",
      typeof result.bestCandidate?.titleWordCoverage === "number"
        ? `${Math.round(result.bestCandidate.titleWordCoverage * 100)}%`
        : "",
      result.bestCandidate?.productUrl ?? "",
      result.bestCandidate?.reason ?? result.message,
    ].map(formulaSafe),
  );
  const csv = Papa.unparse([headers, ...rows], { quotes: true });
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${fileName.replace(/\.[^.]+$/, "") || "amazon-matches"}-amazon-matches.csv`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ColumnSelect({
  field,
  label,
  required,
  source,
  value,
  onChange,
}: {
  field: keyof ColumnMapping;
  label: string;
  required?: boolean;
  source: ParsedSource;
  value: number | null;
  onChange: (field: keyof ColumnMapping, value: number | null) => void;
}) {
  return (
    <label className="amazon-column-field" htmlFor={`amazon-column-${field}`}>
      <span>{label}{required ? " *" : ""}</span>
      <select
        id={`amazon-column-${field}`}
        value={value ?? ""}
        onChange={(event) => onChange(field, event.target.value === "" ? null : Number(event.target.value))}
      >
        {!required ? <option value="">Not provided</option> : null}
        {source.headers.map((header, index) => (
          <option key={`${field}-${index}`} value={index}>
            {header || `Column ${index + 1}`}
          </option>
        ))}
      </select>
    </label>
  );
}

export function AmazonWorkbench({ buildVersion }: { buildVersion: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const [source, setSource] = useState<ParsedSource | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isParsing, setIsParsing] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [hasRun, setHasRun] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [results, setResults] = useState<AmazonMatchRow[]>([]);
  const [progress, setProgress] = useState<AmazonProgress>(initialProgress);
  const [retryingVisualRow, setRetryingVisualRow] = useState<number | null>(null);

  async function handleFile(file: File) {
    setErrorMessage("");
    setResults([]);
    setHasRun(false);
    setSource(null);
    setMapping(null);
    setUploadedFile(null);
    setIsParsing(true);
    try {
      const parsed = await parseSpreadsheet(file);
      setSource(parsed);
      setMapping(initialMapping(parsed));
      setUploadedFile(file);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "This file could not be read.");
    } finally {
      setIsParsing(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  function clearFile() {
    controllerRef.current?.abort();
    setIsRunning(false);
    setSource(null);
    setMapping(null);
    setUploadedFile(null);
    setResults([]);
    setHasRun(false);
    setErrorMessage("");
    setProgress(initialProgress);
    setRetryingVisualRow(null);
  }

  function updateMapping(field: keyof ColumnMapping, value: number | null) {
    if (!mapping) return;
    if (field === "ean" && value === null) return;
    setMapping({ ...mapping, [field]: value });
    setResults([]);
    setHasRun(false);
    setErrorMessage("");
  }

  async function startMatching() {
    if (!source || !mapping || isRunning) return;
    setErrorMessage("");
    const products = mappedProducts(source, mapping);
    const queue = uniqueProducts(products);
    if (!queue.length) {
      setErrorMessage("No EANs or product names were found in the mapped columns.");
      return;
    }
    if (queue.length > MAX_PRODUCTS_PER_RUN) {
      setErrorMessage(`This run has ${queue.length} unique products. Select a file with ${MAX_PRODUCTS_PER_RUN} or fewer unique products to keep Amazon requests paced.`);
      return;
    }

    const initialRows = products.map((product) =>
      emptyRow(product, product.ean || product.title ? "pending" : "not-found", product.ean || product.title ? "Waiting in the search queue." : "No EAN or product name in this row."),
    );
    const resultsByKey = new Map<string, AmazonMatchRow>();
    const controller = new AbortController();
    controllerRef.current = controller;
    setResults(initialRows);
    setHasRun(true);
    setIsRunning(true);
    setProgress({ completed: 0, total: queue.length, activeProducts: [] });

    try {
      const searchQueue = queue.map((product) => ({
        ...product,
        category: fallbackCategory(product.title),
      }));

      let nextIndex = 0;
      let stopAfterBlock = false;

      async function runWorker() {
        while (!controller.signal.aborted && !stopAfterBlock) {
          const index = nextIndex++;
          if (index >= searchQueue.length) return;

          const product = searchQueue[index];
          let completedProduct = false;
          setProgress((current) => ({
            ...current,
            activeProducts: [
              ...current.activeProducts,
              { key: product.key, title: product.title || product.ean, stage: product.regalImageUrl ? "label" : "search" },
            ],
          }));

          try {
            const labelResult = await readImageLabelText(product, controller.signal);
            if (controller.signal.aborted) return;
            const matchProduct = { ...product, imageTerms: labelResult.imageTerms };
            setProgress((current) => ({
              ...current,
              activeProducts: current.activeProducts.map((activeProduct) =>
                activeProduct.key === product.key ? { ...activeProduct, stage: "search" } : activeProduct,
              ),
            }));

            const response = await fetch("/api/amazon/match", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                ean: product.ean,
                title: product.title,
                brand: product.brand,
                variant: product.variant,
                size: product.size,
                pack: product.pack,
                category: product.category,
                image_terms: matchProduct.imageTerms,
                regal_image_url: product.regalImageUrl,
              }),
              signal: controller.signal,
            });
            const payload = await response.json().catch(() => null);
            if (controller.signal.aborted) return;
            if (!response.ok || !payload || typeof payload !== "object" || !("status" in payload)) {
              throw new Error(getApiErrorMessage(payload, "The Amazon matcher did not return product results.", response.status));
            }

            const matchPayload = payload as AmazonMatchResponse;
            setProgress((current) => ({
              ...current,
              activeProducts: current.activeProducts.map((activeProduct) =>
                activeProduct.key === product.key ? { ...activeProduct, stage: "visual" } : activeProduct,
              ),
            }));
            const verifiedMatch = await verifyAmazonCandidates(matchProduct, matchPayload, controller.signal);
            if (controller.signal.aborted) return;
            const rowResult: AmazonMatchRow = {
              ...matchProduct,
              status: verifiedMatch.status,
              message: [verifiedMatch.message, labelResult.warning].filter(Boolean).join(" "),
              regalImageUrl: verifiedMatch.regalImageUrl || product.regalImageUrl,
              bestCandidate: verifiedMatch.bestCandidate,
              candidates: verifiedMatch.candidates ?? [],
              scannedCandidateCount: matchPayload.scannedCandidateCount ?? matchPayload.candidates.length,
              decision: null,
            };
            resultsByKey.set(product.key, rowResult);
            setResults(products.map((item) => resultsByKey.get(item.key) ?? emptyRow(item, "pending", "Waiting in the search queue.")));
            completedProduct = true;

            if (matchPayload.status === "blocked") {
              stopAfterBlock = true;
              setErrorMessage("Amazon blocked this batch. New product searches have stopped; wait before retrying or review the Amazon links manually.");
              controller.abort();
            }
          } catch (error) {
            if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
            const rowResult: AmazonMatchRow = {
              ...product,
              status: "error",
              message:
                error instanceof TypeError && error.message === "Failed to fetch"
                  ? "Could not reach the Amazon matcher. Use the Amazon UK search link on this row to check it manually."
                  : error instanceof Error
                    ? error.message
                    : "The Amazon lookup failed. Open the Amazon UK search link to review this product.",
              regalImageUrl: product.regalImageUrl,
              bestCandidate: null,
              candidates: [],
              decision: null,
            };
            resultsByKey.set(product.key, rowResult);
            setResults(products.map((item) => resultsByKey.get(item.key) ?? emptyRow(item, "pending", "Waiting in the search queue.")));
            completedProduct = true;
          } finally {
            setProgress((current) => ({
              ...current,
              completed: current.completed + (completedProduct ? 1 : 0),
              activeProducts: current.activeProducts.filter((activeProduct) => activeProduct.key !== product.key),
            }));
          }
        }
      }

      await Promise.all(
        Array.from({ length: Math.min(MAX_CONCURRENT_PRODUCTS, searchQueue.length) }, () => runWorker()),
      );
    } catch (error) {
      if (!controller.signal.aborted) {
        setErrorMessage(error instanceof Error ? error.message : "The matching run could not be completed. Try again.");
      }
    } finally {
      setIsRunning(false);
      controllerRef.current = null;
      setResults(products.map((item) => resultsByKey.get(item.key) ?? emptyRow(item, "pending", "Not searched.")));
      setProgress((current) => ({ ...current, activeProducts: [] }));
    }
  }

  async function retryVisualMatch(rowNumber: number) {
    if (retryingVisualRow !== null) return;
    const sourceProduct = results.find((result) => result.rowNumber === rowNumber);
    if (!sourceProduct?.regalImageUrl || !sourceProduct.candidates.length) return;

    setRetryingVisualRow(rowNumber);
    try {
      const response: AmazonMatchResponse = {
        status: "low",
        message: "Retrying the required visual comparison.",
        regalImageUrl: sourceProduct.regalImageUrl,
        bestCandidate: null,
        candidates: sourceProduct.candidates,
        scannedCandidateCount: sourceProduct.scannedCandidateCount,
        searchedQueries: [],
      };
      const verified = await verifyAmazonCandidates(sourceProduct, response);
      setResults((current) => current.map((result) =>
        result.key === sourceProduct.key
          ? {
              ...result,
              status: verified.status,
              message: verified.message,
              bestCandidate: verified.bestCandidate,
              candidates: verified.candidates,
              decision: null,
            }
          : result,
      ));
    } catch (error) {
      setErrorMessage(error instanceof Error ? `Image check could not be retried: ${error.message}` : "Image check could not be retried.");
    } finally {
      setRetryingVisualRow(null);
    }
  }

  function updateDecision(rowNumber: number, decision: "confirmed" | "rejected") {
    setResults((current) =>
      current.map((result) => (result.rowNumber === rowNumber ? { ...result, decision } : result)),
    );
  }

  function updateCandidate(rowNumber: number, candidate: NonNullable<AmazonMatchRow["bestCandidate"]>) {
    setResults((current) =>
      current.map((result) =>
        result.rowNumber === rowNumber
          ? { ...result, status: candidate.tier, message: candidate.reason, bestCandidate: candidate, decision: null }
          : result,
      ),
    );
  }

  function updateCandidateDetails(rowNumber: number, candidate: AmazonSearchCandidate) {
    setResults((current) =>
      current.map((result) => {
        if (result.rowNumber !== rowNumber) return result;
        const matches = (existing: AmazonSearchCandidate) => sameAmazonListing(existing, candidate);
        const updatesBestCandidate = result.bestCandidate !== null && matches(result.bestCandidate);
        return {
          ...result,
          status: updatesBestCandidate ? candidate.tier : result.status,
          message: updatesBestCandidate ? candidate.reason : result.message,
          candidates: result.candidates.map((existing) => (matches(existing) ? candidate : existing)),
          bestCandidate: updatesBestCandidate ? candidate : result.bestCandidate,
        };
      }),
    );
  }

  const products = source && mapping ? mappedProducts(source, mapping) : [];
  const queueSize = uniqueProducts(products).length;
  const highCount = results.filter((result) => result.status === "high").length;
  const reviewCount = results.filter((result) => result.status === "medium" || result.status === "low").length;
  const notFoundCount = results.filter((result) => result.status === "not-found").length;
  const activeLabelCount = progress.activeProducts.filter((product) => product.stage === "label").length;
  const activeSearchCount = progress.activeProducts.filter((product) => product.stage === "search").length;
  const activeVisualCount = progress.activeProducts.filter((product) => product.stage === "visual").length;
  const activeProgressLabel = [
    activeLabelCount ? `Reading labels for ${activeLabelCount}` : "",
    activeSearchCount ? `Searching Amazon for ${activeSearchCount}` : "",
    activeVisualCount ? `Comparing images for ${activeVisualCount}` : "",
  ].filter(Boolean).join(" · ");

  return (
    <main className="page-shell amazon-page">
      <header className="topbar">
        <Link className="brand" href="/" aria-label="FinderApp home">
          <span className="brand-mark" aria-hidden="true"><Sparkles size={18} strokeWidth={2.3} /></span>
          <span className="brand-name">finder<span>app</span></span>
        </Link>
        <ToolNavigation active="amazon" buildVersion={buildVersion} />
      </header>

      <section className="hero" aria-labelledby="amazon-page-title">
        <div className="hero-copy">
          <p className="eyebrow"><span className="eyebrow-line" /> PRODUCT MATCH REVIEW</p>
          <h1 id="amazon-page-title">Find the right listing,<br /><span>then check the image.</span></h1>
          <p className="hero-description">
            Search Amazon UK from your EAN, product title, brand, variant and size. A confident match needs both a strong title match and strong visual evidence; an EAN alone cannot override a visual conflict.
          </p>
        </div>
        <div className="hero-note" aria-label="Search pacing note">
          <span className="hero-note-icon"><ShieldCheck size={18} /></span>
          <span><strong>Two products at a time</strong><small>Amazon searches stay 3 seconds apart and stop on CAPTCHA blocks.</small></span>
        </div>
      </section>

      <section className="workbench-card amazon-workbench" aria-label="Amazon product matching workspace">
        <div className="workbench-topline">
          <div>
            <p className="section-kicker">Amazon UK · image comparison</p>
            <h2>Upload a product spreadsheet</h2>
          </div>
          <div className="step-list" aria-label="Three-step process">
            <span className="step-item step-active"><b>1</b> Upload</span>
            <span className="step-connector" />
            <span className={`step-item${hasRun ? " step-active" : ""}`}><b>2</b> Match</span>
            <span className="step-connector" />
            <span className={`step-item${results.length && !isRunning ? " step-active" : ""}`}><b>3</b> Review</span>
          </div>
        </div>

        <AmazonSingleItemTest />

        <section className="upload-section" aria-labelledby="amazon-upload-title">
          <div className="upload-heading-row">
            <div>
              <p className="section-kicker">01 / Your source file</p>
              <h2 id="amazon-upload-title">Product list</h2>
            </div>
            <span className="quiet-tag">CSV or XLSX</span>
          </div>
          {source ? (
            <div className="source-card amazon-source-card">
              <div className="source-file-icon" aria-hidden="true">
                {source.fileKind === "xlsx" ? <FileSpreadsheet size={19} /> : <FileText size={19} />}
              </div>
              <div className="source-file-copy">
                <strong title={source.fileName}>{source.fileName}</strong>
                <span>{source.rows.length} data {source.rows.length === 1 ? "row" : "rows"} · header on row {source.headerRowNumber ?? "not detected"}</span>
              </div>
              <span className="ready-check" aria-label="File ready"><Check size={15} /></span>
              <button type="button" className="icon-button remove-file" onClick={clearFile} disabled={isRunning} aria-label="Remove uploaded file" title="Remove file">
                <X size={17} />
              </button>
            </div>
          ) : (
            <div
              className={`upload-dropzone${isDragging ? " is-dragging" : ""}${isParsing || isRunning ? " is-disabled" : ""}`}
              onDragEnter={(event) => {
                event.preventDefault();
                if (!isParsing && !isRunning) setIsDragging(true);
              }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsDragging(false);
              }}
              onDrop={(event) => {
                event.preventDefault();
                setIsDragging(false);
                if (!isParsing && !isRunning) {
                  const file = event.dataTransfer.files.item(0);
                  if (file) void handleFile(file);
                }
              }}
            >
              <input
                ref={inputRef}
                id="amazon-spreadsheet-file"
                className="visually-hidden"
                type="file"
                accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
                onChange={(event) => {
                  const file = event.currentTarget.files?.item(0);
                  if (file) void handleFile(file);
                }}
                disabled={isParsing || isRunning}
              />
              <span className="upload-icon" aria-hidden="true">{isParsing ? <span className="spinner" /> : <Upload size={20} />}</span>
              <div className="upload-copy">
                <p className="upload-title">{isParsing ? "Reading your file…" : "Drop your file here"}</p>
                <p className="upload-description">or <label htmlFor="amazon-spreadsheet-file">browse to upload</label></p>
              </div>
              <span className="upload-format-note">.xlsx or .csv · up to 5 MB</span>
            </div>
          )}
          <p className="privacy-note">Files stay in this browser. Mapped product fields and source image URLs are sent to the matcher; linked images may be analyzed by AI to read label text.</p>
        </section>

        {source && mapping ? (
          <div className="amazon-mapping-section">
            <div className="amazon-mapping-heading">
              <div>
                <p className="section-kicker">02 / Match fields</p>
                <h3>Confirm the columns</h3>
              </div>
              <span className="quiet-tag">{source.rows.length} source rows</span>
            </div>
            <div className="amazon-column-grid">
              <ColumnSelect field="ean" label="EAN / barcode" required source={source} value={mapping.ean} onChange={updateMapping} />
              <ColumnSelect field="title" label="Product title" source={source} value={mapping.title} onChange={updateMapping} />
              <ColumnSelect field="brand" label="Brand" source={source} value={mapping.brand} onChange={updateMapping} />
              <ColumnSelect field="variant" label="Variant" source={source} value={mapping.variant} onChange={updateMapping} />
              <ColumnSelect field="size" label="Size" source={source} value={mapping.size} onChange={updateMapping} />
              <ColumnSelect field="pack" label="Pack" source={source} value={mapping.pack} onChange={updateMapping} />
              <ColumnSelect field="image" label="Regal/source image" source={source} value={mapping.image} onChange={updateMapping} />
            </div>
          </div>
        ) : null}

        {errorMessage ? <p className="inline-error" role="alert">{errorMessage}</p> : null}

        <div className="match-options amazon-match-options">
          <div className="crawl-note">
            <Clock3 size={17} aria-hidden="true" />
            <span>
              Supplier ^ marks are removed before matching. Category only expands search. Every returned result on a searched Amazon page is compared before the five strongest options are shown; image evidence leads, with title, size, and pack checks retained for review. A single Amazon item can be compared with a supplier multipack using per-item and pack-equivalent prices. A confident result still needs a strong title match (at least 90% meaningful-word coverage), strong visual evidence (at least 85%), and no brand, variant, or size conflict; an EAN cannot override a visual mismatch. Two products are processed at once, Amazon requests remain at least 3 seconds apart, and CAPTCHA/rate-limit responses stop the batch. Up to {MAX_PRODUCTS_PER_RUN} unique products per run.
            </span>
          </div>
          <button type="button" className="primary-button start-button" onClick={startMatching} disabled={!source || isParsing || isRunning || queueSize === 0}>
            {isRunning ? "Searching…" : "Start matching"}
            {!isRunning ? <ArrowRight size={17} /> : null}
          </button>
        </div>
        {source && queueSize > 0 ? (
          <p className="run-estimate">{queueSize} unique {queueSize === 1 ? "product" : "products"} · duplicate rows share a result · up to five Amazon searches per product</p>
        ) : null}

        {isRunning ? (
          <div className="progress-card amazon-progress-card" role="status" aria-live="polite">
            <div className="progress-topline">
              <div className="progress-title-wrap">
                <span className="progress-spinner"><Clock3 size={15} /></span>
                <div>
                  <strong>Searching Amazon UK</strong>
                  <span>{activeProgressLabel || "Preparing Amazon search queries"}</span>
                </div>
              </div>
              <button type="button" className="text-button" onClick={() => controllerRef.current?.abort()}>Stop</button>
            </div>
            <div className="progress-track" aria-label={`${progress.completed} of ${progress.total} products checked`}>
              <span style={{ width: `${progress.total ? (progress.completed / progress.total) * 100 : 0}%` }} />
            </div>
            <p className="progress-footnote">{progress.completed} of {progress.total} products checked. Amazon searches remain at least 3 seconds apart. A result is not saved until you download it.</p>
          </div>
        ) : null}

        {hasRun ? (
          <>
            <div className="section-divider" />
            <div className="results-heading-row amazon-results-heading">
              <div>
                <p className="section-kicker">03 / Match review</p>
                <h2>Compare the images and listing details</h2>
              </div>
              <button type="button" className="secondary-button export-button" onClick={() => downloadResults(results, uploadedFile?.name ?? "amazon-matches")} disabled={!results.length}>
                <Download size={15} aria-hidden="true" /> Export CSV
              </button>
            </div>
            <div className="amazon-summary-grid" aria-label="Match summary">
              <div className="amazon-summary-card summary-high"><strong>{highCount}</strong><span>High · EAN evidence</span></div>
              <div className="amazon-summary-card summary-review"><strong>{reviewCount}</strong><span>Medium / low · review</span></div>
              <div className="amazon-summary-card summary-missing"><strong>{notFoundCount}</strong><span>Not found</span></div>
              <span className="result-count">{results.length} source {results.length === 1 ? "row" : "rows"}</span>
            </div>
            <div className="amazon-results-list">
              {results.map((result) => (
                <AmazonMatchCard
                  key={`${result.rowNumber}-${result.key}`}
                  result={result}
                  onDecision={updateDecision}
                  onCandidateSelect={updateCandidate}
                  onCandidateDetails={updateCandidateDetails}
                  onRetryVisual={retryVisualMatch}
                  isVisualRetrying={retryingVisualRow === result.rowNumber}
                  isVisualRetryBusy={retryingVisualRow !== null}
                />
              ))}
            </div>
            <p className="results-disclaimer amazon-disclaimer">
              Title match measures source-title word coverage; image match is an independent AI visual estimate, not a probability. Load each Amazon listing&apos;s full title, seller, and current page price for manual review before confirming. Amazon prices can change. High matches require an exact EAN in the Amazon result text.
            </p>
          </>
        ) : (
          <>
            <div className="section-divider" />
            <div className="results-empty">
              <span className="empty-icon"><ExternalLink size={18} /></span>
              <div><strong>Your Amazon comparison will appear here</strong><p>Upload a product list, confirm its columns, then start matching.</p></div>
            </div>
          </>
        )}
      </section>

      <footer className="page-footer">
        <span>finderapp <span className="footer-separator">/</span> Regal lookup + Amazon listing review</span>
        <span>Marketplace results can be unavailable or rate-limited. <a href="https://www.amazon.co.uk" target="_blank" rel="noreferrer">Open Amazon UK <ExternalLink size={11} /></a></span>
      </footer>
    </main>
  );
}
