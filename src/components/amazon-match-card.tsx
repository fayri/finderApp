import Image from "next/image";
import { BadgeCheck, Check, ExternalLink, ImageOff, SearchX, ShieldAlert, X } from "lucide-react";
import type { AmazonMatchRow, AmazonSearchCandidate } from "@/lib/amazon-types";
import { buildAmazonSearchUrl } from "@/lib/amazon-search-url";

interface AmazonMatchCardProps {
  result: AmazonMatchRow;
  onDecision: (rowNumber: number, decision: "confirmed" | "rejected") => void;
  onCandidateSelect: (rowNumber: number, candidate: AmazonSearchCandidate) => void;
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
  return (
    <div className="amazon-image-frame">
      {src ? (
        <Image src={imageSource(src)} alt={alt} width={420} height={420} sizes="(max-width: 560px) 100vw, 50vw" unoptimized />
      ) : (
        <span className="amazon-image-empty" aria-label="No image available">
          <ImageOff size={19} aria-hidden="true" />
        </span>
      )}
      <span className="amazon-image-label">{label}</span>
    </div>
  );
}

function CandidateOption({
  candidate,
  selected,
  onSelect,
  fallbackSearchUrl,
}: {
  candidate: AmazonSearchCandidate;
  selected: boolean;
  onSelect: () => void;
  fallbackSearchUrl: string;
}) {
  return (
    <article className={`amazon-candidate-option${selected ? " is-selected" : ""}`} aria-label={`Amazon listing: ${candidate.title}`}>
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
      <p className="amazon-candidate-title" title={candidate.title}>{candidate.title}</p>
      <p className="amazon-candidate-detail">
        {candidate.price || "Price not found"} · ASIN {candidate.asin || "not available"}
      </p>
      {typeof candidate.titleWordCoverage === "number" ? (
        <p className="amazon-candidate-coverage">
          <strong>{Math.round(candidate.titleWordCoverage * 100)}%</strong> product text
        </p>
      ) : null}
      {candidate.visualReason ? <p className="amazon-candidate-visual-reason">{candidate.visualReason}</p> : null}
      <div className="amazon-candidate-actions">
        <a className="amazon-product-link" href={candidate.productUrl || fallbackSearchUrl} target="_blank" rel="noreferrer">
          Open listing <ExternalLink size={13} aria-hidden="true" />
        </a>
        <button
          type="button"
          className="secondary-button amazon-select-candidate"
          onClick={onSelect}
          aria-label={selected ? `${candidate.title} is selected` : `Use ${candidate.title} as the Amazon match`}
          aria-pressed={selected}
        >
          {selected ? "Selected" : "Use this listing"}
        </button>
      </div>
    </article>
  );
}

export function AmazonMatchCard({ result, onDecision, onCandidateSelect }: AmazonMatchCardProps) {
  const candidate = result.bestCandidate;
  const isReview = result.status === "medium" || result.status === "low";
  const headingId = result.rowNumber === 0 ? "amazon-single-item-result" : `amazon-row-${result.rowNumber}`;
  const rowLabel = result.rowNumber === 0 ? "SINGLE ITEM" : `ROW ${result.rowNumber.toString().padStart(2, "0")}`;

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
            <section className="amazon-compare-panel" aria-label="Source product">
              <p className="amazon-compare-label">SOURCE PRODUCT</p>
              <ImageFrame
                src={result.regalImageUrl}
                alt={`Source product image for ${result.title || result.ean}`}
                label="Source image"
              />
              <p className="amazon-compare-title">{result.title || "No title in source file"}</p>
              {result.imageTerms ? <p className="amazon-label-text"><strong>Label read:</strong> {result.imageTerms}</p> : null}
              <p className="amazon-compare-detail">{[result.brand, result.variant, result.size, result.pack && `Pack ${result.pack}`].filter(Boolean).join(" · ") || "No additional source details supplied"}</p>
            </section>
            <section className="amazon-compare-panel" aria-label="Amazon UK candidate">
              <div className="amazon-compare-heading">
                <p className="amazon-compare-label">AMAZON UK CANDIDATE</p>
                {typeof candidate.titleWordCoverage === "number" ? (
                  <div className="amazon-match-percentage" aria-label={`Source product text match ${Math.round(candidate.titleWordCoverage * 100)} percent`}>
                    <strong>{Math.round(candidate.titleWordCoverage * 100)}%</strong>
                    <span>Product text</span>
                  </div>
                ) : null}
              </div>
              <ImageFrame
                src={candidate.imageUrl}
                alt={`Amazon listing image: ${candidate.title}`}
                label="Amazon listing"
              />
              <p className="amazon-compare-title">{candidate.title}</p>
              <p className="amazon-compare-detail">
                {candidate.price || "Price not found"} · ASIN {candidate.asin || "not available"}
                {candidate.visualVerdict ? ` · AI visual check: ${visualLabels[candidate.visualVerdict]}` : ""}
              </p>
              <a className="amazon-product-link" href={candidate.productUrl || amazonSearchUrl(result)} target="_blank" rel="noreferrer">
                Open listing <ExternalLink size={13} aria-hidden="true" />
              </a>
            </section>
          </div>

          {result.candidates.length > 1 ? (
            <section className="amazon-candidate-section" aria-label="Similar Amazon listings">
              <div className="amazon-candidate-heading">
                <div>
                  <h4>Top Amazon options</h4>
                  <p>Options below 90% title overlap are still shown. Compare details and choose manually.</p>
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
