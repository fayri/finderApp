#!/usr/bin/env python3
"""
Debug script to trace Amazon search and matching for a specific product.
Replicates the backend logic to show what queries are generated, what results
are returned, and how candidates are classified.
"""

import re
import json
import urllib.parse
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any
import requests
from bs4 import BeautifulSoup

# ============================================================================
# COPIED CONSTANTS AND FUNCTIONS FROM backend/main.py
# ============================================================================

AMAZON_ORIGIN = "https://www.amazon.co.uk"
AMAZON_MIN_GAP_SECONDS = 3.0
AMAZON_TIMEOUT_SECONDS = 15
AMAZON_BLOCK_COOLDOWN_SECONDS = 60.0
MAX_PAGE_BYTES = 4 * 1024 * 1024
MAX_SEARCH_QUERIES = 40

TITLE_CONNECTOR_WORDS = {"a", "an", "and", "for", "from", "in", "of", "on", "or", "the", "to", "with"}

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-GB,en;q=0.9",
    "Referer": "https://www.google.com/",
    "Upgrade-Insecure-Requests": "1",
}

# Load category dictionary
CATEGORY_DICTIONARY = json.loads(
    (Path(__file__).resolve().parent / "backend" / "product_category_terms.json").read_text(encoding="utf-8")
)["categories"]

# Import product descriptors
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent / "backend"))
from product_descriptors import ProductDescriptors, get_descriptors

PRODUCT_DESCRIPTORS = get_descriptors()


def clean_title(title: str) -> str:
    cleaned = re.sub(r"\s*\([^)]*\)\s*", " ", title)
    cleaned = re.sub(r"\bTEMU\b", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\^+", "", cleaned)
    return " ".join(cleaned.split())


def normalize_text(value: str) -> str:
    return " ".join(value.replace(" ", " ").split()).strip()


def tokens(value: str) -> set[str]:
    return set(re.findall(r"[a-z0-9]+", value.lower()))


def normalized_measurement(number: Decimal, unit: str) -> str:
    formatted = format(number.normalize(), "f")
    return f"{formatted}{unit}"


def compound_pack_counts(value: str):
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


def extract_amazon_pack_components(title: str, context_size: str = ""):
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

    if context_size:
        ctx_measurements = _measurements_internal(context_size)
        inferred_unit = None
        context_unit_value = None
        for m in ctx_measurements:
            if m.endswith("ml") or m.endswith("g") or m.endswith("mm"):
                inferred_unit = "ml" if m.endswith("ml") else ("g" if m.endswith("g") else "mm")
                match = re.match(r"(\d+(?:\.\d+)?)(?:ml|g|mm)$", m)
                if match:
                    context_unit_value = Decimal(match.group(1))
                break

        if inferred_unit and context_unit_value is not None:
            implicit_volume_multiplier = re.search(
                rf"(?<!\w)(\d{{1,3}})\s*[x×]\s*(\d+(?:[.,]\d+)?)\b(?!\s*(?:fl\s?oz|millilitres?|milliliters?|ml|cl|litres?|liters?|l|kilograms?|kg|milligrams?|mg|grams?|grammes?|gm|g|centimetres?|centimeters?|cm|millimetres?|millimeters?|mm|metres?|meters?|m|pieces?|pcs?|tablets?|wipes?|sachets?|capsules?|packs?|pks?|count|ct|units?))",
                title,
                re.IGNORECASE,
            )
            if implicit_volume_multiplier:
                pack_count = max(1, int(implicit_volume_multiplier.group(1)))
                unit_size = Decimal(implicit_volume_multiplier.group(2).replace(",", "."))
                if abs(unit_size - context_unit_value) < Decimal("0.01"):
                    return pack_count, None, pack_count

            implicit_reversed = re.search(
                rf"(?<!\w)(\d+(?:[.,]\d+)?)\s*[x×]\s*(\d{{1,3}})\b(?!\s*(?:fl\s?oz|millilitres?|milliliters?|ml|cl|litres?|liters?|l|kilograms?|kg|milligrams?|mg|grams?|grammes?|gm|g|centimetres?|centimeters?|cm|millimetres?|millimeters?|mm|metres?|meters?|m|pieces?|pcs?|tablets?|wipes?|sachets?|capsules?|packs?|pks?|count|ct|units?))",
                title,
                re.IGNORECASE,
            )
            if implicit_reversed:
                first_num = Decimal(implicit_reversed.group(1).replace(",", "."))
                second_num = max(1, int(implicit_reversed.group(2)))
                if abs(first_num - context_unit_value) < Decimal("0.01"):
                    return second_num, None, second_num
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


def _measurements_internal(value: str):
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


def measurements(value: str, context_size: str = ""):
    result = _measurements_internal(value)

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

    if inferred_unit and context_unit_value is not None:
        implicit_pattern = re.compile(
            rf"(?<!\w)(\d{{1,3}})\s*[x×]\s*(\d+(?:[.,]\d+)?)\b(?!\s*(?:fl\s?oz|millilitres?|milliliters?|ml|cl|litres?|liters?|l|kilograms?|kg|milligrams?|mg|grams?|grammes?|gm|g|centimetres?|centimeters?|cm|millimetres?|millimeters?|mm|metres?|meters?|m|pieces?|pcs?|tablets?|wipes?|sachets?|capsules?|packs?|pks?|count|ct|units?))",
            re.IGNORECASE,
        )
        for number_text, unit_text in implicit_pattern.findall(value):
            number = Decimal(unit_text.replace(",", "."))
            if abs(number - context_unit_value) < Decimal("0.01"):
                result.add(normalized_measurement(number, inferred_unit))
                result.add(f"{int(number_text)}count")

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


def source_size_text(product):
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


def extract_source_pack_quantity(pack: str):
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


def source_size_pack_quantity(size: str):
    count_measurements = [measurement for measurement in _measurements_internal(size) if measurement.endswith("count")]
    if len(count_measurements) != 1:
        return None
    match = re.match(r"(\d+(?:\.\d+)?)count$", count_measurements[0])
    return int(Decimal(match.group(1))) if match else None


def classify_pack_match(pack: str, size: str, candidate_title: str):
    if not pack:
        return True, "unspecified"

    expected_quantity = extract_source_pack_quantity(pack)
    if expected_quantity is not None:
        outer_count, inner_count, listing_quantity = extract_amazon_pack_components(candidate_title, size)
        source_size_quantity = source_size_pack_quantity(size)

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
        if expected_quantity > 1 and listing_quantity > 1 and source_size_quantity is None:
            return True, "pack-count-difference-allowed"

        return True, "mismatch"

    expected_words = tokens(pack)
    if not expected_words or expected_words.issubset(tokens(candidate_title)):
        return True, "exact"
    return True, "mismatch"


def exact_ean_in_text(ean: str, value: str) -> bool:
    return bool(ean and re.search(rf"(?<!\d){re.escape(ean)}(?!\d)", value))


def classify_candidate(product, candidate):
    candidate_title = normalize_text(str(candidate.get("amazonTitle") or candidate.get("title", "")))
    listing_text = str(candidate.get("cardText", ""))

    # Filter descriptors from Amazon title for matching purposes
    filtered_candidate_title = PRODUCT_DESCRIPTORS.filter_descriptors(candidate_title)
    candidate_tokens = tokens(filtered_candidate_title)

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
    # Also filter descriptors from distinctive tokens for variant matching
    distinctive_title_tokens = PRODUCT_DESCRIPTORS.filter_descriptors_tokens(distinctive_title_tokens)
    title_variant_match = distinctive_title_tokens.issubset(candidate_tokens)
    variant_match = (not variant_tokens or variant_tokens.issubset(candidate_tokens)) and title_variant_match
    source_size = source_size_text(product)
    expected_measurements = measurements(source_size)
    size_match = not source_size or (
        measurements_match(expected_measurements, measurements(filtered_candidate_title, source_size))
        if expected_measurements
        else tokens(clean_title(source_size)).issubset(candidate_tokens)
    )
    pack_match, pack_match_type = classify_pack_match(product.pack, source_size, candidate_title)
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
        tier = "high"
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
        }
    )
    return classified


def build_search_queries(product):
    queries: list[tuple[str, str]] = []

    size = source_size_text(product)
    brand = product.brand
    raw_title = product.title
    variant = clean_title(product.variant)
    image_terms = product.image_terms
    pack = product.pack
    category = product.category

    cleaned_title = clean_title(raw_title)
    core_title = re.sub(r"\s*\([^)]*\)\s*", " ", cleaned_title)
    core_title = " ".join(core_title.split())

    title_without_brand = core_title
    if brand:
        brand_tokens = set(clean_title(brand).lower().split())
        title_words = title_without_brand.split()
        title_without_brand = " ".join(w for w in title_words if w.lower() not in brand_tokens)

    def add_query(stage: str, parts: list[str]):
        query = clean_title(" ".join(filter(None, parts)))
        if query:
            queries.append((stage, query))

    def add_descriptor_expanded_queries(stage: str, parts: list[str]):
        base_query = clean_title(" ".join(filter(None, parts)))
        if not base_query:
            return
        add_query(stage, [base_query])
        expanded = PRODUCT_DESCRIPTORS.expand_query(
            base_query,
            brand=brand,
            category=category,
            max_expansions=2
        )
        for i, exp_query in enumerate(expanded[1:], 1):
            exp_stage = f"{stage}-desc{i}"
            queries.append((exp_stage, exp_query))

    # Priority 1: Brand + Title (BROAD - no size constraint)
    if brand and title_without_brand:
        add_descriptor_expanded_queries("brand-title", [brand, title_without_brand])
        if pack and pack != "":
            add_descriptor_expanded_queries("brand-title-pack", [brand, title_without_brand, pack])

    if brand and title_without_brand and variant:
        add_descriptor_expanded_queries("brand-title-variant", [brand, title_without_brand, variant])
        if pack and pack != "":
            add_descriptor_expanded_queries("brand-title-variant-pack", [brand, title_without_brand, variant, pack])

    # Priority 2: Brand + Title + Size (CONSTRAINED)
    if brand and title_without_brand and size:
        add_descriptor_expanded_queries("brand-title-size", [brand, title_without_brand, size])
        if pack and pack != "":
            add_descriptor_expanded_queries("brand-title-size-pack", [brand, title_without_brand, size, pack])

    if brand and title_without_brand and size and variant:
        add_descriptor_expanded_queries("brand-title-size-variant", [brand, title_without_brand, size, variant])
        if pack and pack != "":
            add_descriptor_expanded_queries("brand-title-size-variant-pack", [brand, title_without_brand, size, variant, pack])

    # Priority 3: Original Title (Exact user text - preserves parentheses)
    if raw_title:
        queries.append(("title-original", raw_title))

    # Priority 4: Title-only broad searches (no brand)
    if core_title and core_title != cleaned_title:
        add_query("title-core", [core_title])
    if cleaned_title:
        add_query("title-only", [cleaned_title])
    if title_without_brand and title_without_brand != core_title and title_without_brand != cleaned_title:
        add_query("title-no-brand", [title_without_brand])

    # Priority 5: Brand + Size / Brand + Variant (Fallbacks)
    if brand and size:
        add_query("brand-size", [brand, size])

    if brand and variant:
        add_query("brand-variant", [brand, variant])

    # Priority 6: Image-based searches
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


def fetch_amazon_page(url: str):
    response = requests.get(
        url,
        headers=HEADERS,
        timeout=AMAZON_TIMEOUT_SECONDS,
        allow_redirects=True,
        stream=True,
    )
    if response.url not in {"https://www.amazon.co.uk", "https://amazon.co.uk"}:
        hostname = response.url.split("/")[2]
        if "amazon" not in hostname:
            raise RuntimeError(f"Redirected to non-Amazon: {response.url}")
    html = read_limited_response(response, MAX_PAGE_BYTES)
    if response.status_code in {403, 429, 503}:
        raise RuntimeError("Amazon is temporarily limiting requests.")
    if response.status_code != 200:
        raise RuntimeError(f"Amazon UK returned HTTP {response.status_code}.")
    html_text = html.decode("utf-8", errors="replace")
    lowered = html_text.lower()
    if "captcha" in lowered or "automated access" in lowered or "validatecaptcha" in lowered:
        raise RuntimeError("Amazon is showing a CAPTCHA or automated-access block.")
    return html_text


def search_amazon(query: str, ean: str, page: int = 1):
    search_url = f"{AMAZON_ORIGIN}/s?{urllib.parse.urlencode({'k': query, 'page': page})}"
    print(f"\n  [SEARCH] Page {page}: {query}")
    print(f"  [URL] {search_url}")
    html_text = fetch_amazon_page(search_url)
    lowered = html_text.lower()
    if "no results for" in lowered or "did not match any products" in lowered:
        print(f"  [RESULT] No results")
        return []
    return extract_amazon_candidates(html_text, ean)


def search_amazon_all_pages(query: str, ean: str, max_pages: int = 5):
    all_candidates: list[dict[str, Any]] = []
    seen_asins: set[str] = set()

    for page in range(1, max_pages + 1):
        try:
            candidates = search_amazon(query, ean, page)
        except RuntimeError as e:
            print(f"  [ERROR] {e}")
            break

        if not candidates:
            print(f"  [RESULT] No candidates on page {page}, stopping")
            break

        for candidate in candidates:
            asin = candidate.get("asin", "")
            if asin and asin not in seen_asins:
                seen_asins.add(asin)
                all_candidates.append(candidate)

        print(f"  [RESULT] Page {page}: {len(candidates)} candidates (total unique: {len(all_candidates)})")

        if len(candidates) < 20:
            print(f"  [RESULT] Fewer than 20 results, likely last page")
            break

    return all_candidates


def extract_amazon_candidates(html: str, ean: str):
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

    # Fallback
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


def asin_from_href(href: str) -> str:
    parsed = urllib.parse.urlparse(urllib.parse.urljoin(AMAZON_ORIGIN, href))
    paths = [parsed.path]
    query = urllib.parse.parse_qs(parsed.query)
    for key in ("url", "redirect", "u"):
        for nested_url in query.get(key, []):
            paths.append(urllib.parse.urlparse(urllib.parse.unquote(nested_url)).path)

    for path in paths:
        asin_match = re.search(r"/(?:dp|gp/product|gp/aw/d)/([A-Z0-9]{10})(?:[/?]|$)", path, re.IGNORECASE)
        if asin_match:
            return asin_match.group(1).upper()
    return ""


def amazon_product_url(href: str, asin: str) -> str:
    parsed = urllib.parse.urlparse(urllib.parse.urljoin(AMAZON_ORIGIN, href))
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


def image_from_card(image) -> str:
    source = image.get("data-src") or image.get("data-original") or image.get("src")
    if not source:
        srcset = image.get("srcset", "").split(",")
        if srcset:
            source = srcset[0].strip().split(" ")[0]
    if not source or source.startswith("data:"):
        return ""
    return safe_amazon_image_url(source)


def safe_amazon_image_url(value: str) -> str:
    try:
        parsed = urllib.parse.urlparse(urllib.parse.urljoin(AMAZON_ORIGIN, value))
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


def extract_seller_name(value: str) -> str:
    match = re.search(
        r"\b(?:shipper\s*/\s*seller|sold\s+by|seller)\s*:?\s*(.+?)(?=\s+(?:(?:and\s+)?(?:ships?|dispatches?|dispatched)\s+(?:from|by)|returns?|conditions?)\b|\s*[|]|$)",
        value,
        re.IGNORECASE,
    )
    return normalize_text(match.group(1)).strip(" ,;|") if match else ""


# ============================================================================
# MAIN DEBUG FUNCTION
# ============================================================================

class Product:
    def __init__(self, **kwargs):
        for k, v in kwargs.items():
            setattr(self, k, v)

def debug_product():
    # Supplier product data (from your spreadsheet)
    supplier = Product(
        ean="",
        title="ZOFLORA DISINFECTANT - LEMON ZING (wsl)",
        brand="Zoflora",
        variant="Lemon Zing",
        size="120ml",
        pack="Pack of 4",
        image_terms="",
        category="",
    )

    print("=" * 80)
    print("SUPPLIER PRODUCT")
    print("=" * 80)
    for k in ["ean", "title", "brand", "variant", "size", "pack", "image_terms", "category"]:
        print(f"  {k}: {getattr(supplier, k)}")

    # Step 1: Show what queries are generated
    print("\n" + "=" * 80)
    print("SEARCH QUERIES GENERATED (build_search_queries)")
    print("=" * 80)
    queries = build_search_queries(supplier)
    for i, (stage, query) in enumerate(queries, 1):
        print(f"  {i:2d}. [{stage}] {query}")

    # Step 2: Simulate what the target Amazon product would look like
    target_asin = "B0HNWW8QBK"
    amazon_title = "Zoflora Concentrated Disinfectant - 4 x 120ml Lemon Zing - Pack of 4"
    amazon_brand = "Zoflora"

    print(f"\n{'=' * 80}")
    print("TARGET AMAZON PRODUCT (from your URL)")
    print("=" * 80)
    print(f"  ASIN: {target_asin}")
    print(f"  Title: {amazon_title}")
    print(f"  Brand: {amazon_brand}")

    # Step 3: Create a mock candidate and classify it
    mock_candidate = {
        "asin": target_asin,
        "title": amazon_title,
        "amazonTitle": amazon_title,
        "amazonBrand": amazon_brand,
        "productUrl": f"https://www.amazon.co.uk/dp/{target_asin}",
        "price": "£15.01",
        "cardText": amazon_title,
    }

    print(f"\n{'=' * 80}")
    print("CLASSIFICATION OF TARGET PRODUCT")
    print("=" * 80)
    classified = classify_candidate(supplier, mock_candidate)
    print(f"  Tier: {classified.get('tier')}")
    print(f"  Reason: {classified.get('reason')}")
    print(f"  brandMatch: {classified.get('brandMatch')}")
    print(f"  sizeMatch: {classified.get('sizeMatch')}")
    print(f"  variantMatch: {classified.get('variantMatch')}")
    print(f"  packMatch: {classified.get('packMatch')} ({classified.get('packMatchType')})")
    print(f"  titleScore: {classified.get('titleScore')}")

    # Step 4: Detailed title analysis
    print(f"\n{'=' * 80}")
    print("DETAILED TITLE ANALYSIS")
    print("=" * 80)
    supplier_clean = clean_title(supplier.title)
    core_title = re.sub(r"\s*\([^)]*\)\s*", " ", supplier_clean).strip()
    print(f"  Supplier raw:     {supplier.title}")
    print(f"  Supplier cleaned: {supplier_clean}")
    print(f"  Supplier core:    {core_title}")
    print(f"  Amazon title:     {amazon_title}")

    supplier_tokens = tokens(supplier_clean)
    amazon_tokens = tokens(amazon_title)
    overlap = supplier_tokens & amazon_tokens
    print(f"\n  Supplier tokens:  {sorted(supplier_tokens)}")
    print(f"  Amazon tokens:    {sorted(amazon_tokens)}")
    print(f"  Overlap:          {sorted(overlap)}")
    print(f"  Supplier only:    {sorted(supplier_tokens - amazon_tokens)}")
    print(f"  Amazon only:      {sorted(amazon_tokens - supplier_tokens)}")

    coverage = len(overlap) / max(1, len(supplier_tokens))
    print(f"  Coverage:         {coverage:.1%}")

    # Check distinctive tokens
    brand_tokens = tokens(clean_title(supplier.brand))
    variant_tokens = tokens(clean_title(supplier.variant))
    category = CATEGORY_DICTIONARY.get(supplier.category, {})
    alias_tokens = [tokens(alias) for alias in category.get("aliases", [])]
    alias_tokens = [alias for alias in alias_tokens if alias]
    category_words = set().union(*alias_tokens) if alias_tokens else set()
    distinctive_title_tokens = tokens(clean_title(supplier.title)) - brand_tokens - variant_tokens - category_words
    distinctive_title_tokens = {
        token
        for token in distinctive_title_tokens
        if token not in TITLE_CONNECTOR_WORDS and not re.search(r"\d", token)
    }
    print(f"\n  Brand tokens:     {sorted(brand_tokens)}")
    print(f"  Variant tokens:   {sorted(variant_tokens)}")
    print(f"  Category words:   {sorted(category_words)}")
    print(f"  Distinctive title tokens: {sorted(distinctive_title_tokens)}")
    print(f"  In Amazon title:  {distinctive_title_tokens.issubset(amazon_tokens)}")

    # Test descriptor filtering
    print(f"\n{'=' * 80}")
    print("DESCRIPTOR FILTERING TEST")
    print("=" * 80)
    filtered = PRODUCT_DESCRIPTORS.filter_descriptors(amazon_title)
    print(f"  Original:  {amazon_title}")
    print(f"  Filtered:  {filtered}")
    found = PRODUCT_DESCRIPTORS.find_descriptors(amazon_title)
    print(f"  Found descriptors: {found}")

    # Test query expansion
    base_query = "Zoflora Disinfectant Lemon Zing"
    expanded = PRODUCT_DESCRIPTORS.expand_query(base_query, brand="Zoflora", category="")
    print(f"\n  Base query: {base_query}")
    print(f"  Expanded queries:")
    for q in expanded:
        print(f"    - {q}")

    # Step 5: Size analysis
    print(f"\n{'=' * 80}")
    print("SIZE ANALYSIS")
    print("=" * 80)
    source_size = source_size_text(supplier)
    print(f"  Source size text: {source_size}")
    expected_measurements = measurements(source_size)
    # Use filtered title for size matching
    amazon_measurements = measurements(filtered, source_size)
    print(f"  Expected measurements: {expected_measurements}")
    print(f"  Amazon measurements (filtered): {amazon_measurements}")
    print(f"  Size match: {measurements_match(expected_measurements, amazon_measurements)}")

    # Step 6: Pack analysis
    print(f"\n{'=' * 80}")
    print("PACK ANALYSIS")
    print("=" * 80)
    print(f"  Source pack: {supplier.pack}")
    expected_pack_qty = extract_source_pack_quantity(supplier.pack)
    print(f"  Expected pack quantity: {expected_pack_qty}")
    outer, inner, listing_qty = extract_amazon_pack_components(amazon_title, source_size)
    print(f"  Amazon pack components: outer={outer}, inner={inner}, total={listing_qty}")
    pack_match, pack_type = classify_pack_match(supplier.pack, source_size, amazon_title)
    print(f"  Pack match: {pack_match} ({pack_type})")

    # Step 7: Why it might not appear in search results
    print(f"\n{'=' * 80}")
    print("WHY THE TARGET PRODUCT MIGHT NOT APPEAR IN SEARCH RESULTS")
    print("=" * 80)
    print("  1. POSITION 63 - Amazon only shows ~20 results per page by default")
    print("     The skill searches up to 5 pages (100 results), but stops early if:")
    print("     - A page returns < 20 results (assumes last page)")
    print("     - Amazon blocks the request (CAPTCHA, rate limit)")
    print("     - HTTP 500 errors (retried 3x with backoff)")
    print()
    print("  2. QUERY TERMS - The generated queries include:")
    for i, (stage, query) in enumerate(queries[:8], 1):
        print(f"     [{stage}] \"{query}\"")
    print()
    print("     Key issue: 'Concentrated' is in Amazon title but NOT in supplier title")
    print("     The word 'Concentrated' is a distinctive product word that's missing")
    print()
    print("  3. TITLE SCORE - Without 'Concentrated', title coverage is lower")
    print(f"     Current coverage: {coverage:.1%} (needs >= 50% for medium tier)")
    print()
    print("  4. SEARCH RESULT RANKING - Amazon's relevance ranking may place this")
    print("     product at position 63 because the query terms don't include")
    print("     'Concentrated' or '4 x 120ml' format")


if __name__ == "__main__":
    debug_product()