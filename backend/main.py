from __future__ import annotations

import json
import re
import threading
import time
import urllib.parse
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator

REGAL_ORIGIN = "https://regalsales.co.uk"
AMAZON_ORIGIN = "https://www.amazon.co.uk"
AMAZON_MIN_GAP_SECONDS = 3.0
AMAZON_TIMEOUT_SECONDS = 15
AMAZON_BLOCK_COOLDOWN_SECONDS = 60.0
MAX_PAGE_BYTES = 4 * 1024 * 1024
MAX_CANDIDATES = 8
MAX_RESULT_CANDIDATES = 5
MAX_SEARCH_QUERIES = 5
CATEGORY_DICTIONARY = json.loads(
    (Path(__file__).resolve().parent / "product_category_terms.json").read_text(encoding="utf-8")
)["categories"]

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-GB,en;q=0.9",
    "Referer": "https://www.google.com/",
    "Upgrade-Insecure-Requests": "1",
}

Tier = Literal["high", "medium", "low"]


class MatchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    ean: str = Field(default="", max_length=14)
    title: str = Field(default="", max_length=240)
    image_terms: str = Field(default="", max_length=240)
    brand: str = Field(default="", max_length=120)
    variant: str = Field(default="", max_length=120)
    size: str = Field(default="", max_length=80)
    pack: str = Field(default="", max_length=40)
    category: str = Field(default="", max_length=40)
    regal_image_url: str = Field(default="", max_length=2048)

    @field_validator("ean")
    @classmethod
    def validate_ean(cls, value: str) -> str:
        compact = re.sub(r"[\s-]", "", value)
        if compact and not re.fullmatch(r"\d{8,14}", compact):
            raise ValueError("EAN must contain 8 to 14 digits.")
        return compact

    @field_validator("title", "image_terms", "brand", "variant", "size", "pack")
    @classmethod
    def clean_supplier_fields(cls, value: str) -> str:
        cleaned = value.replace("^", "")
        return " ".join(cleaned.split())


class AmazonBlocked(Exception):
    pass


app = FastAPI(title="FinderApp Amazon Matcher", docs_url=None, redoc_url=None)
_amazon_lock = threading.Lock()
_last_amazon_request_at = 0.0
_amazon_blocked_until = 0.0


@app.middleware("http")
async def limit_lookup_body(request: Request, call_next):
    if request.url.path == "/api/amazon/match":
        content_length = int(request.headers.get("content-length", "0") or 0)
        if content_length > 16 * 1024:
            return JSONResponse({"detail": "The product lookup request is too large."}, status_code=413)
    response = await call_next(request)
    if request.url.path.startswith("/api/amazon/"):
        response.headers["Cache-Control"] = "no-store"
    return response


def clean_title(title: str) -> str:
    """Use the notebook's title cleanup before constructing marketplace searches."""
    cleaned = re.sub(r"\s*\([^)]*\)\s*", " ", title)
    cleaned = re.sub(r"\bTEMU\b", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\^+", "", cleaned)
    return " ".join(cleaned.split())


def normalize_text(value: str) -> str:
    return " ".join(value.replace("\u00a0", " ").split()).strip()


def tokens(value: str) -> set[str]:
    return set(re.findall(r"[a-z0-9]+", value.lower()))


def measurements(value: str) -> set[str]:
    pattern = re.compile(
        r"(?<!\w)(\d+(?:[.,]\d+)?)\s*(fl\s?oz|ml|cl|litres?|liters?|l|kg|mg|g|cm|mm|metres?|meters?|m|pcs?|pieces?|tablets?|wipes?|sachets?|capsules?|count|ct)\b",
        re.IGNORECASE,
    )
    result: set[str] = set()
    for number_text, unit_text in pattern.findall(value):
        number = float(number_text.replace(",", "."))
        unit = unit_text.lower().replace(" ", "").replace(".", "")
        if unit in {"l", "litre", "litres", "liter", "liters"}:
            number *= 1000
            unit = "ml"
        elif unit == "cl":
            number *= 10
            unit = "ml"
        elif unit == "kg":
            number *= 1000
            unit = "g"
        elif unit in {"piece", "pieces", "pc", "pcs", "tablet", "tablets", "wipe", "wipes", "sachet", "sachets", "capsule", "capsules", "count", "ct"}:
            unit = "count"
        result.add(f"{number:g}{unit}")
    return result


def has_pack_match(pack: str, candidate_title: str) -> bool:
    expected_numbers = re.findall(r"\d+", pack)
    if not expected_numbers:
        expected_words = tokens(pack)
        return not expected_words or expected_words.issubset(tokens(candidate_title))
    candidate_numbers = re.findall(r"\d+", candidate_title)
    return all(number in candidate_numbers for number in expected_numbers)


def exact_ean_in_text(ean: str, value: str) -> bool:
    return bool(ean and re.search(rf"(?<!\d){re.escape(ean)}(?!\d)", value))


def classify_candidate(product: MatchRequest, candidate: dict[str, Any]) -> dict[str, Any] | None:
    candidate_title = normalize_text(str(candidate.get("title", "")))
    listing_text = str(candidate.get("cardText", ""))
    candidate_tokens = tokens(candidate_title)
    product_tokens = tokens(clean_title(product.title))
    brand_tokens = tokens(clean_title(product.brand))
    variant_tokens = tokens(clean_title(product.variant))

    overlap = len(product_tokens & candidate_tokens)
    title_coverage = overlap / max(1, len(product_tokens))
    normalized_product_title = " ".join(sorted(product_tokens))
    normalized_candidate_title = " ".join(sorted(candidate_tokens))
    sequence_score = SequenceMatcher(None, normalized_product_title, normalized_candidate_title).ratio()
    direct_title_score = (title_coverage * 0.7) + (sequence_score * 0.3)
    category = CATEGORY_DICTIONARY.get(product.category, {})
    alias_tokens = [tokens(alias) for alias in category.get("aliases", [])]
    alias_tokens = [alias for alias in alias_tokens if alias]
    category_match = any(alias.issubset(candidate_tokens) for alias in alias_tokens)
    category_words = set().union(*alias_tokens) if alias_tokens else set()
    specific_product_tokens = product_tokens - category_words
    specific_overlap = len(specific_product_tokens & candidate_tokens)
    semantic_title_match = category_match and (
        not specific_product_tokens or specific_overlap >= max(1, (len(specific_product_tokens) + 2) // 3)
    )
    title_score = round(max(direct_title_score, 0.52 if semantic_title_match else 0), 3)

    brand_match = not brand_tokens or brand_tokens.issubset(candidate_tokens)
    variant_match = not variant_tokens or variant_tokens.issubset(candidate_tokens)
    expected_measurements = measurements(product.size)
    size_match = not product.size or (
        expected_measurements.issubset(measurements(candidate_title))
        if expected_measurements
        else tokens(clean_title(product.size)).issubset(candidate_tokens)
    )
    pack_match = not product.pack or has_pack_match(product.pack, candidate_title)
    exact_ean = exact_ean_in_text(product.ean, listing_text)
    direct_title_match = bool(product_tokens) and title_coverage >= 0.5 and direct_title_score >= 0.48
    nearby_title_match = (
        not direct_title_match
        and not semantic_title_match
        and bool(product_tokens)
        and title_coverage >= 0.25
        and direct_title_score >= 0.25
    )
    title_match = bool(product_tokens) and (direct_title_match or semantic_title_match or nearby_title_match)
    category_only_match = semantic_title_match and not specific_product_tokens and not product.variant and not product.size and not product.pack

    if exact_ean:
        tier: Tier = "high"
        reason = "The EAN appears exactly in the Amazon result text."
    elif title_match and brand_match and variant_match and size_match and pack_match and not category_only_match and not nearby_title_match:
        tier = "medium"
        details = ["product category" if semantic_title_match and not direct_title_match else "product title"]
        if brand_tokens:
            details.append("brand")
        if variant_tokens:
            details.append("variant")
        if product.size:
            details.append("size")
        if product.pack:
            details.append("pack")
        reason = f"The Amazon title contains the matching {' + '.join(details)}."
    elif title_match and brand_match:
        tier = "low"
        if category_only_match:
            reason = "The product category aligns, but the listing title lacks enough detail to confirm the exact item."
        elif nearby_title_match:
            reason = "Some product words align; compare the image and verify the product type and details."
        elif product.size and not size_match:
            reason = "Brand and product name align, but the size differs or is missing."
        elif product.variant and not variant_match:
            reason = "Brand and product name align, but the variant needs review."
        elif product.pack and not pack_match:
            reason = "Brand and product name align, but the pack count needs review."
        else:
            reason = "Brand and product name align; confirm the size and variant manually."
    else:
        return None

    classified = {key: value for key, value in candidate.items() if key != "cardText"}
    classified.update(
        {
            "tier": tier,
            "reason": reason,
            "titleScore": title_score,
            "eanMatch": exact_ean,
            "brandMatch": brand_match,
            "variantMatch": variant_match,
            "sizeMatch": size_match,
            "packMatch": pack_match,
        }
    )
    return classified


def safe_regal_url(value: str | None) -> str:
    if not value:
        return ""
    try:
        parsed = urlparse(urljoin(REGAL_ORIGIN, value))
        if parsed.scheme != "https" or parsed.hostname not in {"regalsales.co.uk", "www.regalsales.co.uk"}:
            return ""
        return parsed.geturl()
    except ValueError:
        return ""


def get_regal_image(ean: str) -> str:
    if not ean:
        return ""
    url = f"{REGAL_ORIGIN}/search?{urllib.parse.urlencode({'q': ean})}"
    try:
        with requests.Session() as session:
            response = session.get(url, headers=HEADERS, timeout=12, stream=True)
            if response.status_code != 200:
                return ""
            page = read_limited_response(response, MAX_PAGE_BYTES)
        soup = BeautifulSoup(page, "html.parser")
        sources: list[str] = []
        for image in soup.find_all("img"):
            source = image.get("src") or image.get("data-src") or image.get("data-lazy-src") or image.get("data-original")
            if source:
                sources.append(source)
        for element in soup.find_all("noscript"):
            fallback = BeautifulSoup(element.get_text(), "html.parser")
            for image in fallback.find_all("img"):
                source = image.get("src") or image.get("data-src")
                if source:
                    sources.append(source)
        for source in sources:
            lowered = source.lower()
            if not any(term in lowered for term in ("product", "image", "uploads")):
                continue
            if "icon" in lowered or "logo" in lowered:
                continue
            image_url = safe_regal_url(source)
            if image_url:
                return image_url
    except (requests.RequestException, ValueError):
        return ""
    return ""


def safe_amazon_image_url(value: str) -> str:
    try:
        parsed = urlparse(urljoin(AMAZON_ORIGIN, value))
        hostname = (parsed.hostname or "").lower()
        allowed_host = (
            hostname == "media-amazon.com"
            or hostname.endswith(".media-amazon.com")
            or hostname.endswith(".ssl-images-amazon.com")
        )
        if parsed.scheme != "https" or not allowed_host:
            return ""
        return parsed.geturl()
    except ValueError:
        return ""


def image_from_card(image) -> str:
    source = image.get("data-src") or image.get("data-original") or image.get("src")
    if not source:
        srcset = image.get("srcset", "").split(",")
        if srcset:
            source = srcset[0].strip().split(" ")[0]
    if not source or source.startswith("data:"):
        return ""
    return safe_amazon_image_url(source)


def asin_from_href(href: str) -> str:
    parsed = urlparse(urljoin(AMAZON_ORIGIN, href))
    if parsed.scheme != "https" or parsed.hostname not in {"amazon.co.uk", "www.amazon.co.uk"}:
        return ""

    paths = [parsed.path]
    query = urllib.parse.parse_qs(parsed.query)
    for key in ("url", "redirect", "u"):
        for nested_url in query.get(key, []):
            paths.append(urlparse(urllib.parse.unquote(nested_url)).path)

    for path in paths:
        asin_match = re.search(r"/(?:dp|gp/product|gp/aw/d)/([A-Z0-9]{10})(?:[/?]|$)", path, re.IGNORECASE)
        if asin_match:
            return asin_match.group(1).upper()
    return ""


def amazon_product_url(href: str, asin: str) -> str:
    parsed = urlparse(urljoin(AMAZON_ORIGIN, href))
    if parsed.scheme != "https" or parsed.hostname not in {"amazon.co.uk", "www.amazon.co.uk"}:
        return ""
    product_id = asin_from_href(href) or asin
    if not product_id or not re.fullmatch(r"[A-Z0-9]{10}", product_id, re.IGNORECASE):
        return ""
    return f"{AMAZON_ORIGIN}/dp/{product_id.upper()}"


def extract_amazon_candidates(html: str, ean: str) -> list[dict[str, Any]]:
    soup = BeautifulSoup(html, "html.parser")
    products = soup.find_all("div", {"data-component-type": "s-search-result"})
    candidates: list[dict[str, Any]] = []
    seen: set[str] = set()

    for product in products:
        title_tag = product.find("h2")
        image_tag = product.find("img", class_="s-image")
        if not title_tag or not image_tag:
            continue
        title = normalize_text(title_tag.get_text(" ", strip=True))
        image_url = image_from_card(image_tag)
        link = title_tag.find("a") or product.find("a", href=True)
        href = str(link.get("href", "")) if link else ""
        asin = str(product.get("data-asin", "")).strip().upper()
        if not re.fullmatch(r"[A-Z0-9]{10}", asin):
            asin = asin_from_href(href)
        product_url = amazon_product_url(href, asin)
        key = asin or product_url or title
        if not title or not image_url or key in seen:
            continue
        seen.add(key)
        price = ""
        price_tag = product.select_one(".a-price .a-offscreen")
        if price_tag:
            price = normalize_text(price_tag.get_text(" ", strip=True))
        card_text = normalize_text(product.get_text(" ", strip=True))[:3000]
        candidates.append(
            {
                "asin": asin,
                "title": title,
                "imageUrl": image_url,
                "productUrl": product_url,
                "price": price,
                "cardText": card_text,
                "eanMatch": exact_ean_in_text(ean, card_text),
            }
        )
        if len(candidates) >= MAX_CANDIDATES:
            break

    if candidates:
        return candidates

    for image_tag in soup.find_all("img"):
        image_url = image_from_card(image_tag)
        if not image_url or "media-amazon.com/images/I/" not in image_url or "sprite" in image_url.lower():
            continue
        link = image_tag.find_parent("a")
        container = link.find_parent("div") if link else None
        title_tag = container.find("h2") if container else None
        title = normalize_text(title_tag.get_text(" ", strip=True)) if title_tag else ""
        if not title:
            continue
        href = str(link.get("href", "")) if link else ""
        product = image_tag.find_parent("div", attrs={"data-component-type": "s-search-result"})
        asin = str(product.get("data-asin", "")).strip().upper() if product else ""
        if not re.fullmatch(r"[A-Z0-9]{10}", asin):
            asin = asin_from_href(href)
        product_url = amazon_product_url(href, asin)
        candidates.append(
            {
                "asin": asin,
                "title": title,
                "imageUrl": image_url,
                "productUrl": product_url,
                "price": "",
                "cardText": normalize_text(container.get_text(" ", strip=True))[:3000] if container else title,
                "eanMatch": False,
            }
        )
        if len(candidates) >= MAX_CANDIDATES:
            break
    return candidates


def read_limited_response(response: requests.Response, maximum_bytes: int) -> bytes:
    content_length = int(response.headers.get("content-length", "0") or 0)
    if content_length > maximum_bytes:
        raise ValueError("The catalogue response was unexpectedly large.")
    parts: list[bytes] = []
    total = 0
    for part in response.iter_content(chunk_size=64 * 1024):
        if not part:
            continue
        total += len(part)
        if total > maximum_bytes:
            raise ValueError("The catalogue response was unexpectedly large.")
        parts.append(part)
    return b"".join(parts)


def search_amazon(query: str, ean: str) -> list[dict[str, Any]]:
    global _amazon_blocked_until, _last_amazon_request_at
    search_url = f"{AMAZON_ORIGIN}/s?{urllib.parse.urlencode({'k': query})}"
    with _amazon_lock:
        now = time.monotonic()
        if now < _amazon_blocked_until:
            raise AmazonBlocked("Amazon is temporarily blocking automated searches. Wait before trying another batch.")
        wait_seconds = AMAZON_MIN_GAP_SECONDS - (now - _last_amazon_request_at)
        if wait_seconds > 0:
            time.sleep(wait_seconds)
        try:
            with requests.Session() as session:
                response = session.get(
                    search_url,
                    headers=HEADERS,
                    timeout=AMAZON_TIMEOUT_SECONDS,
                    allow_redirects=True,
                    stream=True,
                )
                _last_amazon_request_at = time.monotonic()
                if urlparse(response.url).hostname not in {"amazon.co.uk", "www.amazon.co.uk"}:
                    _amazon_blocked_until = time.monotonic() + AMAZON_BLOCK_COOLDOWN_SECONDS
                    raise AmazonBlocked("Amazon redirected the lookup to a security or sign-in page.")
                html = read_limited_response(response, MAX_PAGE_BYTES)
                if response.status_code in {403, 429, 503}:
                    _amazon_blocked_until = time.monotonic() + AMAZON_BLOCK_COOLDOWN_SECONDS
                    raise AmazonBlocked("Amazon is temporarily blocking automated searches. Wait before trying another batch.")
                if response.status_code != 200:
                    raise RuntimeError(f"Amazon UK returned HTTP {response.status_code}.")
                html_text = html.decode("utf-8", errors="replace")
                lowered = html_text.lower()
                if "captcha" in lowered or "automated access" in lowered or "validatecaptcha" in lowered:
                    _amazon_blocked_until = time.monotonic() + AMAZON_BLOCK_COOLDOWN_SECONDS
                    raise AmazonBlocked("Amazon is showing a CAPTCHA or automated-access block. The matcher stopped without retrying.")
        except requests.RequestException as error:
            _last_amazon_request_at = time.monotonic()
            raise RuntimeError("The Amazon UK search could not be reached. Try again later.") from error

    if "no results for" in lowered or "did not match any products" in lowered:
        return []
    return extract_amazon_candidates(html_text, ean)


def build_search_queries(product: MatchRequest) -> list[tuple[str, str]]:
    queries: list[tuple[str, str]] = []
    if product.ean:
        queries.append(("ean", product.ean))

    detailed = clean_title(" ".join(part for part in (product.brand, product.title, product.variant, product.size, product.pack) if part))
    category = CATEGORY_DICTIONARY.get(product.category, {})
    category_terms = [*category.get("queryTerms", []), *category.get("searchTerms", [])]
    staged_queries: list[tuple[str, str]] = [("detail", detailed)]
    if product.image_terms:
        image_query = clean_title(" ".join(part for part in (product.title, product.image_terms, product.size, product.pack) if part))
        staged_queries.append(("image", image_query))
    for term in category_terms:
        category_query = clean_title(f"{detailed} {term}")
        staged_queries.append(("category", category_query))
    if product.brand or product.title:
        staged_queries.append(("brand", clean_title(" ".join(part for part in (product.brand, product.title) if part))))

    for stage, query in staged_queries:
        if query and all(query.casefold() != existing.casefold() for _, existing in queries):
            queries.append((stage, query[:220]))
        if len(queries) >= MAX_SEARCH_QUERIES:
            break
    return queries


def candidate_sort_key(candidate: dict[str, Any]) -> tuple[int, float]:
    priority = {"high": 3, "medium": 2, "low": 1}.get(candidate.get("tier"), 0)
    return (priority, float(candidate.get("titleScore", 0)))


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/api/amazon/match")
def match_product(product: MatchRequest):
    queries = build_search_queries(product)
    if not queries:
        return {
            "status": "not-found",
            "message": "Add an EAN or product title before searching Amazon UK.",
            "regalImageUrl": "",
            "bestCandidate": None,
            "candidates": [],
            "searchedQueries": [],
        }

    regal_image_url = safe_regal_url(product.regal_image_url) or get_regal_image(product.ean)
    candidates_by_key: dict[str, dict[str, Any]] = {}
    searched_queries: list[dict[str, str]] = []

    try:
        for stage, query in queries:
            searched_queries.append({"stage": stage, "query": query})
            for raw_candidate in search_amazon(query, product.ean):
                classified = classify_candidate(product, raw_candidate)
                if not classified:
                    continue
                classified["searchedBy"] = stage
                key = classified.get("asin") or classified.get("productUrl") or classified["title"].casefold()
                existing = candidates_by_key.get(key)
                if existing is None or candidate_sort_key(classified) > candidate_sort_key(existing):
                    candidates_by_key[key] = classified

            if len(candidates_by_key) >= MAX_RESULT_CANDIDATES:
                break
    except AmazonBlocked as error:
        return {
            "status": "blocked",
            "message": str(error),
            "regalImageUrl": regal_image_url,
            "bestCandidate": None,
            "candidates": sorted(candidates_by_key.values(), key=candidate_sort_key, reverse=True)[:MAX_RESULT_CANDIDATES],
            "searchedQueries": searched_queries,
        }
    except (requests.RequestException, RuntimeError, ValueError) as error:
        return {
            "status": "error",
            "message": str(error) or "The Amazon UK search could not be completed.",
            "regalImageUrl": regal_image_url,
            "bestCandidate": None,
            "candidates": sorted(candidates_by_key.values(), key=candidate_sort_key, reverse=True)[:MAX_RESULT_CANDIDATES],
            "searchedQueries": searched_queries,
        }

    candidates = sorted(candidates_by_key.values(), key=candidate_sort_key, reverse=True)
    if not candidates:
        return {
            "status": "not-found",
            "message": "No Amazon UK result matched the EAN, product title, brand, variant, size, and pack details.",
            "regalImageUrl": regal_image_url,
            "bestCandidate": None,
            "candidates": [],
            "searchedQueries": searched_queries,
        }

    visible_candidates = candidates[:MAX_RESULT_CANDIDATES]
    best = visible_candidates[0]

    return {
        "status": best["tier"],
        "message": best["reason"],
        "regalImageUrl": regal_image_url,
        "bestCandidate": best,
        "candidates": visible_candidates,
        "searchedQueries": searched_queries,
    }
