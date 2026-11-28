#!/usr/bin/env python3
"""
Amazon UK Product Matcher
Matches supplier products against Amazon UK listings using brand, size, title, and image matching.
Based on the amazon-product-matching skill with strict size validation and pack priority handling.
"""

import re
import json
import csv
import time
import requests
from dataclasses import dataclass, field, asdict
from typing import Optional, List, Dict, Any, Tuple
from pathlib import Path
from urllib.parse import urlencode, quote_plus
import pandas as pd
from bs4 import BeautifulSoup
import hashlib


# ============================================================
# CONFIGURATION
# ============================================================

AMAZON_UK_BASE = "https://www.amazon.co.uk"
SEARCH_URL = f"{AMAZON_UK_BASE}/s"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-GB,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
}

MAX_PAGES = 5
MAX_SEARCH_QUERIES = 40
REQUEST_TIMEOUT = 30
RETRY_500_MAX = 3
RETRY_500_BACKOFF = [2, 4, 8]  # seconds
BLOCK_COOLDOWN = 60  # seconds for 403/429/503
MIN_RESULTS_PER_PAGE = 20  # early exit if fewer results

# Size normalization units
VOLUME_UNITS = {
    'ml': 1, 'millilitre': 1, 'milliliter': 1, 'millilitres': 1, 'milliliters': 1,
    'cl': 10, 'centilitre': 10, 'centiliter': 10,
    'l': 1000, 'litre': 1000, 'liter': 1000, 'litres': 1000, 'liters': 1000,
    'fl oz': 29.5735, 'floz': 29.5735, 'fl.oz': 29.5735,
}
WEIGHT_UNITS = {
    'mg': 1, 'milligram': 1, 'milligrams': 1,
    'g': 1000, 'gram': 1000, 'grams': 1000,
    'kg': 1000000, 'kilogram': 1000000, 'kilograms': 1000,
}
LENGTH_UNITS = {
    'mm': 1, 'millimetre': 1, 'millimeter': 1,
    'cm': 10, 'centimetre': 10, 'centimeter': 10,
    'm': 1000, 'metre': 1000, 'meter': 1000,
}
COUNT_UNITS = {
    'count': 1, 'pcs': 1, 'pc': 1, 'pieces': 1, 'piece': 1,
    'tablets': 1, 'tablet': 1, 'wipes': 1, 'wipe': 1,
    'sachets': 1, 'sachet': 1, 'capsules': 1, 'capsule': 1,
    'sheets': 1, 'sheet': 1, 'rolls': 1, 'roll': 1,
    'bags': 1, 'bag': 1, 'boxes': 1, 'box': 1,
    'tubes': 1, 'tube': 1, 'bars': 1, 'bar': 1,
    'packets': 1, 'packet': 1, 'pads': 1, 'pad': 1,
    'strips': 1, 'strip': 1, 'fill': 1, 'fills': 1,
    'pk': 1, 'pack': 1, 'x': 1,
}
ALL_UNITS = {**VOLUME_UNITS, **WEIGHT_UNITS, **LENGTH_UNITS, **COUNT_UNITS}


# ============================================================
# DATA CLASSES
# ============================================================

@dataclass
class SupplierProduct:
    """Product from supplier/regal data"""
    ean: str
    title: str
    brand: str
    variant: str
    size: str
    pack: str
    regal_image_url: str = ""
    row_number: int = 0
    no: str = ""

    def get_search_title(self) -> str:
        """Get cleaned title for search"""
        # Remove parentheticals like (wsl), (P), etc.
        cleaned = re.sub(r'\s*\([^)]*\)\s*', ' ', self.title)
        # Remove trademark symbols
        cleaned = re.sub(r'[®™©]', '', cleaned)
        return ' '.join(cleaned.split()).strip()


@dataclass
class AmazonCandidate:
    """Amazon search result candidate"""
    asin: str
    title: str
    image_url: str
    product_url: str
    price: str = ""
    seller: str = ""

    # Matching fields
    tier: str = "low"  # high, medium, low
    reason: str = ""
    title_score: float = 0.0
    ean_match: bool = False
    brand_match: bool = False
    variant_match: Optional[bool] = None
    size_match: bool = False
    pack_match: bool = True  # never excludes, only priority
    pack_match_type: str = "unspecified"
    amazon_pack_count: Optional[int] = None
    amazon_pack_breakdown: str = ""
    amazon_unit_price: str = ""
    supplier_pack_equivalent_price: str = ""
    visual_verdict: Optional[str] = None
    visual_reason: str = ""
    image_match_score: Optional[int] = None
    title_word_coverage: Optional[float] = None
    amazon_title: str = ""
    amazon_brand: str = ""
    searched_by: str = ""

    # UI selection state
    is_selected: bool = False


@dataclass
class MatchResult:
    """Final match result for a supplier product"""
    supplier: SupplierProduct
    status: str  # high, medium, low, not-found, blocked, error, pending
    message: str
    best_candidate: Optional[AmazonCandidate]
    candidates: List[AmazonCandidate]
    scanned_candidate_count: int = 0
    searched_queries: List[Dict[str, str]] = field(default_factory=list)
    decision: Optional[str] = None  # confirmed, rejected, null


# ============================================================
# SIZE PARSING & NORMALIZATION
# ============================================================

SIZE_PATTERN = re.compile(
    r'(?:(\d+(?:[.,]\d+)?)\s*[x×]\s*)?'  # Optional pack count prefix (e.g., "6x")
    r'(\d+(?:[.,]\d+)?)\s*'              # Number
    r'(ml|cl|l|litre|litres|liter|liters|fl\s?oz|floz|fl\.oz|'  # Volume
    r'g|kg|mg|gram|grams|kilogram|kilograms|milligram|milligrams|'  # Weight
    r'mm|cm|m|millimetre|millimetre|centimetre|centimeter|metre|meter|'  # Length
    r'count|pcs?|pieces?|tablets?|wipes?|sachets?|capsules?|'  # Count
    r'sheets?|rolls?|bags?|boxes?|tubes?|bars?|packets?|pads?|strips?|fill|fills|pk|pack)',
    re.IGNORECASE
)

PACK_PATTERN = re.compile(
    r'\b(?:pack\s*(?:of|:)?\s*|x\s*)?(\d{1,3})\s*(?:pk|pack|pcs?|pieces?|count|x)\b',
    re.IGNORECASE
)

MULTIPACK_PATTERN = re.compile(
    r'(\d+)\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*(ml|cl|l|g|kg|mg|cm|m|mm)',
    re.IGNORECASE
)


def parse_size(size_str: str) -> Tuple[Optional[float], Optional[str], Optional[int]]:
    """
    Parse size string and return (normalized_value, base_unit, pack_count)
    e.g., "6x500ml" -> (500.0, "ml", 6)
    e.g., "250ml" -> (250.0, "ml", 1)
    e.g., "16's" -> (16.0, "count", 1)
    """
    if not size_str:
        return None, None, None

    s = size_str.strip()

    # Check for multipack format: "6x500ml" or "6 x 500ml"
    multipack = MULTIPACK_PATTERN.search(s)
    if multipack:
        pack_count = int(multipack.group(1))
        value = float(multipack.group(2).replace(',', '.'))
        unit = multipack.group(3).lower()
        base_value = value * ALL_UNITS.get(unit, 1)
        return base_value, unit, pack_count

    # Standard size format
    match = SIZE_PATTERN.search(s)
    if match:
        prefix = match.group(1)  # pack count prefix (e.g., "6" in "6x500ml")
        value = float(match.group(2).replace(',', '.'))
        unit = match.group(3).lower()

        pack_count = int(prefix) if prefix else 1
        base_value = value * ALL_UNITS.get(unit, 1)
        return base_value, unit, pack_count

    # Try pack pattern separately
    pack_match = PACK_PATTERN.search(s)
    if pack_match:
        pack_count = int(pack_match.group(1))
        # Try to find a size nearby
        match = SIZE_PATTERN.search(s)
        if match:
            value = float(match.group(2).replace(',', '.'))
            unit = match.group(3).lower()
            base_value = value * ALL_UNITS.get(unit, 1)
            return base_value, unit, pack_count

    return None, None, None


def parse_pack(pack_str: str) -> Optional[int]:
    """Parse pack string to get pack count"""
    if not pack_str:
        return None

    match = PACK_PATTERN.search(pack_str)
    if match:
        return int(match.group(1))

    # Try to find any number
    nums = re.findall(r'\b(\d{1,3})\b', pack_str)
    if nums:
        return int(nums[0])

    return None


def sizes_match(supplier_size: str, amazon_size: str) -> bool:
    """Strict size comparison - must match exactly in base units"""
    sup_val, sup_unit, sup_pack = parse_size(supplier_size)
    ama_val, ama_unit, ama_pack = parse_size(amazon_size)

    if sup_val is None or ama_val is None:
        return False

    # Compare normalized values (in base units)
    return abs(sup_val - ama_val) < 0.001


def extract_brand_from_title(title: str, known_brands: List[str]) -> str:
    """Extract brand from title using known brands list"""
    title_lower = title.lower()
    for brand in known_brands:
        if brand.lower() in title_lower:
            return brand
    return ""


# ============================================================
# SEARCH QUERY BUILDING
# ============================================================

def build_search_queries(product: SupplierProduct) -> List[Tuple[str, str]]:
    """
    Build prioritized search queries for Amazon.
    Returns list of (query, stage_name)
    """
    queries = []

    # Clean title
    clean_title = product.get_search_title()
    brand = product.brand.strip() if product.brand else ""
    size = product.size.strip() if product.size else ""
    variant = product.variant.strip() if product.variant else ""
    pack = product.pack.strip() if product.pack else ""

    # Parse pack count
    pack_count = parse_pack(pack)
    pack_str = f"Pack of {pack_count}" if pack_count else ""

    # Priority 1: Brand + Title
    if brand and clean_title:
        queries.append((f"{brand} {clean_title}", "brand-title"))
        if pack_str:
            queries.append((f"{brand} {clean_title} {pack_str}", "brand-title-pack"))

    # Priority 2: Brand + Title + Size
    if brand and clean_title and size:
        queries.append((f"{brand} {clean_title} {size}", "brand-title-size"))
        if pack_str:
            queries.append((f"{brand} {clean_title} {size} {pack_str}", "brand-title-size-pack"))

    # Priority 3: Title original
    if clean_title:
        queries.append((clean_title, "title-original"))

    # Priority 4: Brand + Size
    if brand and size:
        queries.append((f"{brand} {size}", "brand-size"))
        if pack_str:
            queries.append((f"{brand} {size} {pack_str}", "brand-size-pack"))

    # Priority 5: Brand + Variant
    if brand and variant:
        queries.append((f"{brand} {variant}", "brand-variant"))

    # Priority 6: EAN (if valid)
    if product.ean and len(product.ean) >= 8:
        queries.append((product.ean, "ean"))

    # Priority 7: Size + Title
    if size and clean_title:
        queries.append((f"{size} {clean_title}", "size-title"))
        if variant:
            queries.append((f"{size} {clean_title} {variant}", "size-title-variant"))

    # Priority 8: Brand only (fallback)
    if brand:
        queries.append((brand, "brand-only"))

    # Priority 9: Title only (broad)
    if clean_title:
        # Split title into key terms
        words = clean_title.split()
        if len(words) > 3:
            key_terms = ' '.join(words[:5])
            queries.append((key_terms, "title-key-terms"))

    # Limit queries
    return queries[:MAX_SEARCH_QUERIES]


# ============================================================
# AMAZON SCRAPING
# ============================================================

class AmazonScraper:
    """Scrapes Amazon UK search results"""

    def __init__(self):
        self.session = requests.Session()
        self.session.headers.update(HEADERS)
        self.blocked_until = 0
        self.request_count = 0

    def _fetch_with_retry(self, url: str) -> Optional[str]:
        """Fetch URL with 500 error retry logic"""
        now = time.time()
        if now < self.blocked_until:
            time.sleep(self.blocked_until - now)

        for attempt in range(RETRY_500_MAX + 1):
            try:
                response = self.session.get(url, timeout=REQUEST_TIMEOUT)
                self.request_count += 1

                if response.status_code == 200:
                    return response.text

                elif response.status_code == 500:
                    if attempt < RETRY_500_MAX:
                        wait = RETRY_500_BACKOFF[attempt]
                        print(f"  500 error, retrying in {wait}s (attempt {attempt + 1}/{RETRY_500_MAX})")
                        time.sleep(wait)
                        continue
                    return None

                elif response.status_code in (403, 429, 503):
                    print(f"  Blocked ({response.status_code}), cooling down {BLOCK_COOLDOWN}s")
                    self.blocked_until = time.time() + BLOCK_COOLDOWN
                    return None

                else:
                    print(f"  HTTP {response.status_code}")
                    return None

            except requests.Timeout:
                print(f"  Timeout")
                if attempt < RETRY_500_MAX:
                    time.sleep(RETRY_500_BACKOFF[attempt])
                    continue
                return None
            except Exception as e:
                print(f"  Error: {e}")
                return None

        return None

    def _parse_search_results(self, html: str) -> List[AmazonCandidate]:
        """Parse Amazon search results page"""
        soup = BeautifulSoup(html, 'html.parser')
        candidates = []

        # Find product containers - Amazon uses various selectors
        # Try multiple selectors for robustness
        product_divs = soup.select('div[data-component-type="s-search-result"]')

        if not product_divs:
            # Fallback selectors
            product_divs = soup.select('div.s-result-item[data-asin]')

        for div in product_divs:
            try:
                asin = div.get('data-asin', '').strip()
                if not asin or len(asin) != 10:
                    continue

                # Title
                title_elem = div.select_one('h2 a span, h2 span.a-text-normal, .a-text-normal')
                title = title_elem.get_text(strip=True) if title_elem else ""

                # Image
                img_elem = div.select_one('img.s-image')
                image_url = img_elem.get('src', '') if img_elem else ""

                # Product URL
                link_elem = div.select_one('h2 a, a.a-link-normal[href*="/dp/"]')
                product_url = ""
                if link_elem and link_elem.get('href'):
                    href = link_elem['href']
                    if href.startswith('/'):
                        product_url = f"{AMAZON_UK_BASE}{href}"
                    else:
                        product_url = href

                # Price
                price_elem = div.select_one('.a-price-whole, .a-offscreen')
                price = price_elem.get_text(strip=True) if price_elem else ""

                # Seller
                seller_elem = div.select_one('[data-a-badge-color="sx-badge-assigned"]')
                seller = seller_elem.get_text(strip=True) if seller_elem else ""

                if title and asin:
                    candidates.append(AmazonCandidate(
                        asin=asin,
                        title=title,
                        image_url=image_url,
                        product_url=product_url,
                        price=price,
                        seller=seller
                    ))

            except Exception as e:
                continue

        return candidates

    def search_page(self, query: str, page: int = 1) -> List[AmazonCandidate]:
        """Search Amazon for a query on a specific page"""
        params = {
            'k': query,
            'page': page,
            'ref': f'sr_pg_{page}'
        }
        url = f"{SEARCH_URL}?{urlencode(params)}"

        html = self._fetch_with_retry(url)
        if not html:
            return []

        return self._parse_search_results(html)

    def search_all_pages(self, query: str, max_pages: int = MAX_PAGES) -> List[AmazonCandidate]:
        """Search all pages for a query, deduplicating by ASIN"""
        all_candidates = []
        seen_asins = set()

        for page in range(1, max_pages + 1):
            candidates = self.search_page(query, page)

            if not candidates:
                break

            new_count = 0
            for c in candidates:
                if c.asin not in seen_asins:
                    seen_asins.add(c.asin)
                    all_candidates.append(c)
                    new_count += 1

            # Early exit if page has fewer than MIN_RESULTS_PER_PAGE results
            if len(candidates) < MIN_RESULTS_PER_PAGE:
                break

            # Small delay between pages
            time.sleep(1)

        return all_candidates


# ============================================================
# MATCHING LOGIC
# ============================================================

STOP_WORDS = {
    'a', 'an', 'and', 'by', 'for', 'from', 'in', 'of', 'on', 'or', 'the', 'to', 'with', 'x'
}

GENERIC_WORDS = {
    'bath', 'body', 'care', 'cleaner', 'cleaning', 'conditioner', 'cream',
    'deodorant', 'face', 'gel', 'hair', 'hand', 'home', 'liquid', 'lotion',
    'oil', 'pack', 'product', 'products', 'refill', 'set', 'shampoo',
    'soap', 'spray', 'wash', 'washing', 'wipes'
}


def meaningful_words(text: str) -> set:
    """Extract meaningful words from text"""
    if not text:
        return set()

    normalized = text.lower()
    # Normalize measurements
    normalized = re.sub(r'\b\d{1,3}\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*(ml|millilitres?)\b', r'\1ml', normalized)
    normalized = re.sub(r'\b(\d+(?:[.,]\d+)?)\s*(ml|millilitres?)\s*[x×]\s*\d{1,3}\b', r'\1ml', normalized)
    normalized = re.sub(r'\b(\d+(?:[.,]\d+)?)\s*(ml|millilitres?)\b', r'\1ml', normalized)

    words = re.findall(r'[a-z0-9]+', normalized)
    return {w for w in words if w not in STOP_WORDS and w not in GENERIC_WORDS}


def title_word_coverage(source: str, candidate: str) -> float:
    """Calculate title word coverage ratio"""
    src_words = meaningful_words(source)
    if not src_words:
        return 0.0
    cand_words = meaningful_words(candidate)
    matched = sum(1 for w in src_words if w in cand_words)
    return matched / len(src_words)


def classify_pack_match(supplier_pack: str, supplier_size: str, candidate_title: str) -> Tuple[bool, str]:
    """Classify pack match type"""
    sup_pack = parse_pack(supplier_pack)
    sup_size_val, sup_size_unit, sup_size_pack = parse_size(supplier_size)

    if sup_pack is None:
        return True, "unspecified"

    # Try to find pack count in candidate title
    pack_match = re.search(r'\b(\d{1,3})\s*(?:x|pack|pk|pcs?)\b', candidate_title, re.IGNORECASE)
    ama_pack = int(pack_match.group(1)) if pack_match else None

    if ama_pack is None:
        # Check if single item
        if 'single' in candidate_title.lower() or 'each' in candidate_title.lower():
            return True, "single-item-fallback"
        return True, "unspecified"

    if ama_pack == sup_pack:
        return True, "exact"

    # Different pack count - check if same unit size
    # This is a priority factor, not exclusion
    return True, "pack-count-difference-allowed"


def classify_candidate(product: SupplierProduct, candidate: AmazonCandidate, query_stage: str) -> AmazonCandidate:
    """Classify candidate with tier and match details"""

    # Build source title for comparison
    source_parts = [product.brand, product.title, product.variant, product.size]
    source_title = ' '.join(p for p in source_parts if p)

    # Title score
    candidate.title_score = title_word_coverage(source_title, candidate.title)

    # EAN match
    candidate.ean_match = product.ean in candidate.title or product.ean in candidate.asin

    # Brand match
    candidate.amazon_brand = extract_brand_from_title(candidate.title, [product.brand])
    candidate.amazon_title = candidate.title
    candidate.brand_match = product.brand.lower() in candidate.title.lower() if product.brand else False

    # Variant match
    if product.variant:
        candidate.variant_match = product.variant.lower() in candidate.title.lower()
    else:
        candidate.variant_match = None

    # Size match (HARD requirement for medium/high)
    candidate.size_match = sizes_match(product.size, candidate.title)

    # Pack match (priority only, never excludes)
    candidate.pack_match, candidate.pack_match_type = classify_pack_match(
        product.pack, product.size, candidate.title
    )

    # Determine tier
    # HIGH: EAN match + brand + size + title coverage >= 90% + visual strong
    # MEDIUM: Brand + size match + title coverage >= 90% (or EAN match without visual)
    # LOW: Everything else

    if candidate.ean_match and candidate.brand_match and candidate.size_match and candidate.title_score >= 0.9:
        candidate.tier = "high"
        candidate.reason = "EAN match with strong brand, size, and title alignment"
    elif candidate.brand_match and candidate.size_match and candidate.title_score >= 0.9:
        candidate.tier = "medium"
        candidate.reason = f"Brand and size match with {candidate.title_score*100:.0f}% title coverage"
    elif candidate.brand_match and candidate.size_match:
        candidate.tier = "medium"
        candidate.reason = "Brand and size match (title coverage below 90%)"
    elif candidate.ean_match:
        candidate.tier = "medium"
        candidate.reason = "EAN match found"
    elif candidate.size_match and candidate.title_score >= 0.7:
        candidate.tier = "low"
        candidate.reason = "Size match but brand unclear"
    else:
        candidate.tier = "low"
        candidate.reason = "Insufficient match criteria"

    # Size mismatch = always low
    if not candidate.size_match:
        candidate.tier = "low"
        candidate.reason = f"Size mismatch: supplier={product.size}, amazon={candidate.title}"

    # Brand mismatch = always low
    if not candidate.brand_match:
        candidate.tier = "low"
        candidate.reason = f"Brand mismatch: supplier={product.brand}, amazon={candidate.amazon_brand or 'unknown'}"

    candidate.searched_by = query_stage
    return candidate


def candidate_sort_key(c: AmazonCandidate) -> tuple:
    """Sort key for candidates - best first"""
    # Priority: size_match > brand_match > variant_match > ean_match > title_score > pack_match > visual
    return (
        -int(c.size_match),           # size match first
        -int(c.brand_match),          # brand match second
        -int(c.variant_match or True), # variant match third
        -int(c.ean_match),            # ean match fourth
        -c.title_score,               # title score fifth
        -(c.pack_match_type == "exact"), # exact pack sixth
        -(c.pack_match_type == "pack-count-difference-allowed"), # pack diff allowed
        -(c.pack_match_type == "single-item-fallback"),
    )


# ============================================================
# MAIN MATCHING FUNCTION
# ============================================================

def match_product(product: SupplierProduct, scraper: AmazonScraper) -> MatchResult:
    """Match a single product against Amazon"""

    queries = build_search_queries(product)
    all_candidates = []
    searched_queries = []
    seen_asins = set()

    print(f"\nMatching: {product.brand} - {product.title[:50]}... (Size: {product.size}, Pack: {product.pack})")
    print(f"  Generated {len(queries)} search queries")

    for query, stage in queries:
        print(f"  Searching: {stage} - '{query[:60]}...'")
        searched_queries.append({"stage": stage, "query": query})

        candidates = scraper.search_all_pages(query)

        for c in candidates:
            if c.asin not in seen_asins:
                seen_asins.add(c.asin)
                c = classify_candidate(product, c, stage)
                all_candidates.append(c)

        # Early exit if we found high-confidence matches
        high_medium = [c for c in all_candidates if c.tier in ('high', 'medium')]
        if len(high_medium) >= 3:
            print(f"  Found {len(high_medium)} good matches, stopping early")
            break

    # Sort candidates
    all_candidates.sort(key=candidate_sort_key)

    # Determine best candidate and overall status
    best = all_candidates[0] if all_candidates else None

    if best and best.tier == "high":
        status = "high"
        message = f"High confidence match: {best.reason}"
    elif best and best.tier == "medium":
        status = "medium"
        message = f"Medium confidence match: {best.reason}"
    elif best:
        status = "low"
        message = f"Low confidence match: {best.reason}"
    else:
        status = "not-found"
        message = "No Amazon UK listings found"

    return MatchResult(
        supplier=product,
        status=status,
        message=message,
        best_candidate=best,
        candidates=all_candidates,
        scanned_candidate_count=len(all_candidates),
        searched_queries=searched_queries
    )


# ============================================================
# DATA LOADING
# ============================================================

def load_products_from_csv(filepath: str) -> List[SupplierProduct]:
    """Load products from the Regal CSV file with Image URL, Title, EAN, Pack, Size, Status"""
    df = pd.read_csv(filepath)
    products = []

    # Known brands for extraction
    known_brands = [
        'ZOFLORA', 'FLAMINGO', 'DISHMATIC', 'GALPHARM', 'SHIP', 'CIF',
        'KLEENEX', 'CUSSONS', 'UMBRO', 'SPONTEX', 'CHERISH', 'SQUEAKY',
        'SAMSON', 'IMPERIAL LEATHER', 'CAREX', 'FOXY', 'INSETTE',
        'OATBURST', 'REFLECTIONS', 'EASY', 'SUPERBRIGHT', 'NEUTRADOL',
        'SPLASH', 'CUSHELLE', 'ANDREX', 'ELBOW GREASE', 'ORIGINAL SOURCE',
        'PRETTY', 'BLOO', 'HUGGIES', 'ESSENTIAL POWER', 'COLGATE', 'DYLON',
        'WHITE ROCK', 'DUO', 'SQUEAKY CLEAN', 'SAMSON', 'SHIP'
    ]
    # Sort by length descending to match longer brands first
    known_brands = sorted(known_brands, key=len, reverse=True)

    for idx, row in df.iterrows():
        # Get columns (handle possible name variations)
        title = str(row.get('Title', '')).strip()
        ean = str(row.get('EAN', '')).strip()
        size = str(row.get('Size', '')).strip()
        pack = str(row.get('Pack', '')).strip()
        image_url = str(row.get('Image URL', '')).strip()
        status = str(row.get('Status', '')).strip()

        # Clean EAN
        ean = re.sub(r'\D', '', ean)
        if not ean or len(ean) < 8:
            ean = ""

        # Extract brand from title
        brand = ""
        variant = ""
        title_upper = title.upper()

        for b in known_brands:
            if b in title_upper:
                brand = b
                # Variant is the rest after brand
                variant = title_upper.replace(b, '', 1).strip()
                variant = re.sub(r'^[-:\s]+', '', variant)
                variant = re.sub(r'\s+', ' ', variant)
                break

        if not brand:
            # Fallback: first word as brand
            words = title.split()
            if words:
                brand = words[0]
                variant = ' '.join(words[1:]) if len(words) > 1 else ""

        # Clean variant - remove size/pack info
        if variant:
            variant = re.sub(r'\b\d+(?:[.,]\d+)?\s*(?:ml|cl|l|g|kg|mg|cm|m|mm|count|pcs|pieces|tablets|wipes|sachets|capsules|sheets|rolls|bags|boxes|tubes|bars|packets|pads|strips|fill|fills|pk|pack|x)\b', '', variant, flags=re.IGNORECASE)
            variant = re.sub(r'\s*[x×]\s*\d+', '', variant)
            variant = ' '.join(variant.split()).strip(' -:')

        product = SupplierProduct(
            ean=ean,
            title=title,
            brand=brand,
            variant=variant,
            size=size,
            pack=pack,
            regal_image_url=image_url if image_url and image_url != 'nan' else "",
            row_number=idx + 1,
            no=str(idx + 1)
        )
        products.append(product)

    return products


def load_products_from_excel(filepath: str) -> List[SupplierProduct]:
    """Load products from the Regal Excel file"""
    df = pd.read_excel(filepath)
    products = []

    for idx, row in df.iterrows():
        # Extract brand from description
        desc = str(row.get('Description', '')).strip()
        size = str(row.get('Size', '')).strip()
        pack = str(row.get('Pack', '')).strip()
        ean = str(row.get('EAN', '')).strip()
        no = str(row.get('No', '')).strip()

        # Clean EAN
        ean = re.sub(r'\D', '', ean)
        if not ean or len(ean) < 8:
            ean = ""

        # Extract brand from description (first word(s) before product name)
        # Common brands in the data
        known_brands = [
            'ZOFLORA', 'FLAMINGO', 'DISHMATIC', 'GALPHARM', 'SHIP', 'CIF',
            'KLEENEX', 'CUSSONS', 'UMBRO', 'SPONTEX', 'CHERISH', 'SQUEAKY',
            'SAMSON', 'IMPERIAL LEATHER', 'CAREX', 'FOXY', 'INSETTE',
            'OATBURST', 'REFLECTIONS', 'EASY'
        ]

        brand = ""
        variant = ""
        for b in known_brands:
            if b in desc.upper():
                brand = b
                # Variant is the rest after brand
                variant = desc.upper().replace(b, '').strip()
                # Clean up variant
                variant = re.sub(r'^[-:\s]+', '', variant)
                variant = re.sub(r'\s+', ' ', variant)
                break

        if not brand:
            # Fallback: first word as brand
            words = desc.split()
            if words:
                brand = words[0]
                variant = ' '.join(words[1:]) if len(words) > 1 else ""

        # Clean variant - remove size/pack info
        if variant:
            variant = re.sub(r'\b\d+(?:[.,]\d+)?\s*(?:ml|cl|l|g|kg|mg|cm|m|mm|count|pcs|pieces|tablets|wipes|sachets|capsules|sheets|rolls|bags|boxes|tubes|bars|packets|pads|strips|fill|fills|pk|pack|x)\b', '', variant, flags=re.IGNORECASE)
            variant = re.sub(r'\s*[x×]\s*\d+', '', variant)
            variant = ' '.join(variant.split()).strip(' -:')

        product = SupplierProduct(
            ean=ean,
            title=desc,
            brand=brand,
            variant=variant,
            size=size,
            pack=pack,
            regal_image_url="",  # Not in this dataset
            row_number=idx + 1,
            no=no
        )
        products.append(product)

    return products


# ============================================================
# OUTPUT
# ============================================================

def export_results(results: List[MatchResult], output_path: str):
    """Export results to CSV"""
    rows = []

    for r in results:
        s = r.supplier
        b = r.best_candidate

        # Best candidate details
        best_asin = b.asin if b else ""
        best_title = b.title if b else ""
        best_tier = b.tier if b else ""
        best_price = b.price if b else ""
        best_url = b.product_url if b else ""
        best_reason = b.reason if b else ""
        best_brand_match = "Yes" if b and b.brand_match else "No"
        best_size_match = "Yes" if b and b.size_match else "No"
        best_pack_match = b.pack_match_type if b else ""
        best_ean_match = "Yes" if b and b.ean_match else "No"
        best_title_score = f"{b.title_score*100:.1f}%" if b else ""

        # All candidates summary
        candidate_summary = "; ".join([
            f"{c.asin}:{c.tier}:{c.title[:50]}"
            for c in r.candidates[:5]
        ])

        rows.append({
            'Row': s.row_number,
            'No': s.no,
            'EAN': s.ean,
            'Brand': s.brand,
            'Title': s.title,
            'Variant': s.variant,
            'Size': s.size,
            'Pack': s.pack,
            'Match Status': r.status,
            'Match Message': r.message,
            'Best ASIN': best_asin,
            'Best Title': best_title,
            'Best Tier': best_tier,
            'Best Price': best_price,
            'Best URL': best_url,
            'Best Reason': best_reason,
            'Brand Match': best_brand_match,
            'Size Match': best_size_match,
            'Pack Match Type': best_pack_match,
            'EAN Match': best_ean_match,
            'Title Score': best_title_score,
            'Candidates Found': len(r.candidates),
            'Top 5 Candidates': candidate_summary,
            'Queries Run': len(r.searched_queries)
        })

    df = pd.DataFrame(rows)
    df.to_csv(output_path, index=False)
    print(f"\nResults exported to {output_path}")
    print(f"Total products: {len(results)}")

    # Summary
    status_counts = df['Match Status'].value_counts()
    print("\nMatch Status Summary:")
    for status, count in status_counts.items():
        print(f"  {status}: {count}")


# ============================================================
# MAIN
# ============================================================

def main():
    # Load products
    input_file = "/sessions/dreamy-tender-noether/mnt/amazonProductFinder/data/regal-crawl-test-data-regal-results_csv2.csv"
    products = load_products_from_csv(input_file)
    print(f"Loaded {len(products)} products")

    # Match each product
    results = []

    scraper = AmazonScraper()

    for i, product in enumerate(products):
        print(f"\n{'='*60}")
        print(f"Product {i+1}/{len(products)}: {product.brand} - {product.title[:60]}")

        try:
            result = match_product(product, scraper)
            results.append(result)

            # Print best match
            if result.best_candidate:
                b = result.best_candidate
                print(f"  BEST: [{b.tier.upper()}] {b.asin} - {b.title[:60]}")
                print(f"        Brand: {b.brand_match}, Size: {b.size_match}, Pack: {b.pack_match_type}, Title: {b.title_score*100:.0f}%")
            else:
                print(f"  NO MATCHES FOUND")

        except Exception as e:
            print(f"  ERROR: {e}")
            results.append(MatchResult(
                supplier=product,
                status="error",
                message=str(e),
                best_candidate=None,
                candidates=[]
            ))

        # Rate limiting
        if i < len(products) - 1:
            time.sleep(2)

    # Export results
    output_file = "/sessions/dreamy-tender-noether/mnt/amazonProductFinder/output/amazon_matches.csv"
    export_results(results, output_file)

    return results


if __name__ == "__main__":
    # Create output directory
    Path("D:/laragon/www/amazonProductFinder/output").mkdir(parents=True, exist_ok=True)

    main()