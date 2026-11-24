"use client";

import { useState, type FormEvent, type KeyboardEvent } from "react";
import { ArrowRight, Clock3, Image as ImageIcon } from "lucide-react";
import { AmazonMatchCard } from "@/components/amazon-match-card";
import type { AmazonMatchResponse, AmazonMatchRow, AmazonSearchCandidate } from "@/lib/amazon-types";

interface ImageQueryResponse {
  query?: string;
  error?: string;
}

function responseError(payload: { error?: string; detail?: string; message?: string } | null, fallback: string): string {
  return payload?.error || payload?.detail || payload?.message || fallback;
}

export function AmazonSingleItemTest() {
  const [title, setTitle] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [stage, setStage] = useState<"image" | "search" | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [searchPhrase, setSearchPhrase] = useState("");
  const [result, setResult] = useState<AmazonMatchRow | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const productTitle = title.trim();
    const productImageUrl = imageUrl.trim();

    if (!productTitle && !productImageUrl) {
      setErrorMessage("Add a product title, an image URL, or both to run a test.");
      return;
    }

    setErrorMessage("");
    setResult(null);
    setSearchPhrase("");
    setIsRunning(true);

    try {
      let query = productTitle;
      if (productImageUrl) {
        setStage("image");
        const imageResponse = await fetch("/api/amazon/image-query", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: productTitle, imageUrl: productImageUrl }),
        });
        const imagePayload = (await imageResponse.json().catch(() => null)) as ImageQueryResponse | null;
        if (!imageResponse.ok || !imagePayload?.query) {
          throw new Error(responseError(imagePayload, "The image could not be analyzed."));
        }
        query = imagePayload.query;
      }

      setSearchPhrase(query);
      setStage("search");
      const matchResponse = await fetch("/api/amazon/match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ean: "",
          title: query,
          brand: "",
          variant: "",
          size: "",
          pack: "",
          regal_image_url: "",
        }),
      });
      const matchPayload = (await matchResponse.json().catch(() => null)) as
        | AmazonMatchResponse
        | { error?: string; detail?: string }
        | null;
      if (!matchResponse.ok || !matchPayload || !("status" in matchPayload)) {
        throw new Error(responseError(matchPayload, "The Amazon lookup could not be completed."));
      }

      const match = matchPayload as AmazonMatchResponse;
      setResult({
        ean: "",
        title: productTitle || query,
        brand: "",
        variant: "",
        size: "",
        pack: "",
        regalImageUrl: productImageUrl,
        rowNumber: 0,
        key: "single-item-test",
        status: match.status,
        message: match.message,
        bestCandidate: match.bestCandidate,
        candidates: match.candidates ?? [],
        decision: null,
      });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "The single-item test could not be completed.");
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

  return (
    <section className="single-item-test" aria-labelledby="single-item-test-title">
      <div className="single-item-test-heading">
        <div>
          <p className="section-kicker">Quick test · one product</p>
          <h2 id="single-item-test-title">Test a single item</h2>
          <p className="single-item-test-description">
            Enter a title, an image URL, or both. An image is analyzed to build a focused Amazon UK search phrase.
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
              onChange={(event) => setTitle(event.target.value)}
              placeholder="e.g. stainless steel water bottle"
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
              onChange={(event) => setImageUrl(event.target.value)}
              placeholder="https://example.com/product.jpg"
              aria-describedby="single-item-image-note"
              disabled={isRunning}
            />
          </label>
        </div>
        <div className="single-item-test-actions">
          <p id="single-item-image-note" className="single-item-test-note">
            Images must be public HTTPS links and 5 MB or smaller. Image-only tests use AI vision to identify search terms.
          </p>
          <button type="submit" className="primary-button single-item-test-button" disabled={isRunning}>
            {isRunning ? <><Clock3 size={15} aria-hidden="true" /> {stage === "image" ? "Analyzing image…" : "Searching Amazon…"}</> : <>Test item <ArrowRight size={15} aria-hidden="true" /></>}
          </button>
        </div>
      </form>

      {errorMessage ? <p className="inline-error" role="alert">{errorMessage}</p> : null}
      {isRunning ? <p className="single-item-test-status" role="status" aria-live="polite">{stage === "image" ? "Building a search phrase from the image…" : "Searching Amazon UK…"}</p> : null}
      {result ? (
        <div className="single-item-test-result">
          <p className="single-item-search-phrase"><strong>Search phrase:</strong> {searchPhrase}</p>
          <div className="amazon-results-list">
            <AmazonMatchCard result={result} onDecision={updateDecision} onCandidateSelect={updateCandidate} />
          </div>
        </div>
      ) : null}
    </section>
  );
}
