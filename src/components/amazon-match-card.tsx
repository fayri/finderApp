"use client";

import { useId, useState } from "react";
import Image from "next/image";
import { BadgeCheck, Check, CircleHelp, ExternalLink, ImageOff, LoaderCircle, RotateCw, SearchX, ShieldAlert, X, ChevronDown, CheckSquare, Square, ChevronUp } from "lucide-react";
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

function titleWithSize(title: string, size: string): string {
  const cleanTitle = title.trim();
  const cleanSize = size.trim();
  const compactTitle = cleanTitle.toLowerCase().replace(/[^a-z0-9]/g, "");
  const compactSize = cleanSize.toLowerCase().replace(/[^a-z0-9]/g, "");
  return cleanSize && !compactTitle.includes(compactSize) ? `${cleanTitle} ${cleanSize}`.trim() : cleanTitle;
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

function ImageFrame({ src, alt, label, width = 120, height = 120 }: { src: string; alt: string; label: string; width?: number; height?: number }) {
  const [hasImageError, setHasImageError] = useState(false);

  return (
    <div className="amazon-image-frame" style={{ width, height }}>
      {src && !hasImageError ? (
        <Image
          src={imageSource(src)}
          alt={alt}
          width={width}
          height={height}
          sizes={`${width}px`}
          unoptimized
          onError={() => setHasImageError(true)}
          style={{ objectFit: "contain", backgroundColor: "#f8f9fa" }}
        />
      ) : (
        <div className="amazon-image-empty" role="img" aria-label={src ? "Product image failed to load" : "No image available"} style={{ width, height, display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: "#f8f9fa", border: "1px solid #e2e8f0", borderRadius: "8px" }}>
          <ImageOff size={20} aria-hidden="true" />
        </div>
      )}
      <span className="amazon-image-label" style={{ fontSize: "10px", color: "#64748b", marginTop: "4px", display: "block", textAlign: "center" }}>{hasImageError ? "Image unavailable" : label}</span>
    </div>
  );
}

function SourceProductReference({ result }: { result: AmazonMatchRow }) {
  const sourceDetails = [
    result.brand && `Brand: ${result.brand}`,
    result.variant && `Variant: ${result.variant}`,
    result.pack && `Pack: ${result.pack}`,
    result.ean && `EAN: ${result.ean}`,
  ].filter(Boolean);

  return (
    <div className="amazon-source-reference" style={{ display: "flex", gap: "20px", padding: "16px", backgroundColor: "#f8fafc", borderRadius: "12px", border: "1px solid #e2e8f0", marginBottom: "16px" }}>
      <div className="amazon-source-reference-image" style={{ flexShrink: 0 }}>
        <p className="amazon-compare-label" style={{ fontSize: "11px", fontWeight: 600, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "8px" }}>SUPPLIER IMAGE</p>
        <ImageFrame
          src={result.regalImageUrl}
          alt={`Supplier product image for ${result.title || result.ean}`}
          label={result.regalImageUrl ? "Regal Sales image" : "Image unavailable"}
          width={140}
          height={140}
        />
      </div>
      <div className="amazon-source-reference-copy" style={{ flex: 1, minWidth: 0 }}>
        <p className="amazon-compare-label" style={{ fontSize: "11px", fontWeight: 600, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "8px" }}>TITLE + ITEM SIZE TO MATCH</p>
        <h4 style={{ margin: "0 0 12px 0", fontSize: "16px", fontWeight: 600, color: "#1e293b" }}>{titleWithSize(result.title || "No supplier title provided", result.size)}</h4>

        {sourceDetails.length ? <p className="amazon-compare-detail" style={{ color: "#475569", fontSize: "13px", margin: "0 0 8px 0" }}>{sourceDetails.join(" · ")}</p> : null}
        {result.brandSource === "amazon" && result.brand ? (
          <p className="amazon-label-text" style={{ color: "#059669", fontSize: "13px", margin: "0 0 8px 0" }}><strong>Brand found:</strong> {result.brand} from Amazon product details</p>
        ) : null}
        {result.imageTerms ? <p className="amazon-label-text" style={{ color: "#0369a1", fontSize: "13px", margin: "0" }}><strong>Label read:</strong> {result.imageTerms}</p> : null}
        {!result.regalImageUrl ? (
          <p className="amazon-source-image-warning" role="status" style={{ color: "#dc2626", fontSize: "13px", margin: "8px 0 0 0" }}>
            Image matching is required, but no supplier image was available for this row.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function AttributeMatchSummary({ result, candidate }: { result: AmazonMatchRow; candidate: AmazonSearchCandidate }) {
  const attributes = [
    { label: "Brand", value: result.brand, match: candidate.brandMatch },
    { label: "Variant", value: result.variant, match: candidate.variantMatch },
    ...(!result.variant && result.title && candidate.variantMatch === false
      ? [{ label: "Title variant", value: result.title, match: false }]
      : []),
    { label: "Size", value: result.size, match: candidate.sizeMatch },
    { label: "Pack", value: result.pack, match: candidate.packMatch },
  ].filter(({ value }) => value.trim());

  if (!attributes.length) return null;

  return (
    <div className="amazon-attribute-checks" role="list" aria-label="Quick supplier attribute checks" style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "12px" }}>
      {attributes.map(({ label, value, match }) => {
        const isSingleItemFallback = label === "Pack" && candidate.packMatchType === "single-item-fallback";
        const isPackCountDiffAllowed = label === "Pack" && candidate.packMatchType === "pack-count-difference-allowed";
        const packDifferenceAllowed = label === "Pack" && (match === false || isPackCountDiffAllowed);
        const state = match === true || packDifferenceAllowed ? "match" : match === false ? "mismatch" : "unknown";
        const stateLabel = isPackCountDiffAllowed
          ? "Pack count differs (allowed)"
          : packDifferenceAllowed
            ? "Allowed difference"
            : isSingleItemFallback
              ? "Single-item fallback"
              : match === true
                ? "Match"
                : match === false
                  ? "Mismatch"
                  : "Check";
        const displayValue = isPackCountDiffAllowed
          ? `${value} (pack count differs - same item size)`
          : packDifferenceAllowed
            ? `${value} (pack count may differ)`
            : isSingleItemFallback
              ? `${value} (single-item fallback)`
              : value;
        const stateColors = {
          match: { bg: "#dcfce7", color: "#166534", iconColor: "#16a34a" },
          mismatch: { bg: "#fee2e2", color: "#991b1b", iconColor: "#dc2626" },
          unknown: { bg: "#fef3c7", color: "#92400e", iconColor: "#d97706" },
        };
        const colors = stateColors[state as keyof typeof stateColors] || stateColors.unknown;

        return (
          <span
            key={label}
            role="listitem"
            className={`amazon-attribute-check amazon-attribute-${state}`}
            aria-label={`Supplier ${label} ${value}: ${stateLabel.toLowerCase()} against the Amazon listing`}
            title={`Supplier ${label} ${value} · ${stateLabel.toLowerCase()} against the Amazon listing`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              padding: "6px 10px",
              borderRadius: "6px",
              backgroundColor: colors.bg,
              color: colors.color,
              fontSize: "12px",
              fontWeight: 500,
            }}
          >
            {match === true ? <Check size={12} aria-hidden="true" style={{ color: colors.iconColor }} /> : null}
            {match === false ? <X size={12} aria-hidden="true" style={{ color: colors.iconColor }} /> : null}
            {match === undefined ? <CircleHelp size={12} aria-hidden="true" style={{ color: colors.iconColor }} /> : null}
            <strong style={{ fontWeight: 600 }}>{label}</strong>
            <span style={{ fontWeight: 400 }}>{displayValue}</span>
            <span className="amazon-attribute-status" style={{ fontSize: "10px", textTransform: "uppercase", opacity: 0.8 }}>{stateLabel}</span>
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
      style={{ display: "inline-flex", alignItems: "center", gap: "6px", padding: "8px 12px", fontSize: "13px" }}
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
      style={{ padding: "8px 12px", fontSize: "13px" }}
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
  const isEmpty = percentage === null;
  return (
    <div
      className={`amazon-score-metric${isEmpty ? " amazon-score-metric-empty" : ""}`}
      aria-label={`${label}: ${value}`}
      title={help}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: "2px",
        padding: "8px 12px",
        backgroundColor: isEmpty ? "#f1f5f9" : "#f8fafc",
        borderRadius: "8px",
        border: isEmpty ? "1px dashed #cbd5e1" : "1px solid #e2e8f0",
        minWidth: "70px",
      }}
    >
      <strong style={{ fontSize: "18px", fontWeight: 700, color: isEmpty ? "#94a3b8" : "#1e293b" }}>{value}</strong>
      <span style={{ fontSize: "11px", color: "#64748b", textTransform: "uppercase", letterSpacing: "0.3px" }}>{label}</span>
    </div>
  );
}

function CandidateRow({
  candidate,
  index,
  isSelected,
  onSelect,
  onDetails,
  sourceTitle,
  fallbackSearchUrl,
  result,
  onToggleExpand,
  isExpanded,
}: {
  candidate: AmazonSearchCandidate;
  index: number;
  isSelected: boolean;
  onSelect: () => void;
  onDetails: (candidate: AmazonSearchCandidate) => void;
  sourceTitle: string;
  fallbackSearchUrl: string;
  result: AmazonMatchRow;
  onToggleExpand: () => void;
  isExpanded: boolean;
}) {
  const [isHovered, setIsHovered] = useState(false);
  const displayTitle = candidate.amazonTitle || candidate.title;
  const sellerValue = candidate.seller || (candidate.listingDetailsChecked ? "Not shown" : "Not checked");
  const visualLabel = candidate.visualVerdict
    ? visualLabels[candidate.visualVerdict]
    : candidate.tier === "low"
      ? "Manual review"
      : `${candidate.tier} match`;

  const tierColors = {
    high: { bg: "#dcfce7", color: "#166534", border: "#86efac" },
    medium: { bg: "#fef3c7", color: "#92400e", border: "#fde68a" },
    low: { bg: "#fef3c7", color: "#92400e", border: "#fde68a" },
  };
  const tierColor = tierColors[candidate.tier as keyof typeof tierColors] || tierColors.medium;

  const visualVerdictColors = {
    strong: { bg: "#dcfce7", color: "#166534" },
    possible: { bg: "#fef3c7", color: "#92400e" },
    different: { bg: "#fee2e2", color: "#991b1b" },
    uncertain: { bg: "#f1f5f9", color: "#64748b" },
    unavailable: { bg: "#f1f5f9", color: "#64748b" },
  };
  const visualColor = candidate.visualVerdict ? visualVerdictColors[candidate.visualVerdict] : visualVerdictColors.unavailable;

  const stageLabels: Record<string, string> = {
    "ean": "EAN",
    "brand-size": "Brand + Size",
    "brand-size-variant": "Brand + Size + Variant",
    "brand-title-size": "Brand + Title + Size",
    "brand-title-size-variant": "Brand + Title + Size + Variant",
    "brand-title": "Brand + Title",
    "brand-title-variant": "Brand + Title + Variant",
    "size-title": "Size + Title",
    "size-title-variant": "Size + Title + Variant",
    "title-only": "Title Only",
    "title-variant": "Title + Variant",
    "image": "Image",
    "image-brand-size": "Image + Brand + Size",
    "brand-size-category": "Brand + Size + Category",
    "brand-title-category": "Brand + Title + Category",
    "brand-only": "Brand Only",
    "detail": "Detailed",
    "category": "Category",
    "brand": "Brand",
    "title-specific": "Specific Title",
    "title-fallback": "Title Fallback",
  };

  return (
    <>
      <tr
        className={`amazon-candidate-row${isSelected ? " is-selected" : ""}`}
        style={{
          backgroundColor: isSelected ? "#eff6ff" : (index % 2 === 0 ? "#ffffff" : "#fafafa"),
          borderBottom: "1px solid #e2e8f0",
          transition: "background-color 0.15s ease",
        }}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        <td style={{ width: "48px", padding: "12px 8px", textAlign: "center", verticalAlign: "middle" }}>
          <button
            type="button"
            onClick={onSelect}
            aria-label={isSelected ? `Deselect ${displayTitle}` : `Select ${displayTitle}`}
            aria-pressed={isSelected}
            style={{
              width: "22px",
              height: "22px",
              borderRadius: "4px",
              border: isSelected ? "2px solid #3b82f6" : "2px solid #cbd5e1",
              backgroundColor: isSelected ? "#3b82f6" : "transparent",
              color: "white",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              transition: "all 0.15s ease",
              padding: 0,
            }}
          >
            {isSelected && <Check size={14} aria-hidden="true" />}
          </button>
        </td>
        <td style={{ width: "130px", padding: "12px 8px", verticalAlign: "middle" }}>
          <ImageFrame
            src={candidate.imageUrl}
            alt={`Amazon listing image: ${displayTitle}`}
            label={visualLabel}
            width={110}
            height={110}
          />
        </td>
        <td style={{ padding: "12px 16px", verticalAlign: "top", minWidth: "280px" }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: "10px" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p className="amazon-candidate-title" title={displayTitle} style={{ margin: "0 0 6px 0", fontSize: "14px", fontWeight: 500, color: "#1e293b", lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{displayTitle}</p>

              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
                <span style={{ display: "inline-flex", alignItems: "center", padding: "3px 8px", borderRadius: "4px", fontSize: "11px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.3px", backgroundColor: tierColor.bg, color: tierColor.color, border: `1px solid ${tierColor.border}` }}>
                  {candidate.tier.toUpperCase()}
                </span>
                {candidate.visualVerdict && (
                  <span style={{ display: "inline-flex", alignItems: "center", padding: "3px 8px", borderRadius: "4px", fontSize: "11px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.3px", backgroundColor: visualColor.bg, color: visualColor.color }}>
                    {visualLabels[candidate.visualVerdict]}
                  </span>
                )}
                <span style={{ fontSize: "11px", color: "#64748b", backgroundColor: "#f1f5f9", padding: "3px 8px", borderRadius: "4px" }}>
                  {stageLabels[candidate.searchedBy] || candidate.searchedBy}
                </span>
              </div>

              <div style={{ display: "flex", flexWrap: "wrap", gap: "12px", fontSize: "12px", color: "#475569", marginBottom: "8px" }}>
                <span><strong>Price:</strong> {candidate.amazonUnitPrice ? `${candidate.amazonUnitPrice} / item` : candidate.price || "Not found"}</span>
                <span><strong>Pack:</strong> {candidate.amazonPackBreakdown ?? candidate.amazonPackCount ?? "Not identified"}</span>
                <span><strong>ASIN:</strong> {candidate.asin || "N/A"}</span>
              </div>

              <AttributeMatchSummary result={result} candidate={candidate} />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "6px", flexShrink: 0 }}>
              <button
                type="button"
                onClick={onToggleExpand}
                aria-expanded={isExpanded}
                style={{ padding: "6px 12px", fontSize: "12px", display: "inline-flex", alignItems: "center", gap: "4px" }}
              >
                {isExpanded ? (
                  <>
                    <ChevronUp size={13} aria-hidden="true" />
                    Hide
                  </>
                ) : (
                  <>
                    <ChevronDown size={13} aria-hidden="true" />
                    Details
                  </>
                )}
              </button>
              <a className="amazon-product-link" href={candidate.productUrl || fallbackSearchUrl} target="_blank" rel="noreferrer" style={{ padding: "6px 12px", fontSize: "12px", display: "inline-flex", alignItems: "center", gap: "4px", textAlign: "center" }}>
                <ExternalLink size={13} aria-hidden="true" /> Open
              </a>
              <AmazonDetailsButton candidate={candidate} sourceTitle={sourceTitle} onDetails={onDetails} />
            </div>
          </div>
        </td>
        <td style={{ width: "140px", padding: "12px 16px", verticalAlign: "top" }}>
          <div className="amazon-candidate-scores" aria-label="Independent match scores" style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <ScoreMetric label="Title match" percentage={typeof candidate.titleWordCoverage === "number" ? candidate.titleWordCoverage * 100 : null} />
            <ScoreMetric
              label="Image match"
              percentage={typeof candidate.imageMatchScore === "number" ? candidate.imageMatchScore : null}
              emptyLabel="Check failed"
              help="Visual evidence is required; an unavailable or inconclusive image check cannot confirm this listing."
            />
          </div>
        </td>
      </tr>
      {isExpanded && (
        <tr className="amazon-candidate-expanded-row" style={{ backgroundColor: isSelected ? "#eff6ff" : "#fafafa" }}>
          <td colSpan={5} style={{ padding: "0 16px 16px 72px", borderBottom: "1px solid #e2e8f0" }}>
            <div style={{ padding: "16px", backgroundColor: "#ffffff", borderRadius: "8px", border: "1px solid #e2e8f0", marginTop: "8px" }}>
              <div className="amazon-candidate-popover-heading" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "12px", paddingBottom: "12px", borderBottom: "1px solid #e2e8f0" }}>
                <p className="amazon-compare-label" style={{ margin: 0, fontSize: "11px", fontWeight: 600, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.5px" }}>AMAZON LISTING DETAILS</p>
                {isSelected && <span className="amazon-top-match-label" style={{ fontSize: "11px", fontWeight: 600, color: "#3b82f6", backgroundColor: "#dbeafe", padding: "3px 8px", borderRadius: "4px" }}>Selected Match</span>}
              </div>
              <p className="amazon-candidate-title-full" style={{ margin: "0 0 8px 0", fontSize: "15px", fontWeight: 600, color: "#1e293b" }}>{displayTitle}</p>
              {candidate.amazonTitle && candidate.amazonTitle !== candidate.title ? (
                <p className="amazon-candidate-search-title" style={{ margin: "0 0 12px 0", fontSize: "13px", color: "#64748b" }}>Search result label: {candidate.title}</p>
              ) : null}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "10px", marginBottom: "16px" }}>
                <p className="amazon-candidate-detail" style={{ margin: 0, fontSize: "13px" }}><strong>Brand:</strong> {candidate.amazonBrand || (candidate.listingDetailsChecked ? "Not shown" : "Not checked")}</p>
                <p className="amazon-candidate-detail" style={{ margin: 0, fontSize: "13px" }}><strong>Shipper / seller:</strong> {sellerValue}</p>
                <p className="amazon-candidate-detail" style={{ margin: 0, fontSize: "13px" }}><strong>Amazon listing price:</strong> {candidate.price || "Not found"}</p>
                <p className="amazon-candidate-detail" style={{ margin: 0, fontSize: "13px" }}><strong>Pack quantity in listing:</strong> {candidate.amazonPackBreakdown ?? candidate.amazonPackCount ?? "Not identified"}</p>
                <p className="amazon-candidate-detail" style={{ margin: 0, fontSize: "13px" }}><strong>ASIN:</strong> {candidate.asin || "Not available"}</p>
              </div>
              {candidate.amazonUnitPrice || candidate.supplierPackEquivalentPrice ? (
                <div className="amazon-unit-price" style={{ marginBottom: "16px", padding: "12px", backgroundColor: "#f8fafc", borderRadius: "8px", border: "1px solid #e2e8f0" }}>
                  {candidate.amazonUnitPrice ? (
                    <p style={{ margin: "0 0 6px 0", fontSize: "13px" }}><strong>Amazon price per item:</strong> {candidate.amazonUnitPrice}</p>
                  ) : null}
                  {candidate.supplierPackEquivalentPrice && result.pack ? (
                    <p style={{ margin: 0, fontSize: "13px" }}><strong>At supplier pack size ({result.pack}):</strong> {candidate.supplierPackEquivalentPrice}</p>
                  ) : null}
                  <small style={{ color: "#64748b" }}>Estimated from the listing price and pack count in the title (assumed one item when omitted).</small>
                </div>
              ) : null}
              <AttributeMatchSummary result={result} candidate={candidate} />
              {candidate.visualReason ? <p className="amazon-candidate-visual-reason" style={{ margin: "12px 0 0 0", fontSize: "13px", color: "#475569", padding: "10px", backgroundColor: "#f8fafc", borderRadius: "6px" }}>{candidate.visualReason}</p> : null}
              {candidate.listingDetailsMessage ? <p className="amazon-details-message" role="status" style={{ margin: "12px 0 0 0", fontSize: "13px", color: "#0369a1", padding: "10px", backgroundColor: "#eff6ff", borderRadius: "6px" }}>{candidate.listingDetailsMessage}</p> : null}
            </div>
          </td>
        </tr>
      )}
    </>
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
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const candidateOptions = result.candidates.length ? result.candidates : result.bestCandidate ? [result.bestCandidate] : [];
  const isReview = result.status === "medium" || result.status === "low";
  const needsVisualRetry = Boolean(
    result.regalImageUrl && result.candidates.some((option) => typeof option.imageMatchScore !== "number"),
  );
  const headingId = result.rowNumber === 0 ? "amazon-single-item-result" : `amazon-row-${result.rowNumber}`;
  const rowLabel = result.rowNumber === 0 ? "SINGLE ITEM" : `ROW ${result.rowNumber.toString().padStart(2, "0")}`;
  const sourceTitle = titleWithSize([result.brand, result.title, result.variant].filter(Boolean).join(" "), result.size);

  const selectedCandidateKey = result.selectedCandidateKey || (result.bestCandidate ? (result.bestCandidate.asin || result.bestCandidate.productUrl || result.bestCandidate.title) : "");
  const selectedCandidate = candidateOptions.find(c => (c.asin || c.productUrl || c.title) === selectedCandidateKey);

  const toggleExpand = (candidate: AmazonSearchCandidate) => {
    const key = candidate.asin || candidate.productUrl || candidate.title;
    setExpandedRows(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleCandidateSelect = (candidate: AmazonSearchCandidate) => {
    onCandidateSelect(result.rowNumber, candidate);
  };

  const handleCandidateDetails = (candidate: AmazonSearchCandidate) => {
    onCandidateDetails(result.rowNumber, candidate);
  };

  return (
    <div className={`amazon-result-row amazon-result-${result.status}`}>
      <div className="amazon-result-topline" style={{ display: "flex", alignItems: "center", gap: "12px", padding: "8px" }}>
        <span className={`amazon-status amazon-status-${result.status}`} style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "6px",
          padding: "4px 8px",
          borderRadius: "12px",
          fontSize: "11px",
          fontWeight: 600,
          textTransform: "uppercase",
          backgroundColor: result.status === "high" ? "#dcfce7" : result.status === "medium" ? "#fef3c7" : "#f1f5f9",
          color: result.status === "high" ? "#166534" : result.status === "medium" ? "#92400e" : "#64748b",
        }}>
          {statusLabels[result.status as keyof typeof statusLabels]}
        </span>
        <a className="amazon-product-link" href={amazonSearchUrl(result)} target="_blank" rel="noreferrer" style={{ fontSize: "12px", color: "#3b82f6" }}>
          Search <ExternalLink size={12} aria-hidden="true" />
        </a>
      </div>

      {candidateOptions.length ? (
        <div className="amazon-candidate-table-container" style={{ overflowX: "auto", marginTop: "8px" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
            <thead>
              <tr style={{ backgroundColor: "#f8fafc" }}>
                <th style={{ padding: "8px", textAlign: "left" }}>Select</th>
                <th style={{ padding: "8px", textAlign: "left" }}>Image</th>
                <th style={{ padding: "8px", textAlign: "left" }}>Product</th>
                <th style={{ padding: "8px", textAlign: "left" }}>Details</th>
              </tr>
            </thead>
            <tbody>
              {candidateOptions.map((option, index) => (
                <CandidateRow
                  key={option.asin || option.productUrl || option.title}
                  candidate={option}
                  index={index}
                  isSelected={Boolean(selectedCandidate && selectedCandidate.asin === option.asin && selectedCandidate.productUrl === option.productUrl && selectedCandidate.title === option.title)}
                  onSelect={() => handleCandidateSelect(option)}
                  onDetails={(updated) => handleCandidateDetails(updated)}
                  sourceTitle={sourceTitle}
                  fallbackSearchUrl={amazonSearchUrl(result)}
                  result={result}
                  onToggleExpand={() => toggleExpand(option)}
                  isExpanded={expandedRows.has(option.asin || option.productUrl || option.title)}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}