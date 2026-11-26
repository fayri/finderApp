"use client";

import { useId, useState } from "react";
import Image from "next/image";
import { BadgeCheck, Check, CircleHelp, ExternalLink, ImageOff, LoaderCircle, RotateCw, SearchX, ShieldAlert, X } from "lucide-react";
import type { AmazonMatchRow, AmazonOfferDetailsResponse, AmazonSearchCandidate } from "@/lib/amazon-types";
import { buildAmazonProductSearchQuery, buildAmazonSearchUrl } from "@/lib/amazon-search-url";
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
  return buildAmazonSearchUrl(
    buildAmazonProductSearchQuery({
      brand: result.brand,
      title: result.title,
      variant: result.variant,
      imageTerms: result.imageTerms,
      size: result.size,
    }),
  );
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
        {result.brandSource === "amazon" && result.brand ? (
          <p className="amazon-label-text"><strong>Brand found:</strong> {result.brand} from Amazon product details</p>
        ) : null}
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
        const isSingleItemFallback = label === "Pack" && candidate.packMatchType === "single-item-fallback";
        const packDifferenceAllowed = label === "Pack" && match === false;
        const state = match === true || packDifferenceAllowed ? "match" : match === false ? "mismatch" : "unknown";
        const stateLabel = packDifferenceAllowed
          ? "Allowed difference"
          : isSingleItemFallback
            ? "Single-item fallback"
            : match === true
              ? "Match"
              : match === false
                ? "Mismatch"
                : "Check";
        const displayValue = packDifferenceAllowed
          ? `${value} (pack count may differ)`
          : isSingleItemFallback
            ? `${value} (single-item fallback)`
            : value;
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
            <span>{displayValue}</span>
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
        amazonBrand: payload.amazonBrand.trim() || candidate.amazonBrand,
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
  const [isHovered, setIsHovered] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [isPinnedOpen, setIsPinnedOpen] = useState(false);
  const [isDismissed, setIsDismissed] = useState(false);
  const detailsId = useId();
  const displayTitle = candidate.amazonTitle || candidate.title;
  const sellerValue = candidate.seller || (candidate.listingDetailsChecked ? "Not shown" : "Not checked");
  const isExpanded = isPinnedOpen || ((isHovered || isFocused) && !isDismissed);
  const visualLabel = candidate.visualVerdict
    ? visualLabels[candidate.visualVerdict]
    : candidate.tier === "low"
      ? "Manual review"
      : `${candidate.tier} match`;

  function toggleDetails() {
    setIsPinnedOpen((isOpen) => {
      const nextOpen = !isOpen;
      setIsDismissed(!nextOpen);
      return nextOpen;
    });
  }

  return (
    <article
      className={`amazon-candidate-option${selected ? " is-selected" : ""}${isExpanded ? " is-open" : ""}`}
      aria-label={`Amazon listing: ${displayTitle}`}
      onMouseEnter={() => {
        setIsHovered(true);
        setIsDismissed(false);
      }}
      onMouseLeave={() => setIsHovered(false)}
      onFocusCapture={() => {
        setIsFocused(true);
        setIsDismissed(false);
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsFocused(false);
      }}
    >
      <div className="amazon-candidate-summary">
        <ImageFrame
          src={candidate.imageUrl}
          alt={`Amazon listing image: ${displayTitle}`}
          label={selected ? "Top match" : visualLabel}
        />
        <p className="amazon-candidate-title" title={displayTitle}>{displayTitle}</p>
        <div className="amazon-candidate-overview">
          <strong>{candidate.amazonUnitPrice ? `${candidate.amazonUnitPrice} / item` : candidate.price || "Price not found"}</strong>
          <span>{visualLabel}</span>
        </div>
        <div className="amazon-candidate-quick-checks" aria-label="Size and pack review">
          <span className={candidate.sizeMatch ? "is-match" : "is-review"}>Size {candidate.sizeMatch ? "match" : "review"}</span>
          <span className="is-match">
            Pack {candidate.packMatchType === "single-item-fallback" ? "single-item fallback" : candidate.packMatch === false ? "differs · allowed" : "match"}
          </span>
        </div>
        <button
          type="button"
          className="secondary-button amazon-candidate-toggle"
          aria-expanded={isExpanded}
          aria-controls={detailsId}
          onClick={toggleDetails}
        >
          {isExpanded ? "Hide details" : "View full details"}
        </button>
      </div>
      <div
        id={detailsId}
        className="amazon-candidate-popover"
        style={{
          position: "static",
          inset: "auto",
          width: "100%",
          maxHeight: "none",
          overflow: "visible",
          marginTop: 8,
          transform: "none",
        }}
        role="region"
        aria-label={`Full details for ${displayTitle}`}
        hidden={!isExpanded}
      >
        <div className="amazon-candidate-popover-heading">
          <p className="amazon-compare-label">AMAZON LISTING DETAILS</p>
          {selected ? <span className="amazon-top-match-label">Top match</span> : null}
        </div>
        <p className="amazon-candidate-title-full">{displayTitle}</p>
        {candidate.amazonTitle && candidate.amazonTitle !== candidate.title ? (
          <p className="amazon-candidate-search-title">Search result label: {candidate.title}</p>
        ) : null}
        <p className="amazon-candidate-detail">
          <span><strong>Brand:</strong> {candidate.amazonBrand || (candidate.listingDetailsChecked ? "Not shown" : "Not checked")}</span>
          <span><strong>Shipper / seller:</strong> {sellerValue}</span>
          <span><strong>Amazon listing price:</strong> {candidate.price || "Not found"}</span>
          <span><strong>Pack quantity in listing:</strong> {candidate.amazonPackBreakdown ?? candidate.amazonPackCount ?? "Not identified"}</span>
          <span><strong>ASIN:</strong> {candidate.asin || "Not available"}</span>
        </p>
        {candidate.amazonUnitPrice || candidate.supplierPackEquivalentPrice ? (
          <div className="amazon-unit-price">
            {candidate.amazonUnitPrice ? (
              <span><strong>Amazon price per item:</strong> {candidate.amazonUnitPrice}</span>
            ) : null}
            {candidate.supplierPackEquivalentPrice && result.pack ? (
              <span><strong>At supplier pack size ({result.pack}):</strong> {candidate.supplierPackEquivalentPrice}</span>
            ) : null}
            <small>Estimated from the listing price and pack count in the title (assumed one item when omitted).</small>
          </div>
        ) : null}
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
  const candidateOptions = result.candidates.length ? result.candidates : candidate ? [candidate] : [];
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
      ) : candidateOptions.length ? (
        <>
          <SourceProductReference result={result} />
          <section className="amazon-candidate-section" aria-label="Amazon listing matches">
            <div className="amazon-candidate-heading">
              <div>
                <h4>{candidate ? "Top Amazon matches" : "No confident match yet"}</h4>
                <p>
                  {candidate
                    ? `Scanned ${result.scannedCandidateCount ?? candidateOptions.length} listings. The known brand and supplied item size guide filtering; pack count may differ. Title and image evidence determine match confidence.`
                    : result.message || "Review the closest Amazon listings below."}
                </p>
              </div>
              <span>Top {candidateOptions.length} of {result.scannedCandidateCount ?? candidateOptions.length} scanned</span>
            </div>
            <div className="amazon-candidate-grid">
              {candidateOptions.map((option) => (
                <CandidateOption
                  key={option.asin || option.productUrl || option.title}
                  candidate={option}
                  selected={Boolean(candidate && candidate.asin === option.asin && candidate.productUrl === option.productUrl && candidate.title === option.title)}
                  fallbackSearchUrl={amazonSearchUrl(result)}
                  sourceTitle={sourceTitle}
                  result={result}
                  onDetails={(updated) => onCandidateDetails(result.rowNumber, updated)}
                  onSelect={() => onCandidateSelect(result.rowNumber, option)}
                />
              ))}
            </div>
          </section>
          {candidate ? (
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
          ) : null}
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
