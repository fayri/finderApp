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

import { AmazonSingleItemTest } from "@/components/amazon-single-item-test";
import type {
  AmazonMatchResponse,
  AmazonMatchRow,
  AmazonMatchStatus,
  AmazonProductInput,
  AmazonSearchCandidate,
  AmazonOfferDetailsResponse,
} from "@/lib/amazon-types";
import type { ParsedSource } from "@/lib/types";
import { fallbackCategory } from "@/lib/amazon-categories";
import { getApiErrorMessage } from "@/lib/amazon-api-errors";
import { verifyAmazonCandidates, updateAmazonTitleMatch } from "@/lib/amazon-visual-matching";
import { normalizeEan, parseSpreadsheet } from "@/lib/spreadsheet";
import { buildAmazonProductSearchQuery, buildAmazonSearchUrl } from "@/lib/amazon-search-url";
import Image from "next/image";
import { CircleHelp, ImageOff, LoaderCircle, RotateCw, ChevronDown, ChevronUp, BadgeCheck, ShieldAlert, SearchX } from "lucide-react";

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
  activeProducts: Array<{ key: string; title: string; stage: "label" | "brand" | "search" | "visual" }>;
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
    selectedCandidateKey: undefined,
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
    "Selected candidate key",
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
      result.selectedCandidateKey ?? "",
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
        <p className="amazon-compare-label" style={{ fontSize: "11px", fontWeight: 600, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "8px" }}>SUPPLIER PRODUCT</p>
        <ImageFrame
          src={result.regalImageUrl}
          alt={`Supplier product image for ${result.title || result.ean}`}
          label={result.regalImageUrl ? "Supplier image" : "Image unavailable"}
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
        <a className="amazon-product-link" href={amazonSearchUrl(result)} target="_blank" rel="noreferrer" style={{ marginTop: "10px", fontSize: "12px", color: "#3b82f6", display: "inline-flex", alignItems: "center", gap: "4px" }}>
          Open this Amazon UK search <ExternalLink size={12} aria-hidden="true" />
        </a>
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
                    <p style={{ margin: "0", fontSize: "13px" }}><strong>At supplier pack size ({result.pack}):</strong> {candidate.supplierPackEquivalentPrice}</p>
                  ) : null}
                  <small style={{ color: "#64748b" }}>Estimated from the listing price and pack count in the title (assumed one item when omitted).</small>
                </div>
              ) : null}
              <AttributeMatchSummary result={result} candidate={candidate} />
              {candidate.visualReason ? <p className="amazon-candidate-visual-reason" style={{ margin: "12px 0 0 0", fontSize: "13px", color: "#475569", padding: "10px", backgroundColor: "#f8fafc", borderRadius: "6px" }}>{candidate.visualReason}</p> : null}
            </div>
          </td>
        </tr>
      )}
    </>
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
  const [expandedCandidates, setExpandedCandidates] = useState<Set<string>>(new Set());
  const [expandedCandidateRows, setExpandedCandidateRows] = useState<Set<string>>(new Set());

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
              { key: product.key, title: product.title || product.ean, stage: product.regalImageUrl ? "label" : product.brand ? "search" : "brand" },
            ],
          }));

          try {
            const labelResult = await readImageLabelText(product, controller.signal);
            if (controller.signal.aborted) return;
            const matchProduct = { ...product, imageTerms: labelResult.imageTerms };
            setProgress((current) => ({
              ...current,
              activeProducts: current.activeProducts.map((activeProduct) =>
                activeProduct.key === product.key ? { ...activeProduct, stage: product.brand ? "search" : "brand" } : activeProduct,
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
            const discoveredBrand = typeof matchPayload.discoveredBrand === "string" ? matchPayload.discoveredBrand.trim() : "";
            const resolvedBrand = product.brand || discoveredBrand;
            const resolvedProduct = { ...matchProduct, brand: resolvedBrand };
            setProgress((current) => ({
              ...current,
              activeProducts: current.activeProducts.map((activeProduct) =>
                activeProduct.key === product.key ? { ...activeProduct, stage: "visual" } : activeProduct,
              ),
            }));
            const verifiedMatch = await verifyAmazonCandidates(resolvedProduct, matchPayload, controller.signal);
            if (controller.signal.aborted) return;
            const rowResult: AmazonMatchRow = {
              ...resolvedProduct,
              brandSource: product.brand ? "supplier" : discoveredBrand ? "amazon" : undefined,
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
    const candidateKey = candidate.asin || candidate.productUrl || candidate.title;
    setResults((current) =>
      current.map((result) =>
        result.rowNumber === rowNumber
          ? { ...result, status: candidate.tier, message: candidate.reason, bestCandidate: candidate, decision: null, selectedCandidateKey: candidateKey }
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
        const candidateKey = candidate.asin || candidate.productUrl || candidate.title;
        return {
          ...result,
          status: updatesBestCandidate ? candidate.tier : result.status,
          message: updatesBestCandidate ? candidate.reason : result.message,
          candidates: result.candidates.map((existing) => (matches(existing) ? candidate : existing)),
          bestCandidate: updatesBestCandidate ? candidate : result.bestCandidate,
          selectedCandidateKey: updatesBestCandidate ? candidateKey : result.selectedCandidateKey,
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
  const activeBrandCount = progress.activeProducts.filter((product) => product.stage === "brand").length;
  const activeSearchCount = progress.activeProducts.filter((product) => product.stage === "search").length;
  const activeVisualCount = progress.activeProducts.filter((product) => product.stage === "visual").length;
  const activeProgressLabel = [
    activeLabelCount ? `Reading labels for ${activeLabelCount}` : "",
    activeBrandCount ? `Checking product brands on Amazon for ${activeBrandCount}` : "",
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
          <span><strong>Two products at a time</strong><small>Amazon page requests stay 3 seconds apart and stop on CAPTCHA blocks.</small></span>
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
              Supplier ^ marks are removed before matching. When no brand is supplied, the matcher checks likely Amazon detail pages one at a time before a brand-refined search. Category only expands search. The complete returned Amazon result page is scanned; candidates are filtered by the known brand and exact item size when supplied. Pack count may differ and is used only for pack details and price estimates. Compound pack labels such as 2×5 are read as two packs of five (10 total). The closest five titles are ranked for review. A confident result still needs a strong title match (at least 90% meaningful-word coverage), strong visual evidence (at least 85%), and no brand, variant, or size conflict; an EAN cannot override a visual mismatch. Two products are processed at once, Amazon requests remain at least 3 seconds apart, and CAPTCHA/rate-limit responses stop the batch. Up to {MAX_PRODUCTS_PER_RUN} unique products per run.
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
            <div className="amazon-results-list" style={{ width: "100%", marginTop: "20px" }}>
              {results.map((result, resultIndex) => {
                const candidateOptions = result.candidates.length
                  ? result.candidates
                  : result.bestCandidate
                    ? [result.bestCandidate]
                    : [];

                // Filter candidates: only show if brand matches (if supplier has brand) AND size matches (if supplier has size)
                const filteredCandidates = candidateOptions.filter((option) => {
                  const brandMatch = !result.brand || option.brandMatch !== false;
                  const sizeMatch = !result.size || option.sizeMatch !== false;
                  return brandMatch && sizeMatch;
                });

                const selectedCandidateKey = result.selectedCandidateKey || (result.bestCandidate ? (result.bestCandidate.asin || result.bestCandidate.productUrl || result.bestCandidate.title) : "");
                const selectedCandidate = candidateOptions.find(c => (c.asin || c.productUrl || c.title) === selectedCandidateKey);
                const sourceTitle = titleWithSize([result.brand, result.title, result.variant].filter(Boolean).join(" "), result.size);
                const candidateRowExpanded = expandedCandidateRows.has(result.key);

                const toggleCandidateRow = () => {
                  setExpandedCandidateRows(prev => {
                    const next = new Set(prev);
                    if (next.has(result.key)) next.delete(result.key);
                    else next.add(result.key);
                    return next;
                  });
                };

                // No client-side brand/size filtering — the backend ranking already prioritizes matches,
                // and attribute checks visually flag any brand/size/pack mismatch per candidate.
                const visibleCandidates = candidateOptions;

                return (
                  <div key={`${result.key}-${resultIndex}`} className="amazon-result-group" style={{ marginBottom: "24px", border: "1px solid #e2e8f0", borderRadius: "12px", overflow: "hidden", backgroundColor: "#fff" }}>
                    <SourceProductReference result={result} />

                    <div style={{ display: "flex", alignItems: "center", gap: "8px", padding: "0 16px 12px 16px", cursor: "pointer", borderBottom: "1px solid #f0f2f5" }}
                      onClick={toggleCandidateRow}
                    >
                      <button type="button" style={{ padding: "4px 8px", border: "1px solid #e2e8f0", borderRadius: "4px", backgroundColor: "#fff", fontSize: "11px", color: "#64748b", cursor: "pointer", display: "flex", alignItems: "center", gap: "4px" }} onClick={(e) => e.stopPropagation()}>
                        {candidateRowExpanded ? (
                          <>
                            <ChevronUp size={12} aria-hidden="true" />
                            Collapse
                          </>
                        ) : (
                          <>
                            <ChevronDown size={12} aria-hidden="true" />
                            Expand candidates
                          </>
                        )}
                      </button>
                      <span style={{ fontSize: "11px", fontWeight: 600, color: "#64748b" }}>{visibleCandidates.length} Amazon candidate{visibleCandidates.length !== 1 ? "s" : ""}</span>
                    </div>

                    {candidateRowExpanded && visibleCandidates.length ? (
                      <div className="amazon-candidate-table-container" style={{ overflowX: "auto" }}>
                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                          <thead>
                            <tr style={{ backgroundColor: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                              <th style={{ padding: "8px", textAlign: "left", width: "48px" }}>Select</th>
                              <th style={{ padding: "8px", textAlign: "left", width: "130px" }}>Image</th>
                              <th style={{ padding: "8px", textAlign: "left" }}>Product</th>
                              <th style={{ padding: "8px", textAlign: "left", width: "140px" }}>Scores</th>
                            </tr>
                          </thead>
                          <tbody>
                            {visibleCandidates.map((option, index) => {
                              const candidateKey = option.asin || option.productUrl || option.title;
                              const isSelected = Boolean(
                                selectedCandidate && selectedCandidate.asin === option.asin && selectedCandidate.productUrl === option.productUrl && selectedCandidate.title === option.title,
                              );
                              const isExpanded = expandedCandidates.has(candidateKey);

                              const handleCandidateSelect = () => updateCandidate(result.rowNumber, option);
                              const handleCandidateDetails = (updated: AmazonSearchCandidate) => updateCandidateDetails(result.rowNumber, updated);
                              const toggleExpand = () => {
                                setExpandedCandidates(prev => {
                                  const next = new Set(prev);
                                  if (next.has(candidateKey)) next.delete(candidateKey);
                                  else next.add(candidateKey);
                                  return next;
                                });
                              };

                              return (
                                <CandidateRow
                                  key={candidateKey}
                                  candidate={option}
                                  index={index}
                                  isSelected={isSelected}
                                  onSelect={handleCandidateSelect}
                                  onDetails={handleCandidateDetails}
                                  sourceTitle={sourceTitle}
                                  fallbackSearchUrl={amazonSearchUrl(result)}
                                  result={result}
                                  onToggleExpand={toggleExpand}
                                  isExpanded={isExpanded}
                                />
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    ) : candidateRowExpanded && visibleCandidates.length === 0 && candidateOptions.length > 0 ? (
                      <div style={{ padding: "16px", color: "#64748b", fontStyle: "italic" }}>
                        No Amazon candidates returned.
                        <a className="amazon-product-link" href={amazonSearchUrl(result)} target="_blank" rel="noreferrer" style={{ marginLeft: "12px", fontSize: "12px", color: "#3b82f6" }}>
                          Search Amazon UK <ExternalLink size={12} aria-hidden="true" />
                        </a>
                      </div>
                    ) : null}

                    {!candidateRowExpanded && visibleCandidates.length === 0 && candidateOptions.length > 0 ? (
                      <div style={{ padding: "0 16px 12px 16px", color: "#64748b", fontStyle: "italic", fontSize: "12px" }}>
                        No Amazon candidates returned.
                        <a className="amazon-product-link" href={amazonSearchUrl(result)} target="_blank" rel="noreferrer" style={{ marginLeft: "12px", fontSize: "12px", color: "#3b82f6" }}>
                          Search Amazon UK <ExternalLink size={12} aria-hidden="true" />
                        </a>
                      </div>
                    ) : null}

                    {!candidateRowExpanded && candidateOptions.length === 0 ? (
                      <div style={{ padding: "16px", color: "#64748b", fontStyle: "italic" }}>
                        {result.message || "No Amazon matches found."}
                        <a className="amazon-product-link" href={amazonSearchUrl(result)} target="_blank" rel="noreferrer" style={{ marginLeft: "12px", fontSize: "12px", color: "#3b82f6" }}>
                          Search Amazon UK <ExternalLink size={12} aria-hidden="true" />
                        </a>
                      </div>
                    ) : null}
                  </div>
                );
              })}
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
