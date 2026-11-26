export type AmazonMatchStatus = "high" | "medium" | "low" | "not-found" | "blocked" | "error" | "pending";
export type AmazonReviewDecision = "confirmed" | "rejected" | null;

export interface AmazonProductInput {
  ean: string;
  title: string;
  brand: string;
  variant: string;
  size: string;
  pack: string;
  regalImageUrl: string;
  imageTerms?: string;
}

export type AmazonVisualVerdict = "strong" | "possible" | "different" | "uncertain" | "unavailable";

export interface AmazonSearchCandidate {
  asin: string;
  title: string;
  imageUrl: string;
  productUrl: string;
  price: string;
  tier: "high" | "medium" | "low";
  reason: string;
  titleScore: number;
  eanMatch: boolean;
  brandMatch?: boolean;
  variantMatch?: boolean;
  sizeMatch: boolean;
  packMatch?: boolean;
  packMatchType?: "exact" | "single-item-fallback" | "mismatch" | "unspecified";
  amazonPackCount?: number;
  amazonPackBreakdown?: string;
  amazonUnitPrice?: string;
  supplierPackEquivalentPrice?: string;
  visualVerdict?: AmazonVisualVerdict;
  visualReason?: string;
  imageMatchScore?: number | null;
  titleWordCoverage?: number;
  amazonTitle?: string;
  amazonBrand?: string;
  seller?: string;
  listingDetailsChecked?: boolean;
  listingDetailsMessage?: string;
  searchedBy: "ean" | "detail" | "image" | "brand" | "category" | "brand-size" | "brand-size-variant" | "brand-title-size" | "brand-title-size-variant" | "brand-title" | "brand-title-variant" | "size-title" | "size-title-variant" | "title-only" | "title-variant" | "image" | "image-brand-size" | "brand-size-category" | "brand-title-category" | "brand-only";
  // Selection state for UI
  isSelected?: boolean;
}

export interface AmazonOfferDetailsResponse {
  status: "found" | "partial" | "blocked" | "error";
  message: string;
  amazonTitle: string;
  amazonBrand: string;
  seller: string;
  price: string;
}

export interface AmazonMatchResponse {
  status: AmazonMatchStatus;
  message: string;
  regalImageUrl: string;
  discoveredBrand?: string;
  bestCandidate: AmazonSearchCandidate | null;
  candidates: AmazonSearchCandidate[];
  scannedCandidateCount?: number;
  searchedQueries: Array<{ stage: string; query: string }>;
}

export interface AmazonMatchRow extends AmazonProductInput {
  brandSource?: "supplier" | "amazon";
  rowNumber: number;
  key: string;
  status: AmazonMatchStatus;
  message: string;
  bestCandidate: AmazonSearchCandidate | null;
  candidates: AmazonSearchCandidate[];
  scannedCandidateCount?: number;
  decision: AmazonReviewDecision;
  // Track which candidate the user selected for this row
  selectedCandidateKey?: string;
}
