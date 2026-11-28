from __future__ import annotations

import json
import re
import threading
import time
import urllib.parse
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
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
MAX_SEARCH_QUERIES = 10
MAX_BRAND_DETAIL_LOOKUPS = 5
# MAX_MATCH_CANDIDATES removed - return all findings
TITLE_QUERY_STAGES = {"brand-size", "brand-variant", "brand-title-size", "brand-title-size-variant", "brand-title", "brand-title-variant", "size-title", "size-title-variant", "title-only", "title-variant", "title-original", "image", "image-brand-size"}
TITLE_CONNECTOR_WORDS = {"a", "an", "and", "for", "from", "in", "of", "on", "or", "the", "to", "with"}
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


class AmazonOfferRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    asin: str = Field(min_length=10, max_length=10)

    @field_validator("asin")
    @classmethod
    def validate_asin(cls, value: str) -> str:
        normalized = value.upper()
        if not re.fullmatch(r"[A-Z0-9]{10}", normalized):
            raise ValueError("ASIN must contain exactly 10 letters or digits.")
        return normalized


class AmazonBlocked(Exception):
    pass


app = FastAPI(title="FinderApp Amazon Matcher", docs_url=None, redoc_url=None)
_amazon_lock = threading.Lock()
_last_amazon_request_at = 0.0
_amazon_blocked_until = 0.0


@app.middleware("http")
async def limit_lookup_body(request: Request, call_next):
    if request.url.path in {"/api/amazon/match", "/api/amazon/offer"}:
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


def extract_seller_name(value: str) -> str:
    match = re.search(
        r"\b(?:shipper\s*/\s*seller|sold\s+by|seller)\s*:?\s*(.+?)(?=\s+(?:(?:and\s+)?(?:ships?|dispatches?|dispatched)\s+(?:from|by)|returns?|conditions?)\b|\s*[|]|$)",
        value,
        re.IGNORECASE,
    )
    return normalize_text(match.group(1)).strip(" ,;|") if match else ""


def tokens(value: str) -> set[str]:
    return set(re.findall(r"[a-z0-9]+", value.lower()))


def normalized_measurement(number: Decimal, unit: str) -> str:
    formatted = format(number.normalize(), "f")
    return f"{formatted}{unit}"


def compound_pack_counts(value: str) -> tuple[int, int] | None:
    match = re.search(
        r"(?<!\w)(\d{1,3})\s*[x×]\s*(\d{1,3})(?:\s*(packs?|pks?|count|ct|units?|pcs?|pieces?))?(?!\w)",
        value,
        re.IGNORECASE,
    )
    if not match:
        return None
    if not match.group(3) and re.match(
        r"\s*(?:fl\s?oz|ml|cl|litres?|liters?|l|kg|mg|gm|g)\b",
        value[match.end():],
        re.IGNORECASE,
    ):
        return None
    return int(match.group(1)), int(match.group(2))


def extract_amazon_pack_components(title: str, context_size: str = "") -> tuple[int, int | None, int]:
    """
    Extract pack components from Amazon title.
    Optionally uses context_size to infer units for implicit patterns like "4 x 120".
    """
    volume_multiplier = re.search(
        r"(?<!\w)(\d{1,3})\s*[x×]\s*\d+(?:[.,]\d+)?\s*(?:fl\s?oz|ml|cl|litres?|liters?|l|kg|mg|gm|g)\b",
        title,
        re.IGNORECASE,
    )
    if volume_multiplier:
        quantity = max(1, int(volume_multiplier.group(1)))
        return quantity, None, quantity

    reversed_volume_multiplier = re.search(
        r"(?<!\w)\d+(?:[.,]\d+)?\s*(?:fl\s?oz|ml|cl|litres?|liters?|l|kg|mg|gm|g)\s*[x×]\s*(\d{1,3})(?!\w)",
        title,
        re.IGNORECASE,
    )
    if reversed_volume_multiplier:
        quantity = max(1, int(reversed_volume_multiplier.group(1)))
        return quantity, None, quantity

    # Handle implicit unit patterns like "4 x 120" (no unit) when context_size provides unit
    if context_size:
        # Infer the unit from context_size (use internal to avoid recursion)
        ctx_measurements = _measurements_internal(context_size)
        inferred_unit = None
        context_unit_value = None
        for m in ctx_measurements:
            if m.endswith("ml") or m.endswith("g") or m.endswith("mm"):
                inferred_unit = "ml" if m.endswith("ml") else ("g" if m.endswith("g") else "mm")
                # Extract the numeric value from context (e.g., "120ml" -> 120)
                match = re.match(r"(\d+(?:\.\d+)?)(?:ml|g|mm)$", m)
                if match:
                    context_unit_value = Decimal(match.group(1))
                break

        if inferred_unit and context_unit_value is not None:
            # Pattern: "4 x 120" (pack count x unit size, without unit, context confirms unit size)
            implicit_volume_multiplier = re.search(
                rf"(?<!\w)(\d{{1,3}})\s*[x×]\s*(\d+(?:[.,]\d+)?)\b(?!\s*(?:fl\s?oz|millilitres?|milliliters?|ml|cl|litres?|liters?|l|kilograms?|kg|milligrams?|mg|grams?|grammes?|gm|g|centimetres?|centimeters?|cm|millimetres?|millimeters?|mm|metres?|meters?|m|pieces?|pcs?|tablets?|wipes?|sachets?|capsules?|packs?|pks?|count|ct|units?))",
                title,
                re.IGNORECASE,
            )
            if implicit_volume_multiplier:
                pack_count = max(1, int(implicit_volume_multiplier.group(1)))
                unit_size = Decimal(implicit_volume_multiplier.group(2).replace(",", "."))
                # Verify the unit size matches context (allowing small tolerance)
                if abs(unit_size - context_unit_value) < Decimal("0.01"):
                    return pack_count, None, pack_count

            # Pattern: "120 x 4" (unit size x pack count, reversed, without unit)
            # Use context to disambiguate: the number matching context_unit_value is the unit size
            implicit_reversed = re.search(
                rf"(?<!\w)(\d+(?:[.,]\d+)?)\s*[x×]\s*(\d{{1,3}})\b(?!\s*(?:fl\s?oz|millilitres?|milliliters?|ml|cl|litres?|liters?|l|kilograms?|kg|milligrams?|mg|grams?|grammes?|gm|g|centimetres?|centimeters?|cm|millimetres?|millimeters?|mm|metres?|meters?|m|pieces?|pcs?|tablets?|wipes?|sachets?|capsules?|packs?|pks?|count|ct|units?))",
                title,
                re.IGNORECASE,
            )
            if implicit_reversed:
                first_num = Decimal(implicit_reversed.group(1).replace(",", "."))
                second_num = max(1, int(implicit_reversed.group(2)))
                # If first number matches context unit size, second is pack count
                if abs(first_num - context_unit_value) < Decimal("0.01"):
                    return second_num, None, second_num
                # If second number matches context unit size (and is reasonable as unit size), first is pack count
                # But second is limited to 1-3 digits, so unlikely to be unit size > 999
                # Just check if first is a reasonable pack count (1-100)
                elif first_num <= 100 and second_num == int(context_unit_value):
                    return max(1, int(first_num)), None, max(1, int(first_num))

    compound = compound_pack_counts(title)
    if compound:
        outer_count, inner_count = compound
        return outer_count, inner_count, outer_count * inner_count

    patterns = (
        r"\b(?:pack|pk|case|set|box|bundle)\s*(?:of\s*)?(\d{1,3})\b",
        r"\b(\d{1,3})\s*(?:packs?|pks?|count|ct|units?|pieces?|bottles?|tubes?|bars?|rolls?)\b",
    )
    for pattern in patterns:
        match = re.search(pattern, title, re.IGNORECASE)
        if match:
            quantity = max(1, int(match.group(1)))
            return quantity, None, quantity
    return 1, None, 1


def _measurements_internal(value: str) -> set[str]:
    """Internal measurements extraction without context inference (to avoid recursion)."""
    pattern = re.compile(
        r"(?<!\w)(\d+(?:[.,]\d+)?)\s*(fl\s?oz|millilitres?|milliliters?|ml|cl|litres?|liters?|l|kilograms?|kg|milligrams?|mg|grams?|grammes?|gm|g|centimetres?|centimeters?|cm|millimetres?|millimeters?|mm|metres?|meters?|m|pieces?|pcs?|tablets?|wipes?|sachets?|capsules?|packs?|pks?|count|ct|units?|sheets?|rolls?|bags?|boxes?|tubes?|bars?|packets?|sachets?|pads?|strips?)(?:\s*[x×]\s*\d{1,3})?\b",
        re.IGNORECASE,
    )
    result: set[str] = set()
    for number_text, unit_text in pattern.findall(value):
        number = Decimal(number_text.replace(",", "."))
        unit = unit_text.lower().replace(" ", "").replace(".", "")
        if unit in {"l", "litre", "litres", "liter", "liters", "millilitre", "millilitres", "milliliter", "milliliters"}:
            number *= 1000
            unit = "ml"
        elif unit == "cl":
            number *= 10
            unit = "ml"
        elif unit in {"kg", "kilogram", "kilograms"}:
            number *= 1000
            unit = "g"
        elif unit in {"mg", "milligram", "milligrams"}:
            number /= 1000
            unit = "g"
        elif unit in {"gram", "grams", "gramme", "grammes", "gm"}:
            unit = "g"
        elif unit in {"m", "metre", "metres", "meter", "meters"}:
            number *= 1000
            unit = "mm"
        elif unit in {"cm", "centimetre", "centimetres", "centimeter", "centimeters"}:
            number *= 10
            unit = "mm"
        elif unit in {"piece", "pieces", "pc", "pcs", "tablet", "tablets", "wipe", "wipes", "sachet", "sachets", "capsule", "capsules", "count", "ct", "unit", "units", "pack", "packs", "pk", "pks", "sheet", "sheets", "roll", "rolls", "bag", "bags", "box", "boxes", "tube", "tubes", "bar", "bars", "packet", "packets", "pad", "pads", "strip", "strips"}:
            unit = "count"
        result.add(normalized_measurement(number, unit))

    for number_text in re.findall(r"\b(?:pack|pk|case|set|box|bundle)\s*(?:of\s*)?(\d{1,4})\b", value, re.IGNORECASE):
        result.add(f"{int(number_text)}count")
    for number_text in re.findall(
        r"(?<!\w)(\d{1,3})\s*[x×]\s*\d+(?:[.,]\d+)?\s*(?:fl\s?oz|ml|cl|litres?|liters?|l|kg|mg|gm|g)\b",
        value,
        re.IGNORECASE,
    ):
        result.add(f"{int(number_text)}count")
    for number_text in re.findall(
        r"(?<!\w)\d+(?:[.,]\d+)?\s*(?:fl\s?oz|ml|cl|litres?|liters?|l|kg|mg|gm|g)\s*[x×]\s*(\d{1,3})(?!\w)",
        value,
        re.IGNORECASE,
    ):
        result.add(f"{int(number_text)}count")
    compound = compound_pack_counts(value)
    if compound:
        outer_count, inner_count = compound
        result.add(f"{inner_count}count")
        result.add(f"{outer_count * inner_count}count")
    return result


def measurements(value: str, context_size: str = "") -> set[str]:
    """
    Extract measurements from text. Optionally use context_size to infer units
    for compound expressions like "4 x 120" (without explicit unit).
    """
    result = _measurements_internal(value)

    # Handle compound expressions with implicit units (e.g., "4 x 120" where context is "120ml")
    # Extract the unit from context_size if available
    inferred_unit = None
    context_unit_value = None
    if context_size:
        ctx_measurements = _measurements_internal(context_size)
        for m in ctx_measurements:
            if m.endswith("ml") or m.endswith("g") or m.endswith("mm") or m.endswith("count"):
                inferred_unit = m[-2:] if m.endswith("ml") else m[-1:]
                match = re.match(r"(\d+(?:\.\d+)?)(?:ml|g|mm|count)$", m)
                if match:
                    context_unit_value = Decimal(match.group(1))
                break

    # Pattern for "N x NUMBER" without explicit unit (implicit from context)
    if inferred_unit and context_unit_value is not None:
        # Pattern: "4 x 120" (pack count x unit size)
        implicit_pattern = re.compile(
            rf"(?<!\w)(\d{{1,3}})\s*[x×]\s*(\d+(?:[.,]\d+)?)\b(?!\s*(?:fl\s?oz|millilitres?|milliliters?|ml|cl|litres?|liters?|l|kilograms?|kg|milligrams?|mg|grams?|grammes?|gm|g|centimetres?|centimeters?|cm|millimetres?|millimeters?|mm|metres?|meters?|m|pieces?|pcs?|tablets?|wipes?|sachets?|capsules?|packs?|pks?|count|ct|units?))",
            re.IGNORECASE,
        )
        for number_text, unit_text in implicit_pattern.findall(value):
            number = Decimal(unit_text.replace(",", "."))
            if abs(number - context_unit_value) < Decimal("0.01"):
                result.add(normalized_measurement(number, inferred_unit))
                # Also add the pack count
                result.add(f"{int(number_text)}count")

        # Pattern: "120 x 4" (unit size x pack count, reversed)
        implicit_reversed = re.compile(
            rf"(?<!\w)(\d+(?:[.,]\d+)?)\s*[x×]\s*(\d{{1,3}})\b(?!\s*(?:fl\s?oz|millilitres?|milliliters?|ml|cl|litres?|liters?|l|kilograms?|kg|milligrams?|mg|grams?|grammes?|gm|g|centimetres?|centimeters?|cm|millimetres?|millimeters?|mm|metres?|meters?|m|pieces?|pcs?|tablets?|wipes?|sachets?|capsules?|packs?|pks?|count|ct|units?))",
            re.IGNORECASE,
        )
        for number_text, pack_text in implicit_reversed.findall(value):
            number = Decimal(number_text.replace(",", "."))
            pack_count = int(pack_text)
            if abs(number - context_unit_value) < Decimal("0.01") and pack_count <= 100:
                result.add(normalized_measurement(number, inferred_unit))
                result.add(f"{pack_count}count")

    return result


def source_size_text(product: MatchRequest) -> str:
    if product.size:
        return product.size

    unit_pattern = (
        r"fl\s?oz|millilitres?|milliliters?|ml|cl|litres?|liters?|l|kilograms?|kg|"
        r"milligrams?|mg|grams?|grammes?|gm|g|centimetres?|centimeters?|cm|"
        r"millimetres?|millimeters?|mm|metres?|meters?|m|pieces?|pcs?|tablets?|"
        r"wipes?|sachets?|capsules?|packs?|pks?|count|ct|units?"
    )
    pattern = re.compile(
        rf"(?<!\w)(?:\d{{1,3}}\s*[x×]\s*)?(\d+(?:[.,]\d+)?)\s*({unit_pattern})(?:\s*[x×]\s*\d{{1,3}})?\b",
        re.IGNORECASE,
    )
    for value in (product.title, product.image_terms):
        match = pattern.search(value)
        if match:
            return f"{match.group(1)}{match.group(2)}"
    return ""


def measurement_dimension(measurement: str) -> str:
    unit = re.search(r"(?:fl oz|ml|g|mm|count)$", measurement)
    return unit.group(0) if unit else measurement


def measurements_match(expected: set[str], actual: set[str]) -> bool:
    expected_by_dimension: dict[str, set[str]] = {}
    actual_by_dimension: dict[str, set[str]] = {}
    for measurement in expected:
        expected_by_dimension.setdefault(measurement_dimension(measurement), set()).add(measurement)
    for measurement in actual:
        actual_by_dimension.setdefault(measurement_dimension(measurement), set()).add(measurement)
    for dimension, expected_values in expected_by_dimension.items():
        actual_values = actual_by_dimension.get(dimension, set())
        if dimension == "count":
            if not expected_values.issubset(actual_values):
                return False
        elif expected_values != actual_values:
            return False
    return True


def extract_source_pack_quantity(pack: str) -> int | None:
    compound = compound_pack_counts(pack)
    if compound:
        return compound[0] * compound[1]
    volume_multiplier = re.search(
        r"(?<!\w)(\d{1,3})\s*[x×]\s*\d+(?:[.,]\d+)?\s*(?:fl\s?oz|ml|cl|litres?|liters?|l|kg|mg|gm|g)\b",
        pack,
        re.IGNORECASE,
    )
    if volume_multiplier:
        return max(1, int(volume_multiplier.group(1)))
    reversed_volume_multiplier = re.search(
        r"(?<!\w)\d+(?:[.,]\d+)?\s*(?:fl\s?oz|ml|cl|litres?|liters?|l|kg|mg|gm|g)\s*[x×]\s*(\d{1,3})(?!\w)",
        pack,
        re.IGNORECASE,
    )
    if reversed_volume_multiplier:
        return max(1, int(reversed_volume_multiplier.group(1)))
    for pattern in (
        r"\b(?:pack|pk|case|set|box|bundle)\s*(?:of\s*)?(\d{1,3})\b",
        r"\b(\d{1,3})\s*(?:packs?|pks?|count|ct|units?|pieces?)\b",
    ):
        match = re.search(pattern, pack, re.IGNORECASE)
        if match:
            return max(1, int(match.group(1)))
    match = re.search(r"\d+", pack)
    return int(match.group(0)) if match else None


def source_size_pack_quantity(size: str) -> int | None:
    count_measurements = [measurement for measurement in _measurements_internal(size) if measurement.endswith("count")]
    if len(count_measurements) != 1:
        return None
    match = re.match(r"(\d+(?:\.\d+)?)count$", count_measurements[0])
    return int(Decimal(match.group(1))) if match else None


def classify_pack_match(pack: str, size: str, candidate_title: str) -> tuple[bool, str]:
    if not pack:
        return True, "unspecified"

    expected_quantity = extract_source_pack_quantity(pack)
    if expected_quantity is not None:
        outer_count, inner_count, listing_quantity = extract_amazon_pack_components(candidate_title, size)
        source_size_quantity = source_size_pack_quantity(size)

        # If size contains count info (e.g., "20count"), multiply to get total units
        # If size is just volume/weight (e.g., "120ml"), pack quantity IS the item count
        if source_size_quantity is not None:
            expected_total_quantity = expected_quantity * source_size_quantity
        else:
            expected_total_quantity = expected_quantity

        if expected_total_quantity == listing_quantity:
            return True, "exact"
        if inner_count is not None and source_size_quantity == inner_count and expected_quantity == outer_count:
            return True, "exact"
        if expected_quantity > 1 and (
            listing_quantity == 1
            or (outer_count == 1 and inner_count is not None and source_size_quantity == inner_count)
        ):
            return True, "single-item-fallback"

        # Pack count difference is allowed for same item size - it's a priority/sorting thing, not hard exclusion
        # e.g., supplier 6 x 120ml vs Amazon 4 x 120ml (same 120ml unit size) -> pack-count-difference-allowed
        if expected_quantity > 1 and listing_quantity > 1 and source_size_quantity is None:
            # Both are multi-packs of a volume/weight item (not count-based)
            # The item size matches, so pack count difference is allowed for sorting priority
            return True, "pack-count-difference-allowed"

        return True, "mismatch"  # Not a hard exclusion, just low priority

    expected_words = tokens(pack)
    if not expected_words or expected_words.issubset(tokens(candidate_title)):
        return True, "exact"
    return True, "mismatch"  # Not a hard exclusion


def extract_amazon_pack_quantity(title: str, context_size: str = "") -> int:
    return extract_amazon_pack_components(title, context_size)[2]


def source_pack_equivalent_quantity(pack: str, size: str) -> int | None:
    source_quantity = extract_source_pack_quantity(pack)
    if source_quantity is None:
        return None
    if compound_pack_counts(pack):
        return source_quantity
    size_quantity = source_size_pack_quantity(size)
    return source_quantity * size_quantity if size_quantity else source_quantity


def format_price(value: Decimal, currency: str) -> str:
    symbol = {"GBP": "£", "EUR": "€", "USD": "$"}.get(currency.upper(), currency)
    rounded = value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    return f"{symbol}{rounded:.2f}"


def format_price_gbp(price_str: str) -> str:
    """Format price string to ensure GBP currency symbol (£) is used for UK marketplace."""
    if not price_str:
        return ""
    # Replace any $ with £ for Amazon UK
    formatted = price_str.replace("$", "£")
    # Also handle cases where price might have "USD" or "GBP" text
    formatted = re.sub(r"\bUSD\b", "GBP", formatted, flags=re.IGNORECASE)
    formatted = re.sub(r"\b\$\b", "£", formatted)
    return formatted


def candidate_price_details(price: str, title: str, source_pack: str, source_size: str) -> dict[str, Any]:
    outer_count, inner_count, listing_quantity = extract_amazon_pack_components(title, source_size)
    details: dict[str, Any] = {
        "amazonPackCount": listing_quantity,
        "amazonPackBreakdown": f"{outer_count} × {inner_count} ({listing_quantity} total)" if inner_count is not None else str(listing_quantity),
        "amazonUnitPrice": "",
        "supplierPackEquivalentPrice": "",
    }
    price_match = re.search(
        r"(?P<currency>£|€|\$|GBP|EUR|USD)\s*(?P<amount>\d[\d,]*(?:\.\d{1,2})?)",
        price,
        re.IGNORECASE,
    )
    if not price_match:
        return details

    currency = price_match.group("currency")
    # Force GBP for Amazon UK marketplace
    if currency.upper() in {"USD", "$"}:
        currency = "GBP"
    amount_text = price_match.group("amount").replace(",", "")
    try:
        listing_price = Decimal(amount_text)
    except InvalidOperation:
        return details

    unit_price = listing_price / listing_quantity
    details["amazonUnitPrice"] = format_price(unit_price, currency)
    source_quantity = source_pack_equivalent_quantity(source_pack, source_size)
    if source_quantity:
        details["supplierPackEquivalentPrice"] = format_price(unit_price * source_quantity, currency)
    return details


def exact_ean_in_text(ean: str, value: str) -> bool:
    return bool(ean and re.search(rf"(?<!\d){re.escape(ean)}(?!\d)", value))


def classify_candidate(product: MatchRequest, candidate: dict[str, Any]) -> dict[str, Any]:
    candidate_title = normalize_text(str(candidate.get("amazonTitle") or candidate.get("title", "")))
    listing_text = str(candidate.get("cardText", ""))
    candidate_tokens = tokens(candidate_title)
    product_tokens = tokens(clean_title(" ".join(part for part in (product.title, product.image_terms) if part)))
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

    amazon_brand_tokens = tokens(clean_title(str(candidate.get("amazonBrand", ""))))
    brand_match = not brand_tokens or brand_tokens.issubset(candidate_tokens) or brand_tokens.issubset(amazon_brand_tokens)
    title_category_words = category_words
    if not title_category_words:
        title_category_words = set().union(
            *(
                tokens(alias)
                for category_terms in CATEGORY_DICTIONARY.values()
                for alias in category_terms.get("aliases", [])
            )
        )
    distinctive_title_tokens = tokens(clean_title(product.title)) - brand_tokens - variant_tokens - title_category_words
    distinctive_title_tokens = {
        token
        for token in distinctive_title_tokens
        if token not in TITLE_CONNECTOR_WORDS and not re.search(r"\d", token)
    }
    title_variant_match = distinctive_title_tokens.issubset(candidate_tokens)
    variant_match = (not variant_tokens or variant_tokens.issubset(candidate_tokens)) and title_variant_match
    source_size = source_size_text(product)
    expected_measurements = measurements(source_size)
    size_match = not source_size or (
        measurements_match(expected_measurements, measurements(candidate_title, source_size))
        if expected_measurements
        else tokens(clean_title(source_size)).issubset(candidate_tokens)
    )
    pack_match, pack_match_type = classify_pack_match(product.pack, source_size, candidate_title)
    price_details = candidate_price_details(str(candidate.get("price", "")), candidate_title, product.pack, source_size)
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
    category_only_match = semantic_title_match and not specific_product_tokens and not product.variant and not source_size

    if exact_ean:
        tier: Tier = "high"
        reason = "The EAN appears exactly in the Amazon result text."
    elif title_match and brand_match and variant_match and size_match and not category_only_match and not nearby_title_match:
        tier = "medium"
        details = ["product category" if semantic_title_match and not direct_title_match else "product title"]
        if brand_tokens:
            details.append("brand")
        if variant_tokens:
            details.append("variant")
        if source_size:
            details.append("size")
        reason = f"The Amazon title contains the matching {' + '.join(details)}."
        if pack_match_type == "single-item-fallback":
            reason = "No exact supplier pack was found; this same-size listing is priced as a supplier-pack equivalent."
        elif pack_match_type == "pack-count-difference-allowed":
            reason = f"{reason} Pack count differs (same item size); matching prioritizes brand, item size, title, and image."
    elif title_match and brand_match and size_match:
        # Brand AND size match but variant or other details differ - low tier
        tier = "low"
        if product.variant and not variant_match:
            reason = "Brand and size match, but variant needs review."
        elif distinctive_title_tokens and not title_variant_match:
            reason = "Brand and size match, but distinctive product words are missing or differ; review the variant."
        elif pack_match_type == "mismatch":
            reason = "Brand and size match, but pack count differs; same item size so considered a match."
        else:
            reason = "Brand and size match; confirm the variant manually."
    elif source_size and not size_match:
        # Size mismatch = different product entirely - HARD EXCLUSION
        tier = "low"
        reason = f"Size mismatch: expected '{source_size}' but listing has different size. Different size = different product."
    elif not brand_match:
        tier = "low"
        overlap_percent = round(title_coverage * 100)
        reason = f"The source brand is not present in this listing; only {overlap_percent}% of source product words overlap."
    else:
        tier = "low"
        overlap_percent = round(title_coverage * 100)
        if not title_match:
            reason = f"Only {overlap_percent}% of source product words overlap."
        else:
            reason = "Some product details differ; this listing is retained among the top Amazon options for manual review."

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
            "packMatchType": pack_match_type,
            **price_details,
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


def amazon_card_title(title_tag, link, image_tag) -> str:
    values = [
        link.get("title", "") if link else "",
        link.get("aria-label", "") if link else "",
        title_tag.get("title", ""),
        title_tag.get("aria-label", ""),
        title_tag.get_text(" ", strip=True),
        image_tag.get("alt", "") if image_tag else "",
    ]
    titles = [normalize_text(str(value)) for value in values if value]
    return max(titles, key=len, default="")


def clean_amazon_brand(value: str) -> str:
    brand = normalize_text(value).strip(" :|-")
    brand = re.sub(r"^brand(?:\s+name)?\s*:\s*", "", brand, flags=re.IGNORECASE)
    brand = re.sub(r"^visit\s+the\s+(.+?)\s+store$", r"\1", brand, flags=re.IGNORECASE)
    brand = normalize_text(brand).strip(" :|-")
    if not brand or len(brand) > 120 or brand.casefold() in {"not applicable", "n/a", "unknown"}:
        return ""
    return brand


def extract_amazon_brand(soup: BeautifulSoup) -> str:
    for row in soup.select(
        "#productOverview_feature_div tr, #productDetails_techSpec_section_1 tr, "
        "#productDetails_detailBullets_sections1 tr, #technicalSpecifications_section_1 tr"
    ):
        cells = row.find_all(["th", "td"])
        if len(cells) >= 2 and normalize_text(cells[0].get_text(" ", strip=True)).rstrip(":").casefold() in {"brand", "brand name"}:
            brand = clean_amazon_brand(cells[1].get_text(" ", strip=True))
            if brand:
                return brand

    for item in soup.select("#detailBullets_feature_div li, #detailBulletsWrapper_feature_div li"):
        label = item.select_one(".a-text-bold")
        if label and normalize_text(label.get_text(" ", strip=True)).rstrip(":").casefold() in {"brand", "brand name"}:
            item_text = normalize_text(item.get_text(" ", strip=True))
            brand = clean_amazon_brand(re.sub(r"^brand(?:\s+name)?\s*:\s*", "", item_text, flags=re.IGNORECASE))
            if brand:
                return brand

    for script in soup.select('script[type="application/ld+json"]'):
        try:
            structured_data = json.loads(script.string or script.get_text())
        except (json.JSONDecodeError, TypeError):
            continue
        pending = [structured_data]
        while pending:
            value = pending.pop()
            if isinstance(value, list):
                pending.extend(value)
            elif isinstance(value, dict):
                brand_value = value.get("brand")
                if isinstance(brand_value, str):
                    brand = clean_amazon_brand(brand_value)
                    if brand:
                        return brand
                elif isinstance(brand_value, dict):
                    brand = clean_amazon_brand(str(brand_value.get("name", "")))
                    if brand:
                        return brand
                pending.extend(value.values())

    for selector in ("#bylineInfo", "#bylineInfo_feature_div a"):
        byline = soup.select_one(selector)
        if byline:
            brand = clean_amazon_brand(byline.get_text(" ", strip=True))
            if brand:
                return brand
    return ""


def extract_amazon_product_details(html: str) -> dict[str, str]:
    soup = BeautifulSoup(html, "html.parser")
    brand = extract_amazon_brand(soup)
    title_tag = soup.select_one("#productTitle") or soup.select_one("h1")
    title = normalize_text(title_tag.get_text(" ", strip=True)) if title_tag else ""
    if not title:
        title_meta = soup.select_one('meta[property="og:title"]')
        title = normalize_text(str(title_meta.get("content", ""))) if title_meta else ""

    seller_tag = soup.select_one("#sellerProfileTriggerId")
    seller = normalize_text(seller_tag.get_text(" ", strip=True)) if seller_tag else ""
    if not seller:
        merchant_tag = soup.select_one("#merchant-info") or soup.select_one("[data-feature-name='merchantInfoFeature']")
        merchant_text = normalize_text(merchant_tag.get_text(" ", strip=True)) if merchant_tag else ""
        seller = extract_seller_name(merchant_text)

    if not seller:
        for selector in (
            "#tabular-buybox .tabular-buybox-text",
            "#tabular-buybox",
            "#desktop_buybox",
            "#buybox",
        ):
            for merchant_row in soup.select(selector):
                seller = extract_seller_name(normalize_text(merchant_row.get_text(" ", strip=True)))
                if seller:
                    break
            if seller:
                break

    price = ""
    for selector in (
        "#corePriceDisplay_desktop_feature_div .a-offscreen",
        "#corePrice_feature_div .a-offscreen",
        "#tabular-buybox .a-offscreen",
        "#price_inside_buybox",
        "#priceblock_ourprice",
        "#priceblock_dealprice",
        "#desktop_buybox .a-price .a-offscreen",
    ):
        price_tag = soup.select_one(selector)
        if price_tag:
            price = normalize_text(price_tag.get_text(" ", strip=True))
            # Ensure price uses GBP (£) for UK marketplace
            price = format_price_gbp(price)
            if price:
                break

    return {"amazonTitle": title, "amazonBrand": brand, "seller": seller, "price": price}


def extract_amazon_candidates(html: str, ean: str) -> list[dict[str, Any]]:
    soup = BeautifulSoup(html, "html.parser")
    products = soup.find_all("div", {"data-component-type": "s-search-result"})
    candidates: list[dict[str, Any]] = []
    seen: set[str] = set()

    for product in products:
        title_tag = product.find("h2")
        image_tag = product.find("img", class_="s-image")
        if not title_tag:
            continue
        link = title_tag.find("a") or product.find("a", href=True)
        title = amazon_card_title(title_tag, link, image_tag)
        image_url = image_from_card(image_tag) if image_tag else ""
        href = str(link.get("href", "")) if link else ""
        asin = str(product.get("data-asin", "")).strip().upper()
        if not re.fullmatch(r"[A-Z0-9]{10}", asin):
            asin = asin_from_href(href)
        product_url = amazon_product_url(href, asin)
        key = asin or product_url or title
        if not title or key in seen:
            continue
        seen.add(key)
        price = ""
        price_tag = product.select_one(".a-price .a-offscreen")
        if price_tag:
            price = normalize_text(price_tag.get_text(" ", strip=True))
            # Ensure price uses GBP (£) for UK marketplace
            price = format_price_gbp(price)
        card_text = normalize_text(product.get_text(" ", strip=True))[:3000]
        candidates.append(
            {
                "asin": asin,
                "title": title,
                "imageUrl": image_url,
                "productUrl": product_url,
                "price": price,
                "seller": extract_seller_name(card_text),
                "cardText": card_text,
                "eanMatch": exact_ean_in_text(ean, card_text),
            }
        )

    if candidates:
        return candidates

    for image_tag in soup.find_all("img"):
        image_url = image_from_card(image_tag)
        if not image_url or "media-amazon.com/images/I/" not in image_url or "sprite" in image_url.lower():
            continue
        link = image_tag.find_parent("a")
        container = link.find_parent("div") if link else None
        title_tag = container.find("h2") if container else None
        title = amazon_card_title(title_tag, link, image_tag) if title_tag else normalize_text(str(image_tag.get("alt", "")))
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
                "seller": extract_seller_name(normalize_text(container.get_text(" ", strip=True))) if container else "",
                "cardText": normalize_text(container.get_text(" ", strip=True))[:3000] if container else title,
                "eanMatch": False,
            }
        )
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


def fetch_amazon_page(url: str, request_error_message: str) -> str:
    global _amazon_blocked_until, _last_amazon_request_at
    with _amazon_lock:
        now = time.monotonic()
        if now < _amazon_blocked_until:
            raise AmazonBlocked("Amazon is temporarily limiting requests. Wait before trying again.")
        wait_seconds = AMAZON_MIN_GAP_SECONDS - (now - _last_amazon_request_at)
        if wait_seconds > 0:
            time.sleep(wait_seconds)
        try:
            with requests.Session() as session:
                response = session.get(
                    url,
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
                    raise AmazonBlocked("Amazon is temporarily limiting requests. Wait before trying again.")
                if response.status_code != 200:
                    raise RuntimeError(f"Amazon UK returned HTTP {response.status_code}.")
                html_text = html.decode("utf-8", errors="replace")
                lowered = html_text.lower()
                if "captcha" in lowered or "automated access" in lowered or "validatecaptcha" in lowered:
                    _amazon_blocked_until = time.monotonic() + AMAZON_BLOCK_COOLDOWN_SECONDS
                    raise AmazonBlocked("Amazon is showing a CAPTCHA or automated-access block. The lookup stopped without retrying.")
                return html_text
        except requests.RequestException as error:
            _last_amazon_request_at = time.monotonic()
            raise RuntimeError(request_error_message) from error


def search_amazon(query: str, ean: str) -> list[dict[str, Any]]:
    search_url = f"{AMAZON_ORIGIN}/s?{urllib.parse.urlencode({'k': query})}"
    html_text = fetch_amazon_page(search_url, "The Amazon UK search could not be reached. Try again later.")
    lowered = html_text.lower()
    if "no results for" in lowered or "did not match any products" in lowered:
        return []
    return extract_amazon_candidates(html_text, ean)


@app.post("/api/amazon/offer")
def get_amazon_offer(request: AmazonOfferRequest):
    try:
        html_text = fetch_amazon_page(
            f"{AMAZON_ORIGIN}/dp/{request.asin}",
            "The Amazon UK listing details could not be reached. Try again later.",
        )
        details = extract_amazon_product_details(html_text)
    except AmazonBlocked as error:
        return {"status": "blocked", "message": str(error), "amazonTitle": "", "amazonBrand": "", "seller": "", "price": ""}
    except (RuntimeError, ValueError) as error:
        return {
            "status": "error",
            "message": str(error) or "The Amazon UK listing details could not be read.",
            "amazonTitle": "",
            "amazonBrand": "",
            "seller": "",
            "price": "",
        }

    # Ensure price is formatted with GBP (£)
    if details["price"]:
        details["price"] = format_price_gbp(details["price"])

    missing_fields = [
        label
        for key, label in (("amazonTitle", "full title"), ("seller", "seller"), ("price", "price"))
        if not details[key]
    ]
    message = (
        f"Amazon did not show the {' and '.join(missing_fields)} on this product page."
        if missing_fields
        else "Full title, brand, seller, and price read from the Amazon product page."
        if details["amazonBrand"]
        else "Full title, seller, and price read from the Amazon product page; brand not shown."
    )
    return {"status": "found" if not missing_fields else "partial", "message": message, **details}


def build_search_queries(product: MatchRequest) -> list[tuple[str, str]]:
    """
    Build search queries with intelligent priority order:

    LAW: Only jump to next priority if NO candidate has BOTH brandMatch AND sizeMatch.

    Priority 1: Brand + Title (BROAD - no size constraint)
      - brand + title_without_brand
      - brand + title_without_brand + variant

    Priority 2: Brand + Title + Size (CONSTRAINED - only if Priority 1 finds no brand+size match)
      - brand + title_without_brand + size
      - brand + title_without_brand + size + variant

    Priority 3: Original Title (user's exact manual search text)
      - raw_title (preserves exact text including parentheses)

    Priority 4: Title-only broad searches (no brand)
      - core_title (cleaned without parentheticals)
      - cleaned_title
      - title_without_brand (if different from above)

    Priority 5: Brand + Size / Brand + Variant (Fallbacks)
      - brand + size
      - brand + variant

    Priority 6: Image-based searches
      - brand + core_title + variant + image_terms

    Key intelligence:
    - Title is cleaned to remove parentheticals like "(wsl)" for broader matching
    - Size is ONLY added as constraint if broad search fails to find brand+size matches
    - Raw title preserved for exact manual search replication
    - Pack count variations (4x120ml, 4x120, 120x4) handled by matching logic, not query building
    """
    queries: list[tuple[str, str]] = []

    size = source_size_text(product)
    brand = product.brand
    raw_title = product.title
    variant = clean_title(product.variant)
    image_terms = product.image_terms

    # Clean title: remove parentheticals like (wsl), TEMU, ^ chars
    cleaned_title = clean_title(raw_title)

    # Also create a "core title" without parentheticals for even broader matching
    # e.g., "ZOFLORA DISINFECTANT - LEMON ZING (wsl)" -> "ZOFLORA DISINFECTANT - LEMON ZING"
    core_title = re.sub(r"\s*\([^)]*\)\s*", " ", cleaned_title)
    core_title = " ".join(core_title.split())

    # Title without brand to avoid "Zoflora Zoflora..."
    title_without_brand = core_title
    if brand:
        brand_tokens = set(clean_title(brand).lower().split())
        title_words = title_without_brand.split()
        title_without_brand = " ".join(w for w in title_words if w.lower() not in brand_tokens)

    def add_query(stage: str, parts: list[str]):
        """Add query if it has content."""
        query = clean_title(" ".join(filter(None, parts)))
        if query:
            queries.append((stage, query))

    # --- Priority 1: Brand + Title (BROAD - no size constraint) ---
    # This finds ALL listings for this brand+title, including different pack sizes
    if brand and title_without_brand:
        add_query("brand-title", [brand, title_without_brand])

    if brand and title_without_brand and variant:
        add_query("brand-title-variant", [brand, title_without_brand, variant])

    # --- Priority 2: Brand + Title + Size (CONSTRAINED - only if Priority 1 fails) ---
    # Only run if Priority 1 found NO brand+size matches
    if brand and title_without_brand and size:
        add_query("brand-title-size", [brand, title_without_brand, size])

    if brand and title_without_brand and size and variant:
        add_query("brand-title-size-variant", [brand, title_without_brand, size, variant])

    # --- Priority 3: Original Title (Exact user text - preserves parentheses) ---
    # This replicates what user would type manually into Amazon search
    if raw_title:
        queries.append(("title-original", raw_title))

    # --- Priority 4: Title-only broad searches (no brand) ---
    if core_title and core_title != cleaned_title:
        add_query("title-core", [core_title])
    if cleaned_title:
        add_query("title-only", [cleaned_title])
    if title_without_brand and title_without_brand != core_title and title_without_brand != cleaned_title:
        add_query("title-no-brand", [title_without_brand])

    # --- Priority 5: Brand + Size / Brand + Variant (Fallbacks) ---
    if brand and size:
        add_query("brand-size", [brand, size])

    if brand and variant:
        add_query("brand-variant", [brand, variant])

    # --- Priority 6: Image-based searches ---
    if image_terms:
        image_query_parts = [brand, core_title, variant, image_terms]
        add_query("image", image_query_parts)

    # Deduplicate and limit
    seen_queries = set()
    final_queries = []
    for stage, query in queries:
        query_lower = query.casefold()
        if query and query_lower not in seen_queries:
            seen_queries.add(query_lower)
            final_queries.append((stage, query[:220]))
        if len(final_queries) >= MAX_SEARCH_QUERIES:
            break

    return final_queries


def candidate_sort_key(candidate: dict[str, Any]) -> tuple[int, int, int, int, int, float, int]:
    priority = {"high": 3, "medium": 2, "low": 1}.get(candidate.get("tier"), 0)
    pack_rank = int(candidate.get("packMatchType") in {"exact", "single-item-fallback"})
    return (
        int(bool(candidate.get("eanMatch"))),
        int(bool(candidate.get("brandMatch"))),
        int(bool(candidate.get("sizeMatch"))),
        int(bool(candidate.get("variantMatch"))),
        pack_rank,
        float(candidate.get("titleScore", 0)),
        priority,
    )


def discover_product_brand(product: MatchRequest, candidates_by_key: dict[str, dict[str, Any]]) -> str:
    if product.brand:
        return ""

    candidates_to_check: list[tuple[dict[str, Any], dict[str, Any], str]] = []
    for candidate in candidates_by_key.values():
        preliminary = classify_candidate(product, candidate)
        asin = str(candidate.get("asin", "")).strip().upper() or asin_from_href(str(candidate.get("productUrl", "")))
        if not re.fullmatch(r"[A-Z0-9]{10}", asin):
            continue
        if not preliminary["eanMatch"] and float(preliminary["titleScore"]) < 0.3:
            continue
        candidate["asin"] = asin
        candidates_to_check.append((candidate, preliminary, asin))

    candidates_to_check.sort(key=lambda entry: candidate_sort_key(entry[1]), reverse=True)
    brand_votes: dict[str, dict[str, Any]] = {}

    for candidate, preliminary, asin in candidates_to_check[:MAX_BRAND_DETAIL_LOOKUPS]:
        try:
            html_text = fetch_amazon_page(
                f"{AMAZON_ORIGIN}/dp/{asin}",
                "The Amazon UK product details could not be reached. Try again later.",
            )
            details = extract_amazon_product_details(html_text)
        except AmazonBlocked:
            raise
        except (requests.RequestException, RuntimeError, ValueError):
            candidate["listingDetailsChecked"] = True
            candidate["listingDetailsMessage"] = "Amazon product details could not be read for brand discovery."
            continue

        candidate.update({key: value for key, value in details.items() if value})
        candidate["listingDetailsChecked"] = True
        candidate["listingDetailsMessage"] = (
            "Brand and listing details read from the Amazon product page."
            if details["amazonBrand"]
            else "Amazon product details were checked, but no brand was shown."
        )
        brand = details["amazonBrand"]
        if not brand:
            continue

        normalized_brand = re.sub(r"[^\w]+", " ", brand.casefold(), flags=re.UNICODE).strip()
        is_strong_source_candidate = bool(
            preliminary["sizeMatch"]
            and (
                preliminary["eanMatch"]
                or (
                    float(preliminary["titleScore"]) >= 0.8
                    and preliminary["variantMatch"]
                )
            )
        )
        vote = brand_votes.setdefault(normalized_brand, {"brand": brand, "count": 0, "strong": False})
        vote["count"] += 1
        vote["strong"] = vote["strong"] or is_strong_source_candidate
        if vote["count"] >= 2:
            return str(vote["brand"])

    accepted = [vote for vote in brand_votes.values() if vote["count"] >= 2 or vote["strong"]]
    if not accepted:
        return ""
    accepted.sort(key=lambda vote: (vote["count"], vote["strong"]), reverse=True)
    return str(accepted[0]["brand"])


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/api/amazon/match")
def match_product(product: MatchRequest):
    initial_queries = build_search_queries(product)
    if not initial_queries:
        return {
            "status": "not-found",
            "message": "Add an EAN or product title before searching Amazon UK.",
            "regalImageUrl": "",
            "bestCandidate": None,
            "candidates": [],
            "scannedCandidateCount": 0,
            "searchedQueries": [],
            "discoveredBrand": "",
        }

    regal_image_url = safe_regal_url(product.regal_image_url) or get_regal_image(product.ean)
    candidates_by_key: dict[str, dict[str, Any]] = {}
    searched_queries: list[dict[str, str]] = []
    searched_query_keys: set[str] = set()
    discovered_brand = ""
    effective_product = product

    def ranked_candidates() -> list[dict[str, Any]]:
        # Return ALL classified candidates from the search results, not just strict matches
        classified_candidates = [
            classify_candidate(effective_product, candidate)
            for candidate in candidates_by_key.values()
        ]
        return sorted(classified_candidates, key=candidate_sort_key, reverse=True)

    def search_and_collect(stage: str, query: str) -> bool:
        searched_queries.append({"stage": stage, "query": query})
        searched_query_keys.add(query.casefold())
        page_has_relevant_candidate = False
        page_candidates = search_amazon(query, product.ean)
        for raw_candidate in page_candidates:
            classified = classify_candidate(effective_product, raw_candidate)
            if not classified:
                continue

            raw_candidate = {**raw_candidate, "searchedBy": stage}
            key = classified.get("asin") or classified.get("productUrl") or classified["title"].casefold()
            existing = candidates_by_key.get(key)
            if existing is None or candidate_sort_key(classified) > candidate_sort_key(classify_candidate(effective_product, existing)):
                if existing:
                    for field in (
                        "amazonTitle",
                        "amazonBrand",
                        "seller",
                        "price",
                        "listingDetailsChecked",
                        "listingDetailsMessage",
                    ):
                        if existing.get(field) and not raw_candidate.get(field):
                            raw_candidate[field] = existing[field]
                candidates_by_key[key] = raw_candidate

            page_has_relevant_candidate = page_has_relevant_candidate or bool(
                classified["brandMatch"]
                and classified["sizeMatch"]
                and classified["variantMatch"]
                and (
                    classified["eanMatch"]
                    or float(classified["titleScore"]) >= 0.7
                )
            )
        return page_has_relevant_candidate

    def has_size_matched_ean() -> bool:
        # Disabled - no EAN search, only title-based matching
        return False

    def has_brand_and_size_match() -> bool:
        """Check if any candidate has both brandMatch and sizeMatch - the 'basic law' for stopping search."""
        return any(
            classified["brandMatch"]
            and classified["sizeMatch"]
            for candidate in candidates_by_key.values()
            for classified in (classify_candidate(effective_product, candidate),)
        )

    try:
        discovery_needed = not product.brand
        # Run queries in priority order: brand+title → brand+title+size → title-original → title-only → brand+size → brand+variant → image
        # Early exit when we have BOTH brandMatch AND sizeMatch (the "basic law")
        for stage, query in initial_queries:
            page_has_relevant_candidate = search_and_collect(stage, query)
            # Early exit: if we found a candidate with BOTH brand AND size match, stop searching
            if has_brand_and_size_match():
                break

        if discovery_needed and candidates_by_key:
            discovered_brand = discover_product_brand(product, candidates_by_key)
            if discovered_brand:
                effective_product = product.model_copy(update={"brand": discovered_brand})

        if discovery_needed:
            for stage, query in build_search_queries(effective_product):
                if query.casefold() in searched_query_keys or len(searched_queries) >= MAX_SEARCH_QUERIES:
                    continue
                page_has_relevant_candidate = search_and_collect(stage, query)
                # Early exit after brand discovery too
                if has_brand_and_size_match():
                    break
    except AmazonBlocked as error:
        candidates = ranked_candidates()
        return {
            "status": "blocked",
            "message": str(error),
            "regalImageUrl": regal_image_url,
            "bestCandidate": None,
            "candidates": candidates,
            "scannedCandidateCount": len(candidates_by_key),
            "searchedQueries": searched_queries,
            "discoveredBrand": discovered_brand,
        }
    except (requests.RequestException, RuntimeError, ValueError) as error:
        candidates = ranked_candidates()
        return {
            "status": "error",
            "message": str(error) or "The Amazon UK search could not be completed.",
            "regalImageUrl": regal_image_url,
            "bestCandidate": None,
            "candidates": candidates,
            "scannedCandidateCount": len(candidates_by_key),
            "searchedQueries": searched_queries,
            "discoveredBrand": discovered_brand,
        }

    candidates = ranked_candidates()
    if not candidates:
        requirements = []
        if effective_product.brand:
            requirements.append("the source brand")
        if source_size_text(effective_product):
            requirements.append("the exact item size")
        message = (
            f"Amazon UK returned listings, but none matched {' and '.join(requirements)}. Pack-count differences are allowed."
            if candidates_by_key and requirements
            else "Amazon UK returned no product listings for these searches."
        )
        return {
            "status": "not-found",
            "message": message,
            "regalImageUrl": regal_image_url,
            "bestCandidate": None,
            "candidates": [],
            "scannedCandidateCount": len(candidates_by_key),
            "searchedQueries": searched_queries,
            "discoveredBrand": discovered_brand,
        }

    best = candidates[0]
    message = best["reason"]
    if discovered_brand:
        message = f"{message} Brand identified from Amazon product details: {discovered_brand}."
    return {
        "status": best["tier"],
        "message": message,
        "regalImageUrl": regal_image_url,
        "bestCandidate": best,
        "candidates": candidates,  # Return ALL candidates, not just top 5
        "scannedCandidateCount": len(candidates_by_key),
        "searchedQueries": searched_queries,
        "discoveredBrand": discovered_brand,
    }
