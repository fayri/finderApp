"use client";

import { useState } from "react";
import Image from "next/image";
import { BadgeCheck, Check, CircleHelp, ExternalLink, ImageOff, LoaderCircle, RotateCw, SearchX, ShieldAlert, X } from "lucide-react";
import type { AmazonMatchRow, AmazonOfferDetailsResponse, AmazonSearchCandidate } from "@/lib/amazon-types";
import { buildAmazonSearchUrl } from "@/lib/amazon-search-url";
import { updateAmazonTitleMatch } from "@/lib/amazon-visual-matching";

interface AmazonMatchCardProps {
  result: AmazonMatchRow;
  onDecision: (rowNumber: number, decision: "confirmed" | "rejected") => void;
  onCandidateSelect: (rowNumber: number, candidate: AmazonSearchCandidate) => void;
  onCandidateDetails: (rowNumber: number, candidate: AmazonSearchCandidate) => void;
  onRetryVisual: (rowNumber: number) => void;
  isVisualRetrying: boolean;
  isVisualRetryBusy: boolean;
}

const visualLabels = {
  strong: "Strong visual match",
  possible: "Possible visual match",
  different: "Visual conflict",
  uncertain: "Visual review inconclusive",
  unavailable: "Visual review unavailable",
} as const;

const statusLabels = {
  high: "High match",
  medium: "Medium · review",
  low: "Low · review",
  "not-found": "Not found",
  blocked: "Amazon blocked",
  error: "Lookup error",
  pending: "Queued",
} as const;

function amazonSearchUrl(result: AmazonMatchRow): string {
  const query = [result.title, result.imageTerms].filter(Boolean).join(" ");
  return buildAmazonSearchUrl(query);
}

function imageSource(src: string): string {
  try {
    const url = new URL(src);
    if (
      url.protocol === "https:" &&
      ["regalsales.co.uk", "www.regalsales.co.uk"].includes(url.hostname) &&
      url.pathname.startsWith("/product/image/")
    ) {
      return `/api/amazon/source-image?url=${encodeURIComponent(url.toString())}`;
    }
  } catch {
    return src;
  }
  return src;
}

function ImageFrame({ src, alt, label }: { src: string; alt: string; label: string }) {
  const [hasImageError, setHasImageError] = useState(false);

  return (
    <div className="amazon-image-frame">
      {src && !hasImageError ? (
        <Image
          src={imageSource(src)}
          alt={alt}
          width={420}
          height={420}
          sizes="(max-width: 560px) 100vw, 50vw"
          unoptimized
          onError={() => setHasImageError(true)}
        />
      ) : (
        <span className="amazon-image-empty" role="img" aria-label={src ? "Product image failed to load" : "No image available"}>
          <ImageOff size={19} aria-hidden="true" />
          <span>{src ? "Could not load image" : "No image"}</span>
        </span>
      )}
      <span className="amazon-image-label">{hasImageError ? "Image unavailable" : label}</span>
    </div>
  );
}

function SourceProductReference({ result }: { result: AmazonMatchRow }) {
  const sourceDetails = [
    result.brand && `Brand ${result.brand}`,
    result.variant && `Variant ${result.variant}`,
    result.size && `Size ${result.size}`,
    result.pack && `Pack ${result.pack}`,
    result.ean && `EAN ${result.ean}`,
  ].filter(Boolean);

  return (
    <section className="amazon-source-reference" aria-label="Supplier product to match">
      <div className="amazon-source-reference-image">
        <p className="amazon-compare-label">SUPPLIER IMAGE</p>
        <ImageFrame
          src={result.regalImageUrl}
          alt={`Supplier product image for ${result.title || result.ean}`}
          label={result.regalImageUrl ? "Regal Sales image" : "Image unavailable"}
        />
      </div>
      <div className="amazon-source-reference-copy">
        <p className="amazon-compare-label">TITLE TO MATCH</p>
        <h4>{result.title || "No supplier title provided"}</h4>
        {sourceDetails.length ? <p className="amazon-compare-detail">{sourceDetails.join(" · ")}</p> : null}
        {result.imageTerms ? <p className="amazon-label-text"><strong>Label read:</strong> {result.imageTerms}</p> : null}
        {!result.regalImageUrl ? (
          <p className="amazon-source-image-warning" role="status">
            Image matching is required, but no supplier image was available for this row.
          </p>
        ) : null}
      </div>
    </section>
  );
}

function AttributeMatchSummary({ result, candidate }: { result: AmazonMatchRow; candidate: AmazonSearchCandidate }) {
  const attributes = [
    { label: "Brand", value: result.brand, match: candidate.brandMatch },
    { label: "Variant", value: result.variant, match: candidate.variantMatch },
    { label: "Size", value: result.size, match: candidate.sizeMatch },
    { label: "Pack", value: result.pack, match: candidate.packMatch },
  ].filter(({ value }) => value.trim());

  if (!attributes.length) return null;

  return (
    <div className="amazon-attribute-checks" role="list" aria-label="Quick supplier attribute checks">
      {attributes.map(({ label, value, match }) => {
        const state = match === true ? "match" : match === false ? "mismatch" : "unknown";
        const stateLabel = match === true ? "Match" : match === false ? "Mismatch" : "Check";
        return (
          <span
            key={label}
            role="listitem"
            className={`amazon-attribute-check amazon-attribute-${state}`}
            aria-label={`Supplier ${label} ${value}: ${stateLabel.toLowerCase()} against the Amazon listing`}
            title={`Supplier ${label} ${value} · ${stateLabel.toLowerCase()} against the Amazon listing`}
          >
            {match === true ? <Check size={13} aria-hidden="true" /> : null}
            {match === false ? <X size={13} aria-hidden="true" /> : null}
            {match === undefined ? <CircleHelp size={13} aria-hidden="true" /> : null}
            <strong>{label}</strong>
            <span>{value}</span>
            <span className="amazon-attribute-status">{stateLabel}</span>
          </span>
        );
      })}
    </div>
  );
}

function RetryVisualButton({
  onClick,
  isRetrying,
  busy,
}: {
  onClick: () => void;
  isRetrying: boolean;
  busy: boolean;
}) {
  return (
    <button
      type="button"
      className="secondary-button amazon-retry-visual"
      onClick={onClick}
      disabled={busy}
      aria-busy={isRetrying}
    >
      {isRetrying ? <LoaderCircle size={13} className="amazon-detail-spinner" aria-hidden="true" /> : <RotateCw size={13} aria-hidden="true" />}
      {isRetrying ? "Checking images…" : "Retry image check"}
    </button>
  );
}

function AmazonDetailsButton({
  candidate,
  sourceTitle,
  onDetails,
}: {
  candidate: AmazonSearchCandidate;
  sourceTitle: string;
  onDetails: (candidate: AmazonSearchCandidate) => void;
}) {
  const [isLoading, setIsLoading] = useState(false);

  async function loadDetails() {
    if (!candidate.asin || isLoading) return;
    setIsLoading(true);
    try {
      const response = await fetch("/api/amazon/offer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ asin: candidate.asin }),
      });
      const payload = (await response.json().catch(() => null)) as AmazonOfferDetailsResponse | null;
      if (!response.ok || !payload) {
        throw new Error("Could not read Amazon listing details. Open the listing to verify them manually.");
      }

      const amazonTitle = payload.amazonTitle.trim();
      const updatedCandidate = updateAmazonTitleMatch(sourceTitle, {
        ...candidate,
        amazonTitle: amazonTitle || candidate.amazonTitle,
        seller: payload.seller.trim() || candidate.seller,
        price: payload.price.trim() || candidate.price,
        listingDetailsChecked: true,
        listingDetailsMessage: payload.message,
      });
      onDetails(updatedCandidate);
    } catch (error) {
      onDetails({
        ...candidate,
        listingDetailsChecked: true,
        listingDetailsMessage: error instanceof Error ? error.message : "Could not read Amazon listing details.",
      });
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <button
      type="button"
      className="secondary-button amazon-details-button"
      onClick={loadDetails}
      disabled={isLoading || !candidate.asin}
      aria-busy={isLoading}
      title={candidate.asin ? undefined : "Amazon did not provide an ASIN for this listing."}
    >
      {isLoading ? <LoaderCircle size={13} className="amazon-detail-spinner" aria-hidden="true" /> : null}
      {isLoading ? "Checking Amazon…" : candidate.listingDetailsChecked ? "Refresh page details" : "Read Amazon page details"}
    </button>
  );
}

function ScoreMetric({
  label,
  percentage,
  help,
  emptyLabel = "Not scored",
}: {
  label: string;
  percentage: number | null;
  help?: string;
  emptyLabel?: string;
}) {
  const value = percentage === null ? emptyLabel : `${Math.round(percentage)}%`;
  return (
    <div
      className={`amazon-score-metric${percentage === null ? " amazon-score-metric-empty" : ""}`}
      aria-label={`${label}: ${value}`}
      title={help}
    >
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function CandidateOption({
  candidate,
  selected,
  onSelect,
  onDetails,
  sourceTitle,
  fallbackSearchUrl,
  result,
}: {
  candidate: AmazonSearchCandidate;
  selected: boolean;
  onSelect: () => void;
  onDetails: (candidate: AmazonSearchCandidate) => void;
  sourceTitle: string;
  fallbackSearchUrl: string;
  result: AmazonMatchRow;
}) {
  const displayTitle = candidate.amazonTitle || candidate.title;
  const sellerValue = candidate.seller || (candidate.listingDetailsChecked ? "Not shown" : "Not checked");
  return (
    <article className={`amazon-candidate-option${selected ? " is-selected" : ""}`} aria-label={`Amazon listing: ${displayTitle}`}>
      <ImageFrame
        src={candidate.imageUrl}
        alt={`Amazon listing image: ${candidate.title}`}
        label={
          selected
            ? "Selected"
            : candidate.visualVerdict
              ? visualLabels[candidate.visualVerdict]
              : candidate.tier === "low"
                ? "Manual review option"
                : `${candidate.tier} match`
        }
      />
      <p className="amazon-candidate-title" title={displayTitle}>{displayTitle}</p>
      {candidate.amazonTitle && candidate.amazonTitle !== candidate.title ? (
        <p className="amazon-candidate-search-title">Search result label: {candidate.title}</p>
      ) : null}
      <p className="amazon-candidate-detail">
        <span><strong>Shipper / seller:</strong> {sellerValue}</span>
        <span><strong>Price:</strong> {candidate.price || "Not found"}</span>
        <span>ASIN {candidate.asin || "not available"}</span>
      </p>
      <AttributeMatchSummary result={result} candidate={candidate} />
      <div className="amazon-candidate-scores" aria-label="Independent match scores">
        <ScoreMetric label="Title match" percentage={typeof candidate.titleWordCoverage === "number" ? candidate.titleWordCoverage * 100 : null} />
        <ScoreMetric
          label="Image match"
          percentage={typeof candidate.imageMatchScore === "number" ? candidate.imageMatchScore : null}
          emptyLabel="Check failed"
          help="Visual evidence is required; an unavailable or inconclusive image check cannot confirm this listing."
        />
      </div>
      {candidate.visualReason ? <p className="amazon-candidate-visual-reason">{candidate.visualReason}</p> : null}
      {candidate.listingDetailsMessage ? <p className="amazon-details-message" role="status">{candidate.listingDetailsMessage}</p> : null}
      <div className="amazon-candidate-actions">
        <a className="amazon-product-link" href={candidate.productUrl || fallbackSearchUrl} target="_blank" rel="noreferrer">
          Open listing <ExternalLink size={13} aria-hidden="true" />
        </a>
        <AmazonDetailsButton candidate={candidate} sourceTitle={sourceTitle} onDetails={onDetails} />
        <button
          type="button"
          className="secondary-button amazon-select-candidate"
          onClick={onSelect}
          aria-label={selected ? `${displayTitle} is selected` : `Use ${displayTitle} as the Amazon match`}
          aria-pressed={selected}
        >
          {selected ? "Selected" : "Use this listing"}
        </button>
      </div>
    </article>
  );
}

export function AmazonMatchCard({
  result,
  onDecision,
  onCandidateSelect,
  onCandidateDetails,
  onRetryVisual,
  isVisualRetrying,
  isVisualRetryBusy,
}: AmazonMatchCardProps) {
  const candidate = result.bestCandidate;
  const isReview = result.status === "medium" || result.status === "low";
  const needsVisualRetry = Boolean(
    result.regalImageUrl && result.candidates.some((option) => typeof option.imageMatchScore !== "number"),
  );
  const headingId = result.rowNumber === 0 ? "amazon-single-item-result" : `amazon-row-${result.rowNumber}`;
  const rowLabel = result.rowNumber === 0 ? "SINGLE ITEM" : `ROW ${result.rowNumber.toString().padStart(2, "0")}`;
  const sourceTitle = [result.brand, result.title, result.variant].filter(Boolean).join(" ");

  return (
    <article className={`amazon-result-card amazon-result-${result.status}`} aria-labelledby={headingId}>
      <div className="amazon-result-topline">
        <div>
          <p className="amazon-row-number">{rowLabel}</p>
          <h3 id={headingId}>{result.title || result.brand || result.ean || "Untitled product"}</h3>
          <p className="amazon-result-meta">
            {result.ean ? <span>EAN <code>{result.ean}</code></span> : <span>No EAN supplied</span>}
            {result.size ? <span>Size {result.size}</span> : null}
            {result.pack ? <span>Pack {result.pack}</span> : null}
          </p>
        </div>
        <span className={`amazon-status amazon-status-${result.status}`}>
          {result.status === "high" ? <BadgeCheck size={14} aria-hidden="true" /> : null}
          {result.status === "blocked" || result.status === "error" ? <ShieldAlert size={14} aria-hidden="true" /> : null}
          {statusLabels[result.status]}
        </span>
      </div>
      <div className="amazon-result-links">
        {needsVisualRetry ? (
          <RetryVisualButton
            onClick={() => onRetryVisual(result.rowNumber)}
            isRetrying={isVisualRetrying}
            busy={isVisualRetryBusy}
          />
        ) : null}
        <a className="amazon-product-link" href={amazonSearchUrl(result)} target="_blank" rel="noreferrer">
          Search Amazon UK in browser <ExternalLink size={13} aria-hidden="true" />
        </a>
      </div>

      {result.status === "pending" ? (
        <p className="amazon-result-message">Waiting for its turn in the search queue.</p>
      ) : result.status === "not-found" ? (
        <div className="amazon-no-match">
          <SearchX size={18} aria-hidden="true" />
          <div>
            <strong>No Amazon listings found</strong>
            <p>{result.message}</p>
          </div>
        </div>
      ) : result.status === "blocked" || result.status === "error" ? (
        <p className="amazon-result-message" role={result.status === "blocked" ? "status" : "alert"}>{result.message}</p>
      ) : candidate ? (
        <>
          <div className="amazon-compare-grid">
            <section className="amazon-compare-panel" aria-label="Supplier product to match">
              <p className="amazon-compare-label">SUPPLIER IMAGE TO MATCH</p>
              <ImageFrame
                src={result.regalImageUrl}
                alt={`Supplier product image for ${result.title || result.ean}`}
                label={result.regalImageUrl ? "Regal Sales image" : "Image unavailable"}
              />
              <p className="amazon-compare-label amazon-source-title-label">TITLE TO MATCH</p>
              <p className="amazon-compare-title">{result.title || "No title in source file"}</p>
              {result.imageTerms ? <p className="amazon-label-text"><strong>Label read:</strong> {result.imageTerms}</p> : null}
              <p className="amazon-compare-detail">{[result.brand, result.variant, result.size, result.pack && `Pack ${result.pack}`].filter(Boolean).join(" · ") || "No additional source details supplied"}</p>
              {!result.regalImageUrl ? (
                <p className="amazon-source-image-warning" role="status">
                  Image matching is required, but no supplier image was available for this row.
                </p>
              ) : null}
            </section>
            <section className="amazon-compare-panel" aria-label="Amazon UK candidate">
              <div className="amazon-compare-heading">
                <p className="amazon-compare-label">AMAZON UK CANDIDATE</p>
                <div className="amazon-match-score-list" aria-label="Independent match scores">
                  <ScoreMetric label="Title match" percentage={typeof candidate.titleWordCoverage === "number" ? candidate.titleWordCoverage * 100 : null} />
                  <ScoreMetric
                    label="Image match"
                    percentage={typeof candidate.imageMatchScore === "number" ? candidate.imageMatchScore : null}
                    emptyLabel="Check failed"
                    help="Visual evidence is required; an unavailable or inconclusive image check cannot confirm this listing."
                  />
                </div>
              </div>
              <ImageFrame
                src={candidate.imageUrl}
                alt={`Amazon listing image: ${candidate.amazonTitle || candidate.title}`}
                label="Amazon listing"
              />
              <p className="amazon-compare-title">{candidate.amazonTitle || candidate.title}</p>
              {candidate.amazonTitle && candidate.amazonTitle !== candidate.title ? (
                <p className="amazon-candidate-search-title">Search result label: {candidate.title}</p>
              ) : null}
              <p className="amazon-compare-detail">
                <span><strong>Shipper / seller:</strong> {candidate.seller || (candidate.listingDetailsChecked ? "Not shown" : "Not checked")}</span>
                <span><strong>Price:</strong> {candidate.price || "Not found"}</span>
                <span>ASIN {candidate.asin || "not available"}</span>
              </p>
              <AttributeMatchSummary result={result} candidate={candidate} />
              {candidate.listingDetailsMessage ? <p className="amazon-details-message" role="status">{candidate.listingDetailsMessage}</p> : null}
              <div className="amazon-listing-actions">
                <AmazonDetailsButton
                  candidate={candidate}
                  sourceTitle={sourceTitle}
                  onDetails={(updated) => onCandidateDetails(result.rowNumber, updated)}
                />
                <a className="amazon-product-link" href={candidate.productUrl || amazonSearchUrl(result)} target="_blank" rel="noreferrer">
                  Open listing <ExternalLink size={13} aria-hidden="true" />
                </a>
              </div>
              {candidate.visualVerdict ? <p className="amazon-visual-verdict">AI visual check: {visualLabels[candidate.visualVerdict]}</p> : null}
            </section>
          </div>

          {result.candidates.length > 1 ? (
            <section className="amazon-candidate-section" aria-label="Similar Amazon listings">
              <div className="amazon-candidate-heading">
                <div>
                  <h4>Top Amazon options</h4>
                  <p>Title and image scores are separate. Compare the full listing details before choosing.</p>
                </div>
                <span>{result.candidates.length} options</span>
              </div>
              <div className="amazon-candidate-grid">
                {result.candidates.map((option) => (
                  <CandidateOption
                    key={option.asin || option.productUrl || option.title}
                    candidate={option}
                    selected={candidate.asin === option.asin && candidate.productUrl === option.productUrl && candidate.title === option.title}
                    fallbackSearchUrl={amazonSearchUrl(result)}
                    sourceTitle={sourceTitle}
                    result={result}
                    onDetails={(updated) => onCandidateDetails(result.rowNumber, updated)}
                    onSelect={() => onCandidateSelect(result.rowNumber, option)}
                  />
                ))}
              </div>
            </section>
          ) : null}

          <div className="amazon-result-bottomline">
            <p className="amazon-match-reason">{candidate.reason}</p>
            {isReview ? (
              <div className="amazon-review-actions" aria-label="Review match">
                <button
                  type="button"
                  className={`secondary-button amazon-review-button${result.decision === "confirmed" ? " is-selected" : ""}`}
                  onClick={() => onDecision(result.rowNumber, "confirmed")}
                  aria-pressed={result.decision === "confirmed"}
                >
                  <Check size={14} aria-hidden="true" /> Confirm
                </button>
                <button
                  type="button"
                  className={`secondary-button amazon-review-button${result.decision === "rejected" ? " is-rejected" : ""}`}
                  onClick={() => onDecision(result.rowNumber, "rejected")}
                  aria-pressed={result.decision === "rejected"}
                >
                  <X size={14} aria-hidden="true" /> Reject
                </button>
              </div>
            ) : (
              <span className="amazon-auto-note">{result.status === "high" ? "EAN evidence found" : "No manual review needed"}</span>
            )}
          </div>
        </>
      ) : result.candidates.length ? (
        <>
          <SourceProductReference result={result} />
          <section className="amazon-candidate-section" aria-label="Amazon options for manual review">
            <div className="amazon-candidate-heading">
              <div>
                <h4>No confident match yet</h4>
                <p>{result.message || "No listing passed both the title and image checks. Review the options below."}</p>
              </div>
              <span>{result.candidates.length} options</span>
            </div>
            <div className="amazon-candidate-grid">
              {result.candidates.map((option) => (
                <CandidateOption
                  key={option.asin || option.productUrl || option.title}
                  candidate={option}
                  selected={false}
                  fallbackSearchUrl={amazonSearchUrl(result)}
                  sourceTitle={sourceTitle}
                  result={result}
                  onDetails={(updated) => onCandidateDetails(result.rowNumber, updated)}
                  onSelect={() => onCandidateSelect(result.rowNumber, option)}
                />
              ))}
            </div>
          </section>
        </>
      ) : (
        <p className="amazon-result-message">{result.message || "The result is ready for review."}</p>
      )}

      {isReview && result.decision ? (
        <p className={`amazon-decision-note${result.decision === "rejected" ? " is-rejected" : ""}`} role="status">
          {result.decision === "confirmed" ? "Confirmed by reviewer." : "Rejected by reviewer."}
        </p>
      ) : null}
    </article>
  );
}
