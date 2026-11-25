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
  visualVerdict?: AmazonVisualVerdict;
  visualReason?: string;
  titleWordCoverage?: number;
  searchedBy: "ean" | "detail" | "image" | "brand" | "category";
}

export interface AmazonMatchResponse {
  status: AmazonMatchStatus;
  message: string;
  regalImageUrl: string;
  bestCandidate: AmazonSearchCandidate | null;
  candidates: AmazonSearchCandidate[];
  searchedQueries: Array<{ stage: string; query: string }>;
}

export interface AmazonMatchRow extends AmazonProductInput {
  rowNumber: number;
  key: string;
  status: AmazonMatchStatus;
  message: string;
  bestCandidate: AmazonSearchCandidate | null;
  candidates: AmazonSearchCandidate[];
  decision: AmazonReviewDecision;
}
