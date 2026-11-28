#!/usr/bin/env python3
"""
Test pack size format handling: 4 x 120, 4 x 120ml, 120 x 4, etc.
"""

import sys
import re
from decimal import Decimal
from pathlib import Path
from typing import Any
sys.path.insert(0, str(Path(__file__).resolve().parent / "backend"))

from product_descriptors import ProductDescriptors, get_descriptors

# Copy necessary functions from main.py to avoid fastapi import
def clean_title(title: str) -> str:
    cleaned = re.sub(r"\s*\([^)]*\)\s*", " ", title)
    cleaned = re.sub(r"\bTEMU\b", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\^+", "", cleaned)
    return " ".join(cleaned.split())

def normalize_text(value: str) -> str:
    return " ".join(value.replace(" ", " ").split()).strip()

def tokens(value: str) -> set[str]:
    return set(re.findall(r"[a-z0-9]+", value.lower()))

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
        result.add(f"{format(number.normalize(), 'f')}{unit}")

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
        # Pattern: "4 x 120" (pack count x unit size) - with spaces around x
        implicit_pattern = re.compile(
            rf"(?<!\w)(\d{{1,3}})\s*[x×]\s*(\d+(?:[.,]\d+)?)\b(?!\s*(?:fl\s?oz|millilitres?|milliliters?|ml|cl|litres?|liters?|l|kilograms?|kg|milligrams?|mg|grams?|grammes?|gm|g|centimetres?|centimeters?|cm|millimetres?|millimeters?|mm|metres?|meters?|m|pieces?|pcs?|tablets?|wipes?|sachets?|capsules?|packs?|pks?|count|ct|units?))",
            re.IGNORECASE,
        )
        for number_text, unit_text in implicit_pattern.findall(value):
            number = Decimal(unit_text.replace(",", "."))
            if abs(number - context_unit_value) < Decimal("0.01"):
                result.add(f"{format(number.normalize(), 'f')}{inferred_unit}")
                result.add(f"{int(number_text)}count")

        # Pattern: "4x120" (pack count x unit size) - NO spaces around x
        implicit_no_space = re.compile(
            rf"(?<!\w)(\d{{1,3}})[x×](\d+(?:[.,]\d+)?)\b(?!\s*(?:fl\s?oz|millilitres?|milliliters?|ml|cl|litres?|liters?|l|kilograms?|kg|milligrams?|mg|grams?|grammes?|gm|g|centimetres?|centimeters?|cm|millimetres?|millimeters?|mm|metres?|meters?|m|pieces?|pcs?|tablets?|wipes?|sachets?|capsules?|packs?|pks?|count|ct|units?))",
            re.IGNORECASE,
        )
        for number_text, unit_text in implicit_no_space.findall(value):
            number = Decimal(unit_text.replace(",", "."))
            if abs(number - context_unit_value) < Decimal("0.01"):
                result.add(f"{format(number.normalize(), 'f')}{inferred_unit}")
                result.add(f"{int(number_text)}count")

        # Pattern: "120 x 4" (unit size x pack count, reversed) - with spaces
        implicit_reversed = re.compile(
            rf"(?<!\w)(\d+(?:[.,]\d+)?)\s*[x×]\s*(\d{{1,3}})\b(?!\s*(?:fl\s?oz|millilitres?|milliliters?|ml|cl|litres?|liters?|l|kilograms?|kg|milligrams?|mg|grams?|grammes?|gm|g|centimetres?|centimeters?|cm|millimetres?|millimeters?|mm|metres?|meters?|m|pieces?|pcs?|tablets?|wipes?|sachets?|capsules?|packs?|pks?|count|ct|units?))",
            re.IGNORECASE,
        )
        for number_text, pack_text in implicit_reversed.findall(value):
            number = Decimal(number_text.replace(",", "."))
            pack_count = int(pack_text)
            if abs(number - context_unit_value) < Decimal("0.01") and pack_count <= 100:
                result.add(f"{format(number.normalize(), 'f')}{inferred_unit}")
                result.add(f"{pack_count}count")

        # Pattern: "120x4" (unit size x pack count, reversed) - NO spaces
        implicit_reversed_no_space = re.compile(
            rf"(?<!\w)(\d+(?:[.,]\d+)?)[x×](\d{{1,3}})\b(?!\s*(?:fl\s?oz|millilitres?|milliliters?|ml|cl|litres?|liters?|l|kilograms?|kg|milligrams?|mg|grams?|grammes?|gm|g|centimetres?|centimeters?|cm|millimetres?|millimeters?|mm|metres?|meters?|m|pieces?|pcs?|tablets?|wipes?|sachets?|capsules?|packs?|pks?|count|ct|units?))",
            re.IGNORECASE,
        )
        for number_text, pack_text in implicit_reversed_no_space.findall(value):
            number = Decimal(number_text.replace(",", "."))
            pack_count = int(pack_text)
            if abs(number - context_unit_value) < Decimal("0.01") and pack_count <= 100:
                result.add(f"{format(number.normalize(), 'f')}{inferred_unit}")
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
            # Pattern: "4 x 120" (pack count x unit size, without unit, context confirms unit size)
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

            # Pattern: "120 x 4" (unit size x pack count, reversed, without unit)
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

            # Additional pattern: "4x120" (no spaces around x) with unit in context
            implicit_no_space = re.search(
                rf"(?<!\w)(\d{{1,3}})[x×](\d+(?:[.,]\d+)?)\b(?!\s*(?:fl\s?oz|millilitres?|milliliters?|ml|cl|litres?|liters?|l|kilograms?|kg|milligrams?|mg|grams?|grammes?|gm|g|centimetres?|centimeters?|cm|millimetres?|millimeters?|mm|metres?|meters?|m|pieces?|pcs?|tablets?|wipes?|sachets?|capsules?|packs?|pks?|count|ct|units?))",
                title,
                re.IGNORECASE,
            )
            if implicit_no_space:
                pack_count = max(1, int(implicit_no_space.group(1)))
                unit_size = Decimal(implicit_no_space.group(2).replace(",", "."))
                if abs(unit_size - context_unit_value) < Decimal("0.01"):
                    return pack_count, None, pack_count

            # Reversed no-space: "120x4"
            implicit_reversed_no_space = re.search(
                rf"(?<!\w)(\d+(?:[.,]\d+)?)[x×](\d{{1,3}})\b(?!\s*(?:fl\s?oz|millilitres?|milliliters?|ml|cl|litres?|liters?|l|kilograms?|kg|milligrams?|mg|grams?|grammes?|gm|g|centimetres?|centimeters?|cm|millimetres?|millimeters?|mm|metres?|meters?|m|pieces?|pcs?|tablets?|wipes?|sachets?|capsules?|packs?|pks?|count|ct|units?))",
                title,
                re.IGNORECASE,
            )
            if implicit_reversed_no_space:
                first_num = Decimal(implicit_reversed_no_space.group(1).replace(",", "."))
                second_num = max(1, int(implicit_reversed_no_space.group(2)))
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
    count_measurements = [m for m in _measurements_internal(size) if m.endswith("count")]
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

class Product:
    def __init__(self, **kwargs):
        for k, v in kwargs.items():
            setattr(self, k, v)

PRODUCT_DESCRIPTORS = get_descriptors()

# Test cases for pack format handling
test_cases = [
    {
        "name": "4 x 120ml (standard)",
        "amazon_title": "Zoflora Concentrated Disinfectant - 4 x 120ml Lemon Zing - Pack of 4",
        "source_size": "120ml",
        "source_pack": "Pack of 4"
    },
    {
        "name": "4 x 120 (no unit, with context)",
        "amazon_title": "Zoflora Disinfectant - 4 x 120 Lemon Zing - Pack of 4",
        "source_size": "120ml",
        "source_pack": "Pack of 4"
    },
    {
        "name": "120 x 4 (reversed)",
        "amazon_title": "Zoflora Disinfectant - 120 x 4 Lemon Zing",
        "source_size": "120ml",
        "source_pack": "Pack of 4"
    },
    {
        "name": "4x120ml (no spaces)",
        "amazon_title": "Zoflora Disinfectant 4x120ml Lemon Zing Pack of 4",
        "source_size": "120ml",
        "source_pack": "Pack of 4"
    },
    {
        "name": "4 x 120 ml (space in unit)",
        "amazon_title": "Zoflora Disinfectant - 4 x 120 ml Lemon Zing",
        "source_size": "120ml",
        "source_pack": "Pack of 4"
    },
    {
        "name": "6 x 120ml (different pack count)",
        "amazon_title": "Zoflora Disinfectant - 6 x 120ml Lemon Zing",
        "source_size": "120ml",
        "source_pack": "Pack of 4"
    },
    {
        "name": "2 x 5 x 120ml (compound pack)",
        "amazon_title": "Zoflora Disinfectant - 2 x 5 x 120ml Lemon Zing",
        "source_size": "120ml",
        "source_pack": "Pack of 10"
    },
    {
        "name": "120ml x 4 (reversed with unit)",
        "amazon_title": "Zoflora Disinfectant 120ml x 4 Lemon Zing",
        "source_size": "120ml",
        "source_pack": "Pack of 4"
    },
    {
        "name": "Pack of 4 x 120ml",
        "amazon_title": "Zoflora Disinfectant Pack of 4 x 120ml Lemon Zing",
        "source_size": "120ml",
        "source_pack": "Pack of 4"
    },
]

print("=" * 80)
print("PACK FORMAT HANDLING TESTS")
print("=" * 80)

for tc in test_cases:
    print(f"\n--- {tc['name']} ---")
    print(f"  Amazon title: {tc['amazon_title']}")
    print(f"  Source size:  {tc['source_size']}")
    print(f"  Source pack:  {tc['source_pack']}")

    # Test pack component extraction
    outer, inner, total = extract_amazon_pack_components(tc['amazon_title'], tc['source_size'])
    print(f"  Pack components: outer={outer}, inner={inner}, total={total}")

    # Test measurements
    filtered_title = PRODUCT_DESCRIPTORS.filter_descriptors(tc['amazon_title'])
    amazon_meas = measurements(filtered_title, tc['source_size'])
    expected_meas = measurements(tc['source_size'])
    size_match = expected_meas.issubset(amazon_meas) if expected_meas else False
    print(f"  Expected measurements: {expected_meas}")
    print(f"  Amazon measurements:   {amazon_meas}")
    print(f"  Size match: {size_match}")

    # Test pack matching
    supplier = Product(
        pack=tc['source_pack'],
        size=tc['source_size']
    )
    pack_match, pack_type = classify_pack_match(supplier.pack, supplier.size, tc['amazon_title'])
    print(f"  Pack match: {pack_match} ({pack_type})")

print("\n" + "=" * 80)
print("DESCRIPTOR FILTERING ON VARIOUS TITLES")
print("=" * 80)

test_titles = [
    "Zoflora Concentrated Disinfectant - 4 x 120ml Lemon Zing - Pack of 4",
    "Dettol Original Antibacterial Surface Cleaner - 4 x 500ml",
    "Flash Professional Multi Surface Cleaner - 2 x 1.4L",
    "Fairy Platinum Plus Dishwasher Tablets - 84 Count",
    "Persil Bio Laundry Liquid - 3 x 1.4L",
    "Finish Quantum Ultimate Dishwasher Tablets - 100 Count",
]

for title in test_titles:
    filtered = PRODUCT_DESCRIPTORS.filter_descriptors(title)
    found = PRODUCT_DESCRIPTORS.find_descriptors(title)
    print(f"\n  Original:  {title}")
    print(f"  Filtered:  {filtered}")
    print(f"  Descriptors: {found}")