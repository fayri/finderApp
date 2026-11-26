import { load } from "cheerio";
import type { LookupResult } from "@/lib/types";

export const maxDuration = 30;

const REGAL_ORIGIN = "https://regalsales.co.uk";
const UPSTREAM_INTERVAL_MS = 10_000;
const MATCH_TTL_MS = 6 * 60 * 60 * 1000;
const MISS_TTL_MS = 15 * 60 * 1000;
const MAX_HTML_BYTES = 4 * 1024 * 1024;

type CacheEntry = { result: LookupResult; expiresAt: number };

const resultCache = new Map<string, CacheEntry>();
let nextUpstreamAt = 0;
let upstreamBusy = false;

function emptyResult(ean: string, status: LookupResult["status"]): LookupResult {
  return {
    ean,
    imageUrl: "",
    title: "",
    pack: "",
    size: "",
    productUrl: "",
    status,
  };
}

function isProductUrl(value: string): boolean {
  try {
    const url = new URL(value, REGAL_ORIGIN);
    return url.origin === REGAL_ORIGIN && /^\/[a-z0-9-]+-\d+\/?$/i.test(url.pathname);
  } catch {
    return false;
  }
}

function absoluteRegalUrl(value: string | undefined): string {
  if (!value) return "";
  try {
    const url = new URL(value, REGAL_ORIGIN);
    return url.origin === REGAL_ORIGIN ? url.toString() : "";
  } catch {
    return "";
  }
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function findProductCard($: ReturnType<typeof load>, anchor: Parameters<ReturnType<typeof load>>[0]) {
  let current = $(anchor).parent();
  let fallback = current;

  for (let depth = 0; depth < 8 && current.length; depth += 1) {
    const productUrls = new Set(
      current
        .find("a[href]")
        .toArray()
        .map((item) => $(item).attr("href") ?? "")
        .filter(isProductUrl)
        .map((href) => new URL(href, REGAL_ORIGIN).toString()),
    );
    const text = normalizeText(current.text());
    if (current.find("img").length && productUrls.size === 1 && text.length < 1800) {
      fallback = current;
      if (/\bSize\b/i.test(text) && /\bPack\b/i.test(text)) {
        return current;
      }
    }
    current = current.parent();
  }

  return fallback;
}

function detailFromCard(
  $: ReturnType<typeof load>,
  card: ReturnType<ReturnType<typeof load>>,
  label: "size" | "pack",
): string {
  let value = "";
  card.find("dt").each((_, item) => {
    if (normalizeText($(item).text()).toLowerCase() === label) {
      value = normalizeText($(item).next("dd").text());
    }
  });
  if (value) return value;

  const text = normalizeText(card.text());
  const labeledSize = text.match(/\bSize\s*:?\s*(.+?)\s+\b(?:Pack|Layer\s+Qty|Pallet\s+Qty)\b/i)?.[1]?.trim();
  if (label === "size") {
    if (labeledSize) return labeledSize;
    return text.match(/\b(?:\d+(?:[.,]\d+)?\s*[x×]\s*)?\d+(?:[.,]\d+)?\s*(?:ml|cl|litres?|l|kg|g|mg|fl\s?oz|oz|cm|m|pcs?|pieces?|tablets?|wipes?|sachets?)\b/i)?.[0]?.trim() ?? "";
  }

  const labeledPack = text.match(/\bPack\s*:?\s*([^\s|]+)/i)?.[1]?.trim();
  if (labeledPack) return labeledPack;
  const sizeMatch = /\b(?:\d+(?:[.,]\d+)?\s*[x×]\s*)?\d+(?:[.,]\d+)?\s*(?:ml|cl|litres?|l|kg|g|mg|fl\s?oz|oz|cm|m|pcs?|pieces?|tablets?|wipes?|sachets?)\b/i.exec(text);
  if (!sizeMatch || sizeMatch.index === undefined) return "";
  return text
    .slice(sizeMatch.index + sizeMatch[0].length)
    .trim()
    .match(/^(?:Pack\s*:?\s*)?(\d{1,3})\b/i)?.[1] ?? "";
}

function imageFromCard($: ReturnType<typeof load>, card: ReturnType<ReturnType<typeof load>>): string {
  const sources: string[] = [];
  const collectSource = (image: ReturnType<ReturnType<typeof load>>) => {
    const srcset = image.attr("srcset")?.split(",")[0]?.trim().split(/\s+/)[0];
    const source = [image.attr("data-src"), image.attr("data-original"), image.attr("src"), srcset].find(
      (value) => typeof value === "string" && value.trim(),
    );
    if (source) sources.push(source.trim());
  };

  card.find("img").each((_, image) => collectSource($(image)));
  card.find("noscript").each((_, element) => {
    const fallback = load($(element).text());
    fallback("img").each((_, image) => collectSource(fallback(image)));
  });

  for (const source of sources) {
    const url = absoluteRegalUrl(source);
    if (url && url.includes("/product/image/")) return url;
  }
  return "";
}

function parseSearchResults(html: string, ean: string): LookupResult {
  const $ = load(html);
  const matches = new Map<string, LookupResult>();
  const productAnchors = $("a[href]")
    .toArray()
    .filter((anchor) => isProductUrl($(anchor).attr("href") ?? ""));
  const bodyText = normalizeText($("body").text());

  if (!productAnchors.length && bodyText.length < 500 && /enable JavaScript/i.test(bodyText)) {
    throw new Error("Regal Sales returned a JavaScript-only page without catalogue results. Open the Regal search link to check this EAN manually.");
  }

  productAnchors.forEach((anchor) => {
    const href = $(anchor).attr("href") ?? "";

    const productUrl = absoluteRegalUrl(href);
    if (!productUrl) return;

    const existing = matches.get(productUrl);
    const card = findProductCard($, anchor);
    const linkTitle = normalizeText($(anchor).text());
    const headingTitle = normalizeText(card.find("h2, h3, h4").first().text());
    const image = card.find("img").first();
    const imageTitle = normalizeText(image.attr("alt") ?? image.attr("title") ?? "");
    const candidateTitle = [linkTitle, headingTitle, imageTitle].find(
      (value) => value && value.toLowerCase() !== "loading",
    );
    const existingTitle = existing?.title && existing.title.toLowerCase() !== "loading" ? existing.title : "";

    matches.set(productUrl, {
      ean,
      imageUrl: imageFromCard($, card) || existing?.imageUrl || "",
      title: candidateTitle || existingTitle,
      pack: detailFromCard($, card, "pack") || existing?.pack || "",
      size: detailFromCard($, card, "size") || existing?.size || "",
      productUrl,
      status: "matched",
    });
  });

  return matches.values().next().value ?? emptyResult(ean, "not-found");
}

function readCache(ean: string): LookupResult | null {
  const cached = resultCache.get(ean);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    resultCache.delete(ean);
    return null;
  }
  return cached.result;
}

function writeCache(result: LookupResult): void {
  if (resultCache.size > 2_000) {
    const oldestKey = resultCache.keys().next().value;
    if (oldestKey) resultCache.delete(oldestKey);
  }
  resultCache.set(result.ean, {
    result,
    expiresAt: Date.now() + (result.status === "matched" ? MATCH_TTL_MS : MISS_TTL_MS),
  });
}

export async function POST(request: Request) {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > 1_024) {
    return Response.json({ error: "The lookup request is too large." }, { status: 413 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "Send a valid JSON request." }, { status: 400 });
  }

  const ean =
    typeof payload === "object" && payload !== null && "ean" in payload
      ? (payload as { ean?: unknown }).ean
      : undefined;
  if (typeof ean !== "string" || !/^\d{8,14}$/.test(ean)) {
    return Response.json({ error: "Enter an EAN containing 8 to 14 digits." }, { status: 400 });
  }

  const cached = readCache(ean);
  if (cached) return Response.json({ result: cached, cached: true });

  const waitMs = Math.max(0, nextUpstreamAt - Date.now());
  if (upstreamBusy || waitMs > 0) {
    const retryAfterSeconds = Math.max(1, Math.ceil(waitMs / 1_000));
    return Response.json(
      {
        error: "Regal Sales requests a 10-second gap between catalog searches.",
        retryAfterSeconds,
      },
      {
        status: 429,
        headers: { "Retry-After": String(retryAfterSeconds), "Cache-Control": "no-store" },
      },
    );
  }

  upstreamBusy = true;
  nextUpstreamAt = Date.now() + UPSTREAM_INTERVAL_MS;

  try {
    const searchUrl = new URL("/search", REGAL_ORIGIN);
    searchUrl.searchParams.set("q", ean);
    const response = await fetch(searchUrl, {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "FinderApp/1.0 (Regal Sales EAN lookup)",
      },
      cache: "no-store",
      redirect: "follow",
      signal: AbortSignal.timeout(8_000),
    });

    if (new URL(response.url).origin !== REGAL_ORIGIN) {
      throw new Error("Regal Sales redirected the lookup to an unexpected host.");
    }
    if (!response.ok) {
      throw new Error(`Regal Sales returned HTTP ${response.status}.`);
    }

    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (declaredLength > MAX_HTML_BYTES) {
      throw new Error("The Regal Sales result page was unexpectedly large.");
    }

    const html = await response.text();
    if (Buffer.byteLength(html, "utf8") > MAX_HTML_BYTES) {
      throw new Error("The Regal Sales result page was unexpectedly large.");
    }

    const result = parseSearchResults(html, ean);
    writeCache(result);
    return Response.json({ result, cached: false }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not complete the Regal Sales lookup.";
    return Response.json({ error: message }, { status: 502, headers: { "Cache-Control": "no-store" } });
  } finally {
    upstreamBusy = false;
  }
}
