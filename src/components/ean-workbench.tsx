"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, Clock3, ShieldCheck, Sparkles } from "lucide-react";
import { ResultsPanel } from "@/components/results-panel";
import { ToolNavigation } from "@/components/tool-navigation";
import { UploadPanel } from "@/components/upload-panel";
import { downloadCsv, downloadXlsx, normalizeEan, parseSpreadsheet } from "@/lib/spreadsheet";
import type { LookupProgress, LookupResult, ParsedSource, ProductResult } from "@/lib/types";
import { MAX_UNIQUE_EANS } from "@/lib/types";

const emptyProgress: LookupProgress = {
  completed: 0,
  total: 0,
  currentEan: "",
  cooldownSeconds: 0,
};

function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Lookup stopped", "AbortError"));
      return;
    }
    const timeout = window.setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      window.clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      reject(new DOMException("Lookup stopped", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function lookupEan(
  ean: string,
  signal: AbortSignal,
  onCooldown: (seconds: number) => void,
): Promise<LookupResult> {
  while (!signal.aborted) {
    const response = await fetch("/api/lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ean }),
      signal,
    });
    const payload = (await response.json().catch(() => null)) as
      | { result?: LookupResult; error?: string; retryAfterSeconds?: number }
      | null;

    if (response.status === 429) {
      const retryAfter = Math.max(
        1,
        Number(response.headers.get("Retry-After")) || Number(payload?.retryAfterSeconds) || 10,
      );
      for (let remaining = retryAfter; remaining > 0; remaining -= 1) {
        onCooldown(remaining);
        await waitFor(1_000, signal);
      }
      onCooldown(0);
      continue;
    }

    if (!response.ok || !payload?.result) {
      throw new Error(payload?.error || "The product lookup could not be completed.");
    }
    return payload.result;
  }

  throw new DOMException("Lookup stopped", "AbortError");
}

function makeRows(
  source: ParsedSource,
  resultsByEan: Map<string, LookupResult>,
  keepPending: boolean,
): ProductResult[] {
  const titleColumnIndex = source.headers.findIndex((header) =>
    /^(description|product(?: name)?|item(?: name)?|name)$/i.test(header.trim()),
  );
  const packColumnIndex = source.headers.findIndex((header) => header.trim().toLowerCase() === "pack");
  const sizeColumnIndex = source.headers.findIndex((header) => header.trim().toLowerCase() === "size");

  return source.rows.map((row, index) => {
    const rawEan = row[source.eanColumnIndex]?.trim() ?? "";
    const normalizedEan = normalizeEan(rawEan);
    const title = titleColumnIndex >= 0 ? row[titleColumnIndex]?.trim() ?? "" : "";
    const pack = packColumnIndex >= 0 ? row[packColumnIndex]?.trim() ?? "" : "";
    const size = sizeColumnIndex >= 0 ? row[sizeColumnIndex]?.trim() ?? "" : "";

    if (!normalizedEan) {
      return {
        rowNumber: index + 1,
        ean: rawEan,
        imageUrl: "",
        title,
        pack,
        size,
        productUrl: "",
        status: "invalid",
        note: rawEan ? "Use 8–14 digits" : "EAN cell is empty",
      };
    }

    const match = resultsByEan.get(normalizedEan);
    if (match) return { ...match, rowNumber: index + 1, title, pack, size };

    return {
      rowNumber: index + 1,
      ean: normalizedEan,
      imageUrl: "",
      title,
      pack,
      size,
      productUrl: "",
      status: keepPending ? "pending" : "not-found",
      note: keepPending ? undefined : "",
    };
  });
}

export function EanWorkbench() {
  const [source, setSource] = useState<ParsedSource | null>(null);
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [isParsing, setIsParsing] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [isRetryingErrors, setIsRetryingErrors] = useState(false);
  const [hasRun, setHasRun] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [results, setResults] = useState<ProductResult[]>([]);
  const [progress, setProgress] = useState<LookupProgress>(emptyProgress);
  const controllerRef = useRef<AbortController | null>(null);

  async function handleFile(file: File) {
    setErrorMessage("");
    setResults([]);
    setHasRun(false);
    setSource(null);
    setUploadedFile(null);
    setProgress(emptyProgress);
    setIsParsing(true);
    try {
      const parsed = await parseSpreadsheet(file);
      setSource(parsed);
      setUploadedFile(file);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "This file could not be read.");
    } finally {
      setIsParsing(false);
    }
  }

  function clearFile() {
    controllerRef.current?.abort();
    setIsRunning(false);
    setSource(null);
    setUploadedFile(null);
    setResults([]);
    setHasRun(false);
    setErrorMessage("");
    setProgress(emptyProgress);
  }

  function changeColumn(index: number) {
    if (!source) return;
    setSource({ ...source, eanColumnIndex: index });
    setResults([]);
    setHasRun(false);
    setErrorMessage("");
  }

  async function runLookupBatch(
    currentSource: ParsedSource,
    eans: string[],
    resultsByEan: Map<string, LookupResult>,
    retryingErrors = false,
  ) {
    const controller = new AbortController();
    controllerRef.current = controller;
    setHasRun(true);
    setIsRunning(true);
    setIsRetryingErrors(retryingErrors);
    setProgress({ completed: 0, total: eans.length, currentEan: "", cooldownSeconds: 0 });
    setResults(makeRows(currentSource, resultsByEan, true));

    try {
      for (let index = 0; index < eans.length; index += 1) {
        if (controller.signal.aborted) break;
        const ean = eans[index];
        setProgress({ completed: index, total: eans.length, currentEan: ean, cooldownSeconds: 0 });

        try {
          const result = await lookupEan(ean, controller.signal, (cooldownSeconds) => {
            setProgress({ completed: index, total: eans.length, currentEan: ean, cooldownSeconds });
          });
          resultsByEan.set(ean, result);
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") break;
          resultsByEan.set(ean, {
            ean,
            imageUrl: "",
            title: "",
            pack: "",
            size: "",
            productUrl: "",
            status: "error",
            note: error instanceof Error ? error.message : "Lookup failed",
          });
          const detail = error instanceof Error ? error.message : "Lookup failed.";
          setErrorMessage(`Could not check ${ean}: ${detail}`);
        }

        setResults(makeRows(currentSource, resultsByEan, true));
        setProgress({ completed: index + 1, total: eans.length, currentEan: "", cooldownSeconds: 0 });
      }
    } finally {
      setIsRunning(false);
      setIsRetryingErrors(false);
      controllerRef.current = null;
      setResults(makeRows(currentSource, resultsByEan, controller.signal.aborted));
      setProgress((current) => ({ ...current, currentEan: "", cooldownSeconds: 0 }));
    }
  }

  async function startLookup() {
    if (!source || isRunning) return;
    setErrorMessage("");

    const validEans = Array.from(
      new Set(source.rows.map((row) => normalizeEan(row[source.eanColumnIndex] ?? "")).filter(Boolean)),
    ) as string[];
    if (!validEans.length) {
      setErrorMessage("No valid EANs were found in that column. Choose another column or check the file.");
      return;
    }
    if (validEans.length > MAX_UNIQUE_EANS) {
      setErrorMessage(`This run contains ${validEans.length} unique EANs. Choose a file or column with ${MAX_UNIQUE_EANS} or fewer unique EANs.`);
      return;
    }

    await runLookupBatch(source, validEans, new Map());
  }

  async function retryLookupErrors() {
    if (!source || isRunning) return;
    setErrorMessage("");

    const failedEans = Array.from(
      new Set(
        results
          .filter((result) => result.status === "error")
          .map((result) => normalizeEan(result.ean))
          .filter((ean): ean is string => ean !== null),
      ),
    );
    if (!failedEans.length) return;

    const resultsByEan = new Map<string, LookupResult>();
    for (const result of results) {
      if (result.status !== "matched" && result.status !== "not-found" && result.status !== "error") continue;
      resultsByEan.set(result.ean, {
        ean: result.ean,
        imageUrl: result.imageUrl,
        title: result.title,
        pack: result.pack,
        size: result.size,
        productUrl: result.productUrl,
        status: result.status,
        note: result.note,
      });
    }
    failedEans.forEach((ean) => resultsByEan.delete(ean));

    await runLookupBatch(source, failedEans, resultsByEan, true);
  }

  const uniqueEanCount = source
    ? new Set(source.rows.map((row) => normalizeEan(row[source.eanColumnIndex] ?? "")).filter(Boolean)).size
    : 0;
  const retryableErrorCount = new Set(
    results
      .filter((result) => result.status === "error")
      .map((result) => normalizeEan(result.ean))
      .filter((ean): ean is string => ean !== null),
  ).size;

  async function handleDownloadXlsx() {
    try {
      await downloadXlsx(results, uploadedFile, source?.fileKind ?? null);
    } catch {
      setErrorMessage("The Excel workbook could not be created. Try downloading the CSV instead.");
    }
  }

  return (
    <main className="page-shell">
      <header className="topbar">
        <Link className="brand" href="/" aria-label="FinderApp home">
          <span className="brand-mark" aria-hidden="true"><Sparkles size={18} strokeWidth={2.3} /></span>
          <span className="brand-name">finder<span>app</span></span>
        </Link>
        <ToolNavigation active="regal" />
      </header>

      <section className="hero" aria-labelledby="page-title">
        <div className="hero-copy">
          <p className="eyebrow"><span className="eyebrow-line" /> SIMPLE PRODUCT MATCH</p>
          <h1 id="page-title">Product details,<br /><span>matched by barcode.</span></h1>
          <p className="hero-description">
            Match EANs against Regal Sales for product images. Product descriptions, pack and size come from your uploaded spreadsheet.
          </p>
        </div>
        <div className="hero-note" aria-label="Privacy note">
          <span className="hero-note-icon"><ShieldCheck size={18} /></span>
          <span><strong>Private by design</strong><small>Your spreadsheet stays in your browser.</small></span>
        </div>
      </section>

      <section className="workbench-card" aria-label="EAN product matching workspace">
        <div className="workbench-topline">
          <div>
            <p className="section-kicker">A simple product match</p>
            <h2>Start with your spreadsheet</h2>
          </div>
          <div className="step-list" aria-label="Three-step process">
            <span className="step-item step-active"><b>1</b> Upload</span>
            <span className="step-connector" />
            <span className={`step-item${hasRun ? " step-active" : ""}`}><b>2</b> Match</span>
            <span className="step-connector" />
            <span className={`step-item${results.length && !isRunning ? " step-active" : ""}`}><b>3</b> Export</span>
          </div>
        </div>

        <UploadPanel
          source={source}
          isParsing={isParsing}
          disabled={isRunning}
          onFile={handleFile}
          onColumnChange={changeColumn}
          onClear={clearFile}
        />

        {errorMessage ? <p className="inline-error" role="alert">{errorMessage}</p> : null}

        <div className="match-options">
          <div className="crawl-note">
            <Clock3 size={17} aria-hidden="true" />
            <span>
              Regal Sales requests a 10-second gap between searches. Pacing is per app instance; if its catalogue blocks server lookups, use the Regal search link. Up to {MAX_UNIQUE_EANS} unique EANs per run.
            </span>
          </div>
          <button
            type="button"
            className="primary-button start-button"
            onClick={startLookup}
            disabled={!source || isParsing || isRunning || uniqueEanCount === 0}
          >
            {isRunning ? "Matching…" : "Start matching"}
            {!isRunning ? <ArrowRight size={17} /> : null}
          </button>
        </div>
        {source && uniqueEanCount > 0 ? (
          <p className="run-estimate">
            {uniqueEanCount} unique {uniqueEanCount === 1 ? "EAN" : "EANs"} selected · uncached searches may take about {Math.max(0, uniqueEanCount - 1) * 10} seconds or longer.
          </p>
        ) : null}

        <div className="section-divider" />
        <ResultsPanel
          results={results}
          hasRun={hasRun}
          isRunning={isRunning}
          isRetryingErrors={isRetryingErrors}
          retryableErrorCount={retryableErrorCount}
          progress={progress}
          onCancel={() => controllerRef.current?.abort()}
          onRetryErrors={retryLookupErrors}
          onDownloadCsv={() => downloadCsv(results, uploadedFile?.name)}
          onDownloadXlsx={handleDownloadXlsx}
        />
      </section>

      <footer className="page-footer">
        <span>finderapp <span className="footer-separator">/</span> Product data, without the copy-paste</span>
        <span>Product images are sourced from <a href="https://regalsales.co.uk" target="_blank" rel="noreferrer">regalsales.co.uk</a>; descriptions, pack and size come from your file.</span>
      </footer>
    </main>
  );
}
