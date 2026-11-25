import assert from "node:assert/strict";
import { test } from "node:test";
import {
  titleMeetsFallbackThreshold,
  titleWordCoverage,
  TITLE_WORD_MATCH_THRESHOLD,
  verifyAmazonCandidates,
} from "./amazon-visual-matching.ts";

test("Amazon title fallback allows extra candidate words", () => {
  const coverage = titleWordCoverage(
    "Imperial Leather Bath Muscle Soak Bergamot",
    "2X Imperial Leather Bath Muscle Soak Bergamot 500ml",
  );

  assert.equal(coverage, 1);
});

test("Amazon title fallback measures source-word coverage, not candidate length", () => {
  const coverage = titleWordCoverage(
    "Imperial Leather Bath Muscle Soak Bergamot",
    "Imperial Leather Bath Muscle Soak",
  );

  assert.equal(coverage, 4 / 5);
  assert.ok(coverage < TITLE_WORD_MATCH_THRESHOLD);
});

test("generic category words alone cannot satisfy title fallback", () => {
  const coverage = titleWordCoverage("Bath soap", "Bath soap products");

  assert.equal(coverage, 0);
  assert.equal(titleMeetsFallbackThreshold("Bath soap", "Bath soap products"), false);
});

test("Amazon title fallback ignores common grammar words", () => {
  const coverage = titleWordCoverage(
    "The Imperial Leather Bath Soak with Bergamot",
    "Imperial Leather Bath Soak Bergamot extra words",
  );

  assert.equal(coverage, 1);
});

function candidate(title, overrides = {}) {
  return {
    asin: "B000TEST",
    title,
    imageUrl: "https://m.media-amazon.com/images/I/test.jpg",
    productUrl: "https://www.amazon.co.uk/dp/B000TEST",
    price: "",
    tier: "low",
    reason: "Candidate from the text search.",
    titleScore: 0.5,
    eanMatch: false,
    brandMatch: true,
    variantMatch: true,
    sizeMatch: true,
    packMatch: true,
    searchedBy: "detail",
    ...overrides,
  };
}

function matchResponse(candidates) {
  return {
    status: "low",
    message: "Candidates need review.",
    regalImageUrl: "https://regalsales.co.uk/product/image/source.jpg",
    bestCandidate: candidates[0] ?? null,
    candidates,
    searchedQueries: [],
  };
}

async function withVisualEvaluations(evaluations, callback) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ evaluations }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  try {
    return await callback();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("visual conflict rejects a category-level title candidate while retaining the true item", async () => {
  const product = {
    ean: "",
    title: "Imperial Leather Bath Muscle Soak Bergamot",
    brand: "Imperial Leather",
    variant: "",
    size: "500ml",
    pack: "4",
    regalImageUrl: "https://regalsales.co.uk/product/image/source.jpg",
  };
  const unrelated = candidate("2X Radox Muscle Therapy Bath Soak 500ml Black Pepper Ginseng Blend", {
    brandMatch: false,
    variantMatch: false,
    packMatch: false,
  });
  const intended = candidate("Imperial Leather Bergamot Muscle Soak 500ml Pack of 4");

  const result = await withVisualEvaluations(
    [
      { index: 0, verdict: "different", reason: "Red Radox twin bottles differ from the teal source bottle." },
      { index: 1, verdict: "strong", reason: "Teal package and Imperial Leather label align with the source." },
    ],
    () => verifyAmazonCandidates(product, matchResponse([unrelated, intended])),
  );

  assert.equal(result.candidates.length, 1);
  assert.equal(result.bestCandidate.title, intended.title);
  assert.equal(result.bestCandidate.tier, "medium");
  assert.equal(result.bestCandidate.visualVerdict, "strong");
});

test("inconclusive imagery keeps candidates only when distinctive title terms meet the fallback", async () => {
  const product = {
    ean: "",
    title: "Imperial Leather Bath Muscle Soak Bergamot",
    brand: "Imperial Leather",
    variant: "",
    size: "500ml",
    pack: "4",
    regalImageUrl: "https://regalsales.co.uk/product/image/source.jpg",
  };
  const closeTitle = candidate("Imperial Leather Muscle Soak Bergamot Limited Edition");
  const categoryOnly = candidate("Bath soap products", { tier: "medium" });

  const result = await withVisualEvaluations(
    [
      { index: 0, verdict: "uncertain", reason: "The label is too small to read." },
      { index: 1, verdict: "uncertain", reason: "Only generic product type is visible." },
    ],
    () => verifyAmazonCandidates(product, matchResponse([closeTitle, categoryOnly])),
  );

  assert.equal(result.candidates.length, 1);
  assert.equal(result.bestCandidate.title, closeTitle.title);
  assert.equal(result.bestCandidate.visualVerdict, "uncertain");
});
