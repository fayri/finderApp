"use client";

import {
  AlertCircle,
  ArrowUpRight,
  CheckCircle2,
  Download,
  Image as ImageIcon,
  LoaderCircle,
  RotateCw,
  SearchX,
} from "lucide-react";
import type { LookupProgress, ProductResult } from "@/lib/types";

interface ResultsPanelProps {
  results: ProductResult[];
  hasRun: boolean;
  isRunning: boolean;
  isRetryingErrors: boolean;
  retryableErrorCount: number;
  progress: LookupProgress;
  onCancel: () => void;
  onRetryErrors: () => void;
  onDownloadCsv: () => void;
  onDownloadXlsx: () => void;
}

function statusText(status: ProductResult["status"]): string {
  switch (status) {
    case "matched":
      return "Found";
    case "not-found":
      return "No match";
    case "invalid":
      return "Invalid EAN";
    case "error":
      return "Lookup error";
    default:
      return "Waiting";
  }
}

export function ResultsPanel({
  results,
  hasRun,
  isRunning,
  isRetryingErrors,
  retryableErrorCount,
  progress,
  onCancel,
  onRetryErrors,
  onDownloadCsv,
  onDownloadXlsx,
}: ResultsPanelProps) {
  const matched = results.filter((item) => item.status === "matched").length;
  const notFound = results.filter((item) => item.status === "not-found").length;
  const needsReview = results.filter((item) => ["invalid", "error", "pending"].includes(item.status)).length;
  const visibleResults = results.slice(0, 60);

  return (
    <section className="results-section" aria-labelledby="results-heading" aria-live="polite">
      <div className="results-heading-row">
        <div>
          <p className="section-kicker">02 / Product matches</p>
          <h2 id="results-heading">Your results</h2>
        </div>
        {hasRun && results.length > 0 && !isRunning ? (
          <div className={`export-actions${retryableErrorCount > 0 ? " export-actions-with-retry" : ""}`}>
            {retryableErrorCount > 0 ? (
              <button
                type="button"
                className="secondary-button"
                onClick={onRetryErrors}
                aria-label={`Retry ${retryableErrorCount} lookup ${retryableErrorCount === 1 ? "error" : "errors"}`}
                title="Retry failed lookups"
              >
                <RotateCw size={15} aria-hidden="true" />
                Retry ({retryableErrorCount})
              </button>
            ) : null}
            <button type="button" className="secondary-button" onClick={onDownloadCsv}>
              <Download size={16} /> CSV
            </button>
            <button type="button" className="primary-button export-button" onClick={onDownloadXlsx}>
              <Download size={16} /> Excel workbook
            </button>
          </div>
        ) : null}
      </div>

      {isRunning ? (
        <div className="progress-card" role="status">
          <div className="progress-topline">
            <div className="progress-title-wrap">
              <span className="progress-spinner" aria-hidden="true"><LoaderCircle size={17} /></span>
              <div>
                <strong>{isRetryingErrors ? "Retrying lookup errors" : "Checking Regal Sales"}</strong>
                <span>
                  {progress.completed} of {progress.total} EANs checked
                  {progress.currentEan ? ` · ${progress.currentEan}` : ""}
                </span>
              </div>
            </div>
            <button type="button" className="text-button" onClick={onCancel}>Stop lookup</button>
          </div>
          <div
            className="progress-track"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={progress.total}
            aria-valuenow={progress.completed}
            aria-label="EAN lookup progress"
          >
            <span style={{ width: `${progress.total ? (progress.completed / progress.total) * 100 : 0}%` }} />
          </div>
          <p className="progress-footnote">
            {progress.cooldownSeconds > 0
              ? `Respecting Regal Sales’ crawl delay · next search in ${progress.cooldownSeconds}s`
              : "Searching the public product catalogue…"}
          </p>
        </div>
      ) : null}

      {!hasRun ? (
        <div className="results-empty">
          <span className="empty-icon" aria-hidden="true"><ImageIcon size={21} /></span>
          <div>
            <strong>Product details will appear here</strong>
            <p>Upload a list, choose the EAN column, then start matching.</p>
          </div>
        </div>
      ) : results.length === 0 ? (
        <div className="results-empty">
          <span className="empty-icon" aria-hidden="true"><SearchX size={21} /></span>
          <div>
            <strong>No rows to show</strong>
            <p>Check the selected EAN column and try again.</p>
          </div>
        </div>
      ) : (
        <>
          <div className="result-stats" aria-label="Lookup summary">
            <div className="result-stat stat-found">
              <span className="stat-icon"><CheckCircle2 size={15} /></span>
              <span><strong>{matched}</strong><small>Found</small></span>
            </div>
            <div className="result-stat stat-missing">
              <span className="stat-icon"><SearchX size={15} /></span>
              <span><strong>{notFound}</strong><small>No match</small></span>
            </div>
            <div className="result-stat stat-review">
              <span className="stat-icon"><AlertCircle size={15} /></span>
              <span><strong>{needsReview}</strong><small>Needs review</small></span>
            </div>
            <p className="result-count">{results.length} {results.length === 1 ? "row" : "rows"} in this file</p>
          </div>

          <div className="table-scroll">
            <table className="results-table">
              <thead>
                <tr>
                  <th scope="col">Product</th>
                  <th scope="col">EAN</th>
                  <th scope="col">Pack</th>
                  <th scope="col">Size</th>
                  <th scope="col">Image URL</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {visibleResults.map((result, index) => (
                  <tr key={`${result.rowNumber}-${index}`}>
                    <td className="product-cell">
                      <span className="product-thumb">
                        {result.imageUrl ? (
                          // Regal Sales hosts the returned catalogue images; the adjacent title carries the product name.
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={result.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
                        ) : (
                          <ImageIcon size={17} aria-hidden="true" />
                        )}
                      </span>
                      <span className="product-name-wrap">
                        {result.productUrl && result.title ? (
                          <a className="product-name" href={result.productUrl} target="_blank" rel="noreferrer">
                            {result.title}<ArrowUpRight size={13} aria-hidden="true" />
                          </a>
                        ) : result.status === "error" || result.status === "not-found" ? (
                          <a
                            className="product-name"
                            href={`https://regalsales.co.uk/search?q=${encodeURIComponent(result.ean)}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Open Regal search<ArrowUpRight size={13} aria-hidden="true" />
                          </a>
                        ) : (
                          <span className="product-name">{result.title || "—"}</span>
                        )}
                        {result.note ? <small className="row-note">{result.note}</small> : null}
                      </span>
                    </td>
                    <td><code className="ean-value">{result.ean || "—"}</code></td>
                    <td>{result.pack || "—"}</td>
                    <td>{result.size || "—"}</td>
                    <td>
                      {result.imageUrl ? (
                        <a className="image-url" href={result.imageUrl} target="_blank" rel="noreferrer" title={result.imageUrl}>
                          {result.imageUrl}
                        </a>
                      ) : "—"}
                    </td>
                    <td><span className={`status-pill status-${result.status}`}>{statusText(result.status)}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {results.length > visibleResults.length ? (
            <p className="table-limit-note">Showing the first {visibleResults.length} rows. All rows are included in your export.</p>
          ) : null}
          <p className="results-disclaimer">
            Product images are from Regal Sales; descriptions, pack and size are from your uploaded file. Verify product details before using them commercially.
          </p>
        </>
      )}
    </section>
  );
}
