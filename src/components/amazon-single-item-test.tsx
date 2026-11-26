"use client";

import { useState, type FormEvent, type KeyboardEvent } from "react";
import { ArrowRight, Clock3, ExternalLink, Image as ImageIcon } from "lucide-react";
import { AmazonMatchCard } from "@/components/amazon-match-card";
import { getApiErrorMessage } from "@/lib/amazon-api-errors";
import { buildAmazonProductSearchQuery, buildAmazonSearchUrl } from "@/lib/amazon-search-url";
import { verifyAmazonCandidates } from "@/lib/amazon-visual-matching";
import type { AmazonMatchResponse, AmazonMatchRow, AmazonProductInput, AmazonSearchCandidate } from "@/lib/amazon-types";

interface ImageQueryResponse {
  labelText?: string;
  error?: string;
}

export function AmazonSingleItemTest() {
  const [title, setTitle] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [size, setSize] = useState("");
  const [pack, setPack] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [stage, setStage] = useState<"image" | "brand" | "search" | "visual" | null>(null);
  const [isRetryingVisual, setIsRetryingVisual] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [searchPhrase, setSearchPhrase] = useState("");
  const [searchUrl, setSearchUrl] = useState("");
  const [result, setResult] = useState<AmazonMatchRow | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const productTitle = title.trim();
    const productImageUrl = imageUrl.trim();
    const productSize = size.trim();
    const productPack = pack.trim();

    if (!productTitle && !productImageUrl) {
      setSearchUrl("");
      setErrorMessage("Add a product title, an image URL, or both to run a test.");
      return;
    }

    const initialSearchQuery = buildAmazonProductSearchQuery({ title: productTitle, size: productSize });
    setSearchUrl(initialSearchQuery ? buildAmazonSearchUrl(initialSearchQuery) : "");
    setErrorMessage("");
    setResult(null);
    setSearchPhrase("");
    setIsRunning(true);

    try {
      let imageTerms = "";
      let imageAnalysisWarning = "";
      if (productImageUrl) {
        setStage("image");
        const imageResponse = await fetch("/api/amazon/image-query", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: productTitle, size: productSize, pack: productPack, imageUrl: productImageUrl }),
        });
        const imagePayload = (await imageResponse.json().catch(() => null)) as ImageQueryResponse | null;
        if (!imageResponse.ok || !imagePayload) {
          const imageError = getApiErrorMessage(imagePayload, "Image label reading is unavailable.", imageResponse.status);
          if (!productTitle) {
            throw new Error(`${imageError}. Add a title to create an Amazon UK search URL.`);
          }
          imageAnalysisWarning = `Image label reading was unavailable (${imageError}); the title and item size were still searched.`;
        } else {
          imageTerms = typeof imagePayload.labelText === "string" ? imagePayload.labelText.trim() : "";
          if (!imageTerms) {
            imageAnalysisWarning = "No readable product-label text was found; the supplied title and item size were still searched.";
          }
        }
      }

      const searchTitle = productTitle || imageTerms;
      if (!searchTitle) {
        throw new Error("The image did not provide searchable product details. Add the product title to continue.");
      }

      const primarySearchQuery = buildAmazonProductSearchQuery({
        title: productTitle,
        imageTerms,
        size: productSize,
      });
      setSearchPhrase(primarySearchQuery);
      setSearchUrl(buildAmazonSearchUrl(primarySearchQuery));
      setStage("brand");
      const matchResponse = await fetch("/api/amazon/match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ean: "",
          title: searchTitle,
          image_terms: productTitle ? imageTerms : "",
          brand: "",
          variant: "",
          size: productSize,
          pack: productPack,
          category: "",
          regal_image_url: productImageUrl,
        }),
      });
      const matchPayload = await matchResponse.json().catch(() => null);
      if (!matchResponse.ok || !matchPayload || typeof matchPayload !== "object" || !("status" in matchPayload)) {
        throw new Error(
          getApiErrorMessage(matchPayload, "The Amazon matcher did not return product results.", matchResponse.status),
        );
      }

      const match = matchPayload as AmazonMatchResponse;
      const sourceProduct: AmazonProductInput = {
        ean: "",
        title: productTitle,
        brand: "",
        variant: "",
        size: productSize,
        pack: productPack,
        regalImageUrl: productImageUrl,
        imageTerms,
      };
      const discoveredBrand = typeof match.discoveredBrand === "string" ? match.discoveredBrand.trim() : "";
      const resolvedProduct = { ...sourceProduct, brand: discoveredBrand };
      if (discoveredBrand && !primarySearchQuery.toLowerCase().includes(discoveredBrand.toLowerCase())) {
        const refinedSearchQuery = buildAmazonProductSearchQuery({
          brand: discoveredBrand,
          title: productTitle,
          imageTerms,
          size: productSize,
        });
        setSearchPhrase(refinedSearchQuery);
        setSearchUrl(buildAmazonSearchUrl(refinedSearchQuery));
      }
      setStage("visual");
      const verifiedMatch = await verifyAmazonCandidates(resolvedProduct, match);
      setResult({
        ...resolvedProduct,
        brandSource: discoveredBrand ? "amazon" : undefined,
        title: productTitle,
        regalImageUrl: verifiedMatch.regalImageUrl || productImageUrl,
        rowNumber: 0,
        key: "single-item-test",
        status: verifiedMatch.status,
        message: imageAnalysisWarning ? `${verifiedMatch.message} ${imageAnalysisWarning}` : verifiedMatch.message,
        bestCandidate: verifiedMatch.bestCandidate,
        candidates: verifiedMatch.candidates ?? [],
        scannedCandidateCount: match.scannedCandidateCount ?? match.candidates.length,
        decision: null,
      });
    } catch (error) {
      setErrorMessage(
        error instanceof TypeError && error.message === "Failed to fetch"
          ? "Could not reach the Amazon matcher. Use the Amazon UK search URL below to review this item."
          : error instanceof Error
            ? error.message
            : "The single-item test could not be completed. Use the Amazon UK search URL below to review this item.",
      );
    } finally {
      setIsRunning(false);
      setStage(null);
    }
  }

  function updateDecision(_rowNumber: number, decision: "confirmed" | "rejected") {
    setResult((current) => (current ? { ...current, decision } : current));
  }

  function updateCandidate(_rowNumber: number, candidate: AmazonSearchCandidate) {
    setResult((current) =>
      current
        ? { ...current, status: candidate.tier, message: candidate.reason, bestCandidate: candidate, decision: null }
        : current,
    );
  }

  function updateCandidateDetails(_rowNumber: number, candidate: AmazonSearchCandidate) {
    setResult((current) => {
      if (!current) return current;
      const matches = (existing: AmazonSearchCandidate) =>
        candidate.asin && existing.asin
          ? candidate.asin === existing.asin
          : candidate.productUrl && existing.productUrl
            ? candidate.productUrl === existing.productUrl
            : candidate.title === existing.title;
      const updatesBestCandidate = current.bestCandidate !== null && matches(current.bestCandidate);
      return {
        ...current,
        status: updatesBestCandidate ? candidate.tier : current.status,
        message: updatesBestCandidate ? candidate.reason : current.message,
        candidates: current.candidates.map((existing) => (matches(existing) ? candidate : existing)),
        bestCandidate: updatesBestCandidate ? candidate : current.bestCandidate,
      };
    });
  }

  async function retryVisualMatch() {
    if (!result?.regalImageUrl || !result.candidates.length || isRetryingVisual) return;
    setIsRetryingVisual(true);
    try {
      const response: AmazonMatchResponse = {
        status: "low",
        message: "Retrying the required visual comparison.",
        regalImageUrl: result.regalImageUrl,
        bestCandidate: null,
        candidates: result.candidates,
        scannedCandidateCount: result.scannedCandidateCount,
        searchedQueries: [],
      };
      const verified = await verifyAmazonCandidates(result, response);
      setResult((current) => current ? {
        ...current,
        status: verified.status,
        message: verified.message,
        bestCandidate: verified.bestCandidate,
        candidates: verified.candidates,
        decision: null,
      } : current);
    } finally {
      setIsRetryingVisual(false);
    }
  }

  return (
    <section className="single-item-test" aria-labelledby="single-item-test-title">
      <div className="single-item-test-heading">
        <div>
          <p className="section-kicker">Quick test · one product</p>
          <h2 id="single-item-test-title">Test a single item</h2>
          <p className="single-item-test-description">
              When no brand is supplied, likely Amazon listings are opened one at a time to read it before a refined search. Brand and exact item size narrow candidates; pack counts may differ. Title and image evidence stay separate and must also align.

          </p>
        </div>
        <span className="single-item-test-icon" aria-hidden="true"><ImageIcon size={17} /></span>
      </div>

      <form
        className="single-item-test-form"
        onSubmit={handleSubmit}
        onKeyDown={(event: KeyboardEvent<HTMLFormElement>) => {
          if (event.key === "Enter" && (event.nativeEvent.isComposing || event.keyCode === 229)) {
            event.preventDefault();
          }
        }}
      >
        <div className="single-item-test-grid">
          <label className="single-item-test-field" htmlFor="single-item-title">
            <span>Product title <small>optional</small></span>
            <input
              id="single-item-title"
              type="text"
              autoComplete="off"
              maxLength={240}
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
                setSearchUrl("");
              }}
              placeholder="e.g. Carex sensitive handwash"
              disabled={isRunning}
            />
          </label>
          <label className="single-item-test-field" htmlFor="single-item-image-url">
            <span>Image URL <small>optional</small></span>
            <input
              id="single-item-image-url"
              type="url"
              maxLength={2048}
              value={imageUrl}
              onChange={(event) => {
                setImageUrl(event.target.value);
                setSearchUrl("");
              }}
              placeholder="https://example.com/product.jpg"
              aria-describedby="single-item-image-note"
              disabled={isRunning}
            />
          </label>
          <label className="single-item-test-field" htmlFor="single-item-size">
            <span>Size <small>optional</small></span>
            <input
              id="single-item-size"
              type="text"
              maxLength={80}
              value={size}
              onChange={(event) => {
                setSize(event.target.value);
                setSearchUrl("");
              }}
              placeholder="e.g. 250ml"
              disabled={isRunning}
            />
          </label>
          <label className="single-item-test-field" htmlFor="single-item-pack">
            <span>Pack <small>optional</small></span>
            <input
              id="single-item-pack"
              type="text"
              maxLength={40}
              value={pack}
              onChange={(event) => {
                setPack(event.target.value);
                setSearchUrl("");
              }}
              placeholder="e.g. 1 or 6"
              disabled={isRunning}
            />
          </label>
        </div>
        <div className="single-item-test-actions">
          <p id="single-item-image-note" className="single-item-test-note">
            Images must be public HTTPS links and 5 MB or smaller. Readable label text and item size narrow the search; pack count may differ. Strong title and image evidence are required to confirm a match.
          </p>
          <button type="submit" className="primary-button single-item-test-button" disabled={isRunning}>
            {isRunning ? <><Clock3 size={15} aria-hidden="true" /> {stage === "image" ? "Analyzing image…" : stage === "brand" ? "Finding the product brand…" : stage === "visual" ? "Comparing product images…" : "Searching Amazon…"}</> : <>Test item <ArrowRight size={15} aria-hidden="true" /></>}
          </button>
        </div>
      </form>

      {errorMessage ? <p className="inline-error" role="alert">{errorMessage}</p> : null}
      {searchUrl ? (
        <div className="single-item-browser-search">
          <strong>Search manually on Amazon UK</strong>
          <a href={searchUrl} target="_blank" rel="noopener noreferrer">
            Open Amazon UK search results <ExternalLink size={12} aria-hidden="true" />
          </a>
          <code>{searchUrl}</code>
        </div>
      ) : null}
      {isRunning ? <p className="single-item-test-status" role="status" aria-live="polite">{stage === "image" ? "Building search details from the image…" : stage === "brand" ? "Opening likely Amazon listings one at a time to read their brand details…" : stage === "visual" ? "Comparing the source image with Amazon images…" : "Searching Amazon UK…"}</p> : null}
      {result ? (
        <div className="single-item-test-result">
          <p className="single-item-search-phrase"><strong>Search phrase:</strong> {searchPhrase}</p>
          <div className="amazon-results-list">
            <AmazonMatchCard
            result={result}
            onDecision={updateDecision}
            onCandidateSelect={updateCandidate}
            onCandidateDetails={updateCandidateDetails}
            onRetryVisual={retryVisualMatch}
            isVisualRetrying={isRetryingVisual}
            isVisualRetryBusy={isRetryingVisual}
          />
          </div>
        </div>
      ) : null}
    </section>
  );
}
