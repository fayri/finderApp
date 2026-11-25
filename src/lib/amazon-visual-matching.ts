import type {
  AmazonMatchResponse,
  AmazonProductInput,
  AmazonSearchCandidate,
} from "@/lib/amazon-types";

export const TITLE_WORD_MATCH_THRESHOLD = 0.9;

export type VisualVerdict = "strong" | "possible" | "different" | "uncertain" | "unavailable";

interface VisualEvaluation {
  index: number;
  verdict: VisualVerdict;
  reason: string;
}

const TITLE_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "by",
  "for",
  "from",
  "in",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
  "x",
]);

const GENERIC_PRODUCT_WORDS = new Set([
  "bath",
  "body",
  "care",
  "cleaner",
  "cleaning",
  "conditioner",
  "cream",
  "deodorant",
  "face",
  "gel",
  "hair",
  "hand",
  "home",
  "liquid",
  "lotion",
  "oil",
  "pack",
  "product",
  "products",
  "refill",
  "set",
  "shampoo",
  "soap",
  "spray",
  "wash",
  "washing",
  "wipes",
]);

function meaningfulWords(value: string): Set<string> {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  const words = normalized.match(/[a-z0-9]+/g) ?? [];
  return new Set(words.filter((word) => !TITLE_STOP_WORDS.has(word) && !GENERIC_PRODUCT_WORDS.has(word)));
}

export function titleWordCoverage(sourceTitle: string, candidateTitle: string): number {
  const sourceWords = meaningfulWords(sourceTitle);
  if (!sourceWords.size) return 0;
  const candidateWords = meaningfulWords(candidateTitle);
  const matchedWords = [...sourceWords].filter((word) => candidateWords.has(word)).length;
  return matchedWords / sourceWords.size;
}

export function titleMeetsFallbackThreshold(sourceTitle: string, candidateTitle: string): boolean {
  return (
    meaningfulWords(sourceTitle).size >= 2 &&
    titleWordCoverage(sourceTitle, candidateTitle) >= TITLE_WORD_MATCH_THRESHOLD
  );
}

function candidateIdentityMismatch(candidate: AmazonSearchCandidate): string[] {
  const mismatches: string[] = [];
  if (candidate.brandMatch === false) mismatches.push("brand");
  if (candidate.variantMatch === false) mismatches.push("variant");
  if (candidate.sizeMatch === false) mismatches.push("size");
  if (candidate.packMatch === false) mismatches.push("pack count");
  return mismatches;
}

function evaluationFallback(index: number): VisualEvaluation {
  return {
    index,
    verdict: "unavailable",
    reason: "The images could not be compared; title-word matching was used instead.",
  };
}

function validVerdict(value: unknown): value is VisualVerdict {
  return ["strong", "possible", "different", "uncertain", "unavailable"].includes(String(value));
}

async function requestVisualEvaluations(
  product: AmazonProductInput,
  response: AmazonMatchResponse,
  candidates: AmazonSearchCandidate[],
  signal?: AbortSignal,
): Promise<VisualEvaluation[]> {
  if (!response.regalImageUrl && !product.regalImageUrl) {
    return candidates.map((_, index) => evaluationFallback(index));
  }

  try {
    const result = await fetch("/api/amazon/visual-match", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: product.title,
        brand: product.brand,
        variant: product.variant,
        size: product.size,
        pack: product.pack,
        sourceImageUrl: response.regalImageUrl || product.regalImageUrl,
        candidates: candidates.slice(0, 5).map(({ title, imageUrl }) => ({ title, imageUrl })),
      }),
      signal,
    });
    const payload = (await result.json().catch(() => null)) as { evaluations?: unknown } | null;
    if (!result.ok || !payload || !Array.isArray(payload.evaluations)) {
      return candidates.map((_, index) => evaluationFallback(index));
    }

    const parsed = payload.evaluations.flatMap((value): VisualEvaluation[] => {
      if (!value || typeof value !== "object") return [];
      const item = value as Record<string, unknown>;
      if (
        typeof item.index !== "number" ||
        !Number.isInteger(item.index) ||
        item.index < 0 ||
        item.index >= candidates.length ||
        !validVerdict(item.verdict)
      ) {
        return [];
      }
      return [
        {
          index: item.index,
          verdict: item.verdict,
          reason:
            typeof item.reason === "string" && item.reason.trim()
              ? item.reason.trim().slice(0, 240)
              : "The visual review did not provide a clear explanation.",
        },
      ];
    });
    const byIndex = new Map(parsed.map((evaluation) => [evaluation.index, evaluation]));
    return candidates.map((_, index) => byIndex.get(index) ?? evaluationFallback(index));
  } catch {
    return candidates.map((_, index) => evaluationFallback(index));
  }
}

function reasonForCandidate(
  verdict: VisualVerdict,
  visualReason: string,
  titleCoverage: number,
  mismatches: string[],
  exactEan: boolean,
): string {
  const titlePercent = Math.round(titleCoverage * 100);
  const mismatchText = mismatches.length
    ? ` The ${mismatches.join(", ")} also needs review.`
    : "";

  if (exactEan) {
    if (verdict === "different") {
      return `The EAN matches, but the image review found a visual conflict: ${visualReason}${mismatchText}`;
    }
    return `The EAN appears exactly in the Amazon result text.${mismatchText}`;
  }
  if (verdict === "strong" && mismatches.length === 0) {
    return `Strong visual evidence: ${visualReason}${titlePercent < 90 ? ` Only ${titlePercent}% of meaningful source-title words overlap, so verify the label and variant before confirming.` : ""}`;
  }
  if (verdict === "different") {
    return `The image review conflicts with the title match: ${visualReason} The listing is retained for manual review because ${titlePercent}% of meaningful source-title words overlap.${mismatchText}`;
  }
  return `The visual review was ${verdict === "unavailable" ? "unavailable" : "inconclusive"}; ${titlePercent}% of meaningful source-title words overlap.${mismatchText} Compare the label, variant, size, and pack before confirming.`;
}

function candidateRank(candidate: AmazonSearchCandidate): [number, number, number, number] {
  const tierRank = candidate.tier === "high" ? 3 : candidate.tier === "medium" ? 2 : 1;
  const visualRank = candidate.visualVerdict === "strong" ? 2 : candidate.visualVerdict === "different" ? 0 : 1;
  return [tierRank, visualRank, candidate.titleWordCoverage ?? 0, candidate.titleScore];
}

function compareCandidates(left: AmazonSearchCandidate, right: AmazonSearchCandidate): number {
  const leftRank = candidateRank(left);
  const rightRank = candidateRank(right);
  for (let index = 0; index < leftRank.length; index += 1) {
    if (leftRank[index] !== rightRank[index]) return rightRank[index] - leftRank[index];
  }
  return 0;
}

export async function verifyAmazonCandidates(
  product: AmazonProductInput,
  response: AmazonMatchResponse,
  signal?: AbortSignal,
): Promise<AmazonMatchResponse> {
  if (!["high", "medium", "low"].includes(response.status)) return response;

  const candidates = response.candidates.length
    ? response.candidates.slice(0, 5)
    : response.bestCandidate
      ? [response.bestCandidate]
      : [];
  if (!candidates.length) return response;

  const evaluations = await requestVisualEvaluations(product, response, candidates, signal);
  const verified: AmazonSearchCandidate[] = [];

  candidates.forEach((candidate, index) => {
    const evaluation = evaluations[index] ?? evaluationFallback(index);
    const sourceTitle = [product.brand, product.title, product.variant].filter(Boolean).join(" ");
    const coverage = titleWordCoverage(sourceTitle, candidate.title);
    const exactEan = candidate.eanMatch;
    const titleFallback = titleMeetsFallbackThreshold(sourceTitle, candidate.title);
    const identityMismatches = candidateIdentityMismatch(candidate);
    const visualConflict = evaluation.verdict === "different";

    const needsManualReview = identityMismatches.length > 0 || visualConflict;
    const tier = exactEan
      ? needsManualReview
        ? "low"
        : "high"
      : !titleFallback
        ? "low"
        : evaluation.verdict === "strong" && !needsManualReview
          ? "medium"
          : needsManualReview
            ? "low"
            : candidate.tier;
    const visualReason = evaluation.reason;

    verified.push({
      ...candidate,
      tier,
      visualVerdict: evaluation.verdict,
      visualReason,
      titleWordCoverage: coverage,
      reason: reasonForCandidate(evaluation.verdict, visualReason, coverage, identityMismatches, exactEan),
    });
  });

  verified.sort(compareCandidates);
  if (!verified.length) {
    return {
      ...response,
      status: "not-found",
      message: "No Amazon UK listings were returned in the top search options.",
      bestCandidate: null,
      candidates: [],
    };
  }

  const bestCandidate = verified[0];
  return {
    ...response,
    status: bestCandidate.tier,
    message: bestCandidate.reason,
    bestCandidate,
    candidates: verified,
  };
}
