import assert from "node:assert/strict";
import { test } from "node:test";
import {
  titleMeetsFallbackThreshold,
  titleWordCoverage,
  TITLE_WORD_MATCH_THRESHOLD,
  updateAmazonTitleMatch,
  verifyAmazonCandidates,
} from "./amazon-visual-matching.ts";

test("the full Amazon page title replaces a short search label in title scoring", () => {
  const listing = candidate("Spontex", {
    amazonTitle: "Spontex Heavy Duty Scourer Pads, Pack of 3",
    visualVerdict: "possible",
    visualReason: "The green packaging and label are similar.",
  });

  const updated = updateAmazonTitleMatch("Spontex Heavy Duty Scourer Pads", listing);

  assert.equal(updated.titleWordCoverage, 1);
  assert.match(updated.reason, /100%/);
});

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
    imageMatchScore: null,
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

test("visual conflicts stay visible for review while the stronger item ranks first", async () => {
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
      { index: 0, verdict: "different", imageMatchScore: 12, reason: "Red Radox twin bottles differ from the teal source bottle." },
      { index: 1, verdict: "strong", imageMatchScore: 94, reason: "Teal package and Imperial Leather label align with the source." },
    ],
    () => verifyAmazonCandidates(product, matchResponse([unrelated, intended])),
  );

  assert.equal(result.candidates.length, 2);
  assert.equal(result.bestCandidate.title, intended.title);
  assert.equal(result.bestCandidate.tier, "medium");
  assert.equal(result.bestCandidate.visualVerdict, "strong");
  assert.equal(result.bestCandidate.imageMatchScore, 94);
  assert.equal(result.candidates[1].imageMatchScore, 12);
  assert.equal(result.candidates[1].title, unrelated.title);
  assert.equal(result.candidates[1].tier, "low");
  assert.equal(result.candidates[1].visualVerdict, "different");
});

test("strong visuals reorder options without bypassing the title gate", async () => {
  const product = {
    ean: "",
    title: "Spontex Heavy Duty Scourer Pads",
    brand: "Spontex",
    variant: "",
    size: "",
    pack: "",
    regalImageUrl: "https://regalsales.co.uk/product/image/source.jpg",
  };
  const titleHeavy = candidate("Spontex Heavy Duty Scourer Pads 3 Pack");
  const visualMatch = candidate("Green Scourer Pad", { brandMatch: false, titleScore: 0.2 });

  const result = await withVisualEvaluations(
    [
      { index: 0, verdict: "different", imageMatchScore: 15, reason: "The package silhouette and colors differ." },
      { index: 1, verdict: "strong", imageMatchScore: 92, reason: "The green pack and label match the source image." },
    ],
    () => verifyAmazonCandidates(product, matchResponse([titleHeavy, visualMatch])),
  );

  assert.equal(result.bestCandidate, null);
  assert.equal(result.status, "low");
  assert.equal(result.candidates[0].title, visualMatch.title);
  assert.ok(result.candidates[0].titleWordCoverage < result.candidates[1].titleWordCoverage);
  assert.equal(result.candidates[0].imageMatchScore, 92);
});

test("OCR label words do not increase the separate title match score", async () => {
  const product = {
    ean: "",
    title: "Imperial Leather Bath Soak",
    brand: "Imperial Leather",
    variant: "",
    size: "",
    pack: "",
    imageTerms: "green bottle citrus refill",
    regalImageUrl: "https://regalsales.co.uk/product/image/source.jpg",
  };
  const listing = candidate("Green bottle citrus refill");

  const result = await withVisualEvaluations(
    [{ index: 0, verdict: "uncertain", imageMatchScore: 48, reason: "The label is not fully legible." }],
    () => verifyAmazonCandidates(product, matchResponse([listing])),
  );

  assert.equal(result.bestCandidate, null);
  assert.equal(result.candidates[0].titleWordCoverage, 0);
  assert.equal(result.candidates[0].imageMatchScore, 48);
});

test("image-only lookups leave the title score unscored", async () => {
  const product = {
    ean: "",
    title: "",
    brand: "",
    variant: "",
    size: "",
    pack: "",
    imageTerms: "green sponge pack",
    regalImageUrl: "https://regalsales.co.uk/product/image/source.jpg",
  };

  const result = await withVisualEvaluations(
    [{ index: 0, verdict: "possible", imageMatchScore: 72, reason: "The green package is similar." }],
    () => verifyAmazonCandidates(product, matchResponse([candidate("Green sponge pack")])),
  );

  assert.equal(result.bestCandidate, null);
  assert.equal(result.status, "low");
  assert.equal(result.candidates[0].titleWordCoverage, undefined);
  assert.equal(result.candidates[0].imageMatchScore, 72);
});

test("inconclusive imagery retains low-overlap options from the search results", async () => {
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

  assert.equal(result.candidates.length, 2);
  assert.equal(result.bestCandidate, null);
  assert.equal(result.status, "low");
  assert.equal(result.candidates.find((item) => item.title === closeTitle.title).visualVerdict, "uncertain");
  assert.ok(result.candidates.some((item) => item.title === categoryOnly.title));
  assert.equal(result.candidates.find((item) => item.title === categoryOnly.title).tier, "low");
});

test("unavailable image checks never produce a confident title-only match", async () => {
  const product = {
    ean: "",
    title: "Spontex Heavy Duty Scourer Pads",
    brand: "Spontex",
    variant: "",
    size: "3pk",
    pack: "6",
    regalImageUrl: "https://regalsales.co.uk/product/image/source.jpg",
  };
  const listing = candidate("Spontex Heavy Duty Scourer Pads 3pk Pack of 6", { tier: "medium" });

  const result = await withVisualEvaluations(
    [{ index: 0, verdict: "unavailable", imageMatchScore: null, reason: "The supplier image could not be loaded." }],
    () => verifyAmazonCandidates(product, matchResponse([listing])),
  );

  assert.equal(result.status, "low");
  assert.equal(result.bestCandidate, null);
  assert.equal(result.candidates[0].tier, "low");
  assert.equal(result.candidates[0].imageMatchScore, null);
  assert.match(result.candidates[0].visualReason, /supplier image could not be loaded/i);
});

test("all five low-overlap Amazon options remain available for manual selection", async () => {
  const product = {
    ean: "",
    title: "Imperial Leather Bath Muscle Soak Bergamot Sensitive Aloe Botanical Celestial Herbal",
    brand: "",
    variant: "",
    size: "",
    pack: "",
    regalImageUrl: "https://regalsales.co.uk/product/image/source.jpg",
  };
  const candidates = Array.from({ length: 5 }, (_, index) =>
    candidate(`Imperial Radox Body Wash Option ${index + 1}`, {
      asin: `B000LOW0${index + 1}`,
      brandMatch: false,
    }),
  );
  const evaluations = candidates.map((_, index) => ({
    index,
    verdict: "different",
    reason: "The package looks different from the source.",
  }));

  const result = await withVisualEvaluations(evaluations, () =>
    verifyAmazonCandidates(product, matchResponse(candidates)),
  );

  assert.equal(result.status, "low");
  assert.equal(result.candidates.length, 5);
  assert.ok(result.candidates.every((item) => item.tier === "low"));
  assert.ok(result.candidates.every((item) => item.titleWordCoverage < TITLE_WORD_MATCH_THRESHOLD));
  assert.ok(result.candidates.every((item) => Math.round(item.titleWordCoverage * 100) === 10));
});
