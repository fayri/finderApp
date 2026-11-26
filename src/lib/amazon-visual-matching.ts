import type {
  AmazonMatchResponse,
  AmazonProductInput,
  AmazonSearchCandidate,
} from "@/lib/amazon-types";

export const TITLE_WORD_MATCH_THRESHOLD = 0.9;
export const MIN_VISUAL_MATCH_SCORE = 85;

export type VisualVerdict = "strong" | "possible" | "different" | "uncertain" | "unavailable";

interface VisualEvaluation {
  index: number;
  verdict: VisualVerdict;
  imageMatchScore: number | null;
  reason: string;
}

const MAX_VISUAL_CANDIDATES_PER_REQUEST = 5;
const MAX_VISIBLE_CANDIDATES = 5;

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
    .replace(/\b\d{1,3}\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*(millilitres?|milliliters?|ml)\b/gi, "$1ml")
    .replace(/\b(\d+(?:[.,]\d+)?)\s*(millilitres?|milliliters?|ml)\s*[x×]\s*\d{1,3}\b/gi, "$1ml")
    .replace(/\b(\d+(?:[.,]\d+)?)\s*(millilitres?|milliliters?|ml)\b/gi, "$1ml")
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
  return mismatches;
}

function isStrongVisualMatch(verdict: VisualVerdict, imageMatchScore: number | null): boolean {
  return verdict === "strong" && imageMatchScore !== null && imageMatchScore >= MIN_VISUAL_MATCH_SCORE;
}

function evaluationFallback(index: number): VisualEvaluation {
  return {
    index,
    verdict: "unavailable",
    imageMatchScore: null,
    reason: "Visual comparison was unavailable; no automatic match can be made without image evidence.",
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
  const evaluations = candidates.map((_, index) => evaluationFallback(index));
  if (!response.regalImageUrl && !product.regalImageUrl) return evaluations;

  for (let offset = 0; offset < candidates.length; offset += MAX_VISUAL_CANDIDATES_PER_REQUEST) {
    if (signal?.aborted) break;
    const batch = candidates.slice(offset, offset + MAX_VISUAL_CANDIDATES_PER_REQUEST);

    try {
      const result = await fetch("/api/amazon/visual-match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceImageUrl: response.regalImageUrl || product.regalImageUrl,
          candidates: batch.map(({ imageUrl }) => ({ imageUrl })),
        }),
        signal,
      });
      const payload = (await result.json().catch(() => null)) as { evaluations?: unknown } | null;
      if (!result.ok || !payload || !Array.isArray(payload.evaluations)) continue;

      const parsed = payload.evaluations.flatMap((value): VisualEvaluation[] => {
        if (!value || typeof value !== "object") return [];
        const item = value as Record<string, unknown>;
        if (
          typeof item.index !== "number" ||
          !Number.isInteger(item.index) ||
          item.index < 0 ||
          item.index >= batch.length ||
          !validVerdict(item.verdict)
        ) {
          return [];
        }
        const imageMatchScore =
          typeof item.imageMatchScore === "number" &&
          Number.isInteger(item.imageMatchScore) &&
          item.imageMatchScore >= 0 &&
          item.imageMatchScore <= 100
            ? item.imageMatchScore
            : null;
        return [
          {
            index: offset + item.index,
            verdict: item.verdict,
            imageMatchScore,
            reason:
              typeof item.reason === "string" && item.reason.trim()
                ? item.reason.trim().slice(0, 240)
                : "The visual review did not provide a clear explanation.",
          },
        ];
      });
      for (const evaluation of parsed) evaluations[evaluation.index] = evaluation;
    } catch {
      if (signal?.aborted) break;
    }
  }

  return evaluations;
}

function reasonForCandidate(
  verdict: VisualVerdict,
  visualReason: string,
  titleCoverage: number | null,
  mismatches: string[],
  exactEan: boolean,
): string {
  const titlePercent = titleCoverage === null ? null : Math.round(titleCoverage * 100);
  const mismatchText = mismatches.length
    ? ` The ${mismatches.join(", ")} also needs review.`
    : "";

  if (exactEan && verdict === "different") {
    return `The EAN matches, but the image review found a visual conflict: ${visualReason}${mismatchText}`;
  }
  if (exactEan && verdict === "strong" && mismatches.length === 0 && titlePercent !== null && titlePercent >= TITLE_WORD_MATCH_THRESHOLD * 100) {
    return `The EAN, product title, and visual evidence align.${mismatchText}`;
  }
  if (exactEan && verdict !== "strong") {
    return `The EAN appears in the Amazon result, but visual evidence is not strong enough to confirm the same product. ${visualReason}${mismatchText}`;
  }
  if (exactEan && titlePercent !== null && titlePercent < TITLE_WORD_MATCH_THRESHOLD * 100) {
    return `The EAN appears in the Amazon result, but only ${titlePercent}% of meaningful title words overlap; title and image evidence must also align.${mismatchText}`;
  }
  if (verdict === "strong") {
    const titleNote = titlePercent === null
      ? " No source title was provided to score."
      : titlePercent < 90
        ? ` Only ${titlePercent}% of meaningful source title words overlap, so verify the label and variant before confirming.`
        : "";
    return `Strong visual evidence: ${visualReason}${titleNote}${mismatchText}`;
  }
  if (verdict === "different") {
    const titleNote = titlePercent === null
      ? " No source title was supplied for text comparison."
      : ` The listing is retained for manual review because ${titlePercent}% of meaningful source title words overlap.`;
    return `The image review conflicts with the title match: ${visualReason}${titleNote}${mismatchText}`;
  }
  const titleNote = titlePercent === null
    ? "No source title was supplied for text comparison."
    : `${titlePercent}% of meaningful source title words overlap.`;
  return `The visual review was ${verdict === "unavailable" ? "unavailable" : "inconclusive"}; ${titleNote}${mismatchText} Compare the label, variant, size, and pack before confirming.`;
}

export function updateAmazonTitleMatch(
  sourceTitle: string,
  candidate: AmazonSearchCandidate,
): AmazonSearchCandidate {
  const title = candidate.amazonTitle || candidate.title;
  const coverage = sourceTitle.trim() ? titleWordCoverage(sourceTitle, title) : null;
  const exactEan = candidate.eanMatch;
  const identityMismatches = candidateIdentityMismatch(candidate);
  const reviewMismatches = identityMismatches;
  const rawVisualVerdict = candidate.visualVerdict ?? "unavailable";
  const imageMatchScore = candidate.imageMatchScore ?? null;
  const strongVisualMatch = isStrongVisualMatch(rawVisualVerdict, imageMatchScore);
  const visualVerdict = rawVisualVerdict === "strong" && !strongVisualMatch ? "possible" : rawVisualVerdict;
  const visualReason =
    rawVisualVerdict === "strong" && !strongVisualMatch
      ? `The visual score is below the ${MIN_VISUAL_MATCH_SCORE}% match threshold. ${candidate.visualReason ?? "The visual review did not provide a clear explanation."}`
      : candidate.visualReason ?? "The visual review did not provide a clear explanation.";
  const titleFallback = titleMeetsFallbackThreshold(sourceTitle, title);
  const qualifies = titleFallback && strongVisualMatch && identityMismatches.length === 0;
  const tier = qualifies ? (exactEan ? "high" : "medium") : "low";

  return {
    ...candidate,
    tier,
    visualVerdict,
    visualReason,
    titleWordCoverage: coverage ?? undefined,
    reason: reasonForCandidate(
      visualVerdict,
      visualReason,
      coverage,
      reviewMismatches,
      exactEan,
    ),
  };
}

function candidateRank(candidate: AmazonSearchCandidate): [number, number, number, number, number, number, number, number] {
  const visualRank = candidate.visualVerdict === "strong"
    ? 4
    : candidate.visualVerdict === "possible"
      ? 3
      : candidate.visualVerdict === "uncertain"
        ? 2
        : candidate.visualVerdict === "unavailable"
          ? 1
          : 0;
  const imageScore = typeof candidate.imageMatchScore === "number" ? candidate.imageMatchScore : 0;
  const titleScore = candidate.titleWordCoverage ?? 0;
  const sizeRank = candidate.sizeMatch ? 1 : 0;
  const variantRank = candidate.variantMatch === false ? 0 : 1;
  const brandRank = candidate.brandMatch === false ? 0 : 1;
  const eanRank = candidate.eanMatch && candidate.visualVerdict !== "different" ? 1 : 0;
  const packRank = Number(
    candidate.packMatchType === "exact" || candidate.packMatchType === "single-item-fallback",
  );
  return [sizeRank, brandRank, variantRank, eanRank, titleScore, visualRank, imageScore, packRank];
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
    ? response.candidates
    : response.bestCandidate
      ? [response.bestCandidate]
      : [];
  if (!candidates.length) return response;

  const evaluations = await requestVisualEvaluations(product, response, candidates, signal);
  const verified: AmazonSearchCandidate[] = [];

  candidates.forEach((candidate, index) => {
    const evaluation = evaluations[index] ?? evaluationFallback(index);
    const sourceTitle = [product.brand, product.title, product.variant, product.size].filter(Boolean).join(" ");
    const candidateTitle = candidate.amazonTitle || candidate.title;
    const coverage = sourceTitle ? titleWordCoverage(sourceTitle, candidateTitle) : null;
    const exactEan = candidate.eanMatch;
    const titleFallback = titleMeetsFallbackThreshold(sourceTitle, candidateTitle);
    const identityMismatches = candidateIdentityMismatch(candidate);
    const reviewMismatches = identityMismatches;
    const visualScore = evaluation.imageMatchScore;
    const strongVisualMatch = isStrongVisualMatch(evaluation.verdict, visualScore);
    const visualVerdict = evaluation.verdict === "strong" && !strongVisualMatch ? "possible" : evaluation.verdict;
    const qualifies = titleFallback && strongVisualMatch && identityMismatches.length === 0;
    const tier = qualifies ? (exactEan ? "high" : "medium") : "low";
    const visualReason =
      evaluation.verdict === "strong" && !strongVisualMatch
        ? `The visual score is below the ${MIN_VISUAL_MATCH_SCORE}% match threshold. ${evaluation.reason}`
        : evaluation.reason;

    verified.push({
      ...candidate,
      tier,
      visualVerdict,
      visualReason,
      imageMatchScore: visualScore,
      titleWordCoverage: coverage ?? undefined,
      reason: reasonForCandidate(visualVerdict, visualReason, coverage, reviewMismatches, exactEan),
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

  const topCandidates = verified.slice(0, MAX_VISIBLE_CANDIDATES);
  const bestCandidate = topCandidates.find((candidate) => candidate.tier === "high" || candidate.tier === "medium") ?? null;
  return {
    ...response,
    status: bestCandidate?.tier ?? "low",
    message: bestCandidate?.reason ?? `No listing passed both the ${Math.round(TITLE_WORD_MATCH_THRESHOLD * 100)}% title-match requirement and a strong visual match (at least ${MIN_VISUAL_MATCH_SCORE}%). Nothing was selected automatically; review the options below.`,
    bestCandidate,
    candidates: topCandidates,
    scannedCandidateCount: response.scannedCandidateCount ?? candidates.length,
  };
}
