"""
Product Descriptor Dictionary System

Handles Amazon UK product title descriptors that are NOT differentiating features.
These are manufacturing/formulation/packaging descriptors that appear in Amazon
titles but shouldn't cause matching failures.

Usage:
    from product_descriptors import ProductDescriptors

    descriptors = ProductDescriptors()

    # Filter descriptors from a title for matching
    clean_title = descriptors.filter_descriptors(amazon_title)

    # Expand search query with relevant descriptors
    expanded_queries = descriptors.expand_query(base_query, brand="Zoflora")

    # Check if a word is a descriptor
    is_desc = descriptors.is_descriptor("Concentrated")
"""

import json
import re
from pathlib import Path
from typing import Any
from functools import lru_cache


class ProductDescriptors:
    """
    Manages product descriptor words for Amazon UK matching.

    Descriptors are words that appear in Amazon titles but are NOT
    differentiating product features (variant, size, scent, etc.).
    They're manufacturing/formulation/packaging descriptors.
    """

    def __init__(self, dict_path: str | Path | None = None):
        if dict_path is None:
            dict_path = Path(__file__).parent / "product_descriptors.json"
        self.dict_path = Path(dict_path)
        self._data: dict[str, Any] = {}
        self._all_descriptors: set[str] = set()
        self._descriptor_pattern: re.Pattern | None = None
        self._load()

    def _load(self) -> None:
        """Load descriptor dictionary from JSON file."""
        with open(self.dict_path, "r", encoding="utf-8") as f:
            self._data = json.load(f)

        # Build flat set of all descriptors (lowercased)
        # ONLY include category descriptors, NOT brand-specific words
        # Brand-specific words are for QUERY EXPANSION only, not for filtering
        self._all_descriptors = set()

        # Category descriptors (these are the actual descriptors to filter)
        for cat_name, cat_data in self._data.get("categories", {}).items():
            for word in cat_data.get("words", []):
                self._all_descriptors.add(word.lower())

        # Compile regex pattern for efficient matching
        # Sort by length descending to match longer phrases first
        # Use word boundaries that handle punctuation properly
        sorted_descriptors = sorted(self._all_descriptors, key=len, reverse=True)
        escaped = [re.escape(d) for d in sorted_descriptors]
        # Match whole words/phrases with flexible boundaries (punctuation, whitespace, start/end)
        self._descriptor_pattern = re.compile(
            r"(?<!\w)(" + "|".join(escaped) + r")(?!\w)",
            re.IGNORECASE
        )

    def reload(self) -> None:
        """Reload dictionary from file (useful after updates)."""
        self._load()

    @property
    def all_descriptors(self) -> set[str]:
        """Get all descriptor words (lowercased)."""
        return self._all_descriptors.copy()

    @property
    def categories(self) -> dict[str, Any]:
        """Get category definitions."""
        return self._data.get("categories", {}).copy()

    @property
    def brand_specific(self) -> dict[str, list[str]]:
        """Get brand-specific descriptors (for query expansion only)."""
        return {k: v.copy() for k, v in self._data.get("brand_specific", {}).items()}

    def is_descriptor(self, word: str) -> bool:
        """Check if a word/phrase is a known descriptor."""
        return word.lower() in self._all_descriptors

    def get_category(self, word: str) -> str | None:
        """Get the category a descriptor belongs to."""
        word_lower = word.lower()
        for cat_name, cat_data in self._data.get("categories", {}).items():
            if word_lower in [w.lower() for w in cat_data.get("words", [])]:
                return cat_name
        # Brand-specific words are not descriptors for filtering purposes
        return None

    def find_descriptors(self, text: str) -> list[tuple[str, str]]:
        """
        Find all descriptors in text.
        Returns list of (matched_text, category).
        """
        matches = []
        for match in self._descriptor_pattern.finditer(text):
            matched = match.group(0)
            category = self.get_category(matched)
            matches.append((matched, category or "unknown"))
        return matches

    def filter_descriptors(self, text: str) -> str:
        """
        Remove descriptor words from text for matching purposes.
        Preserves spacing and punctuation.
        """
        # Replace descriptors with empty string, but preserve spacing
        def replace_match(match: re.Match) -> str:
            # Return spaces to maintain word boundaries
            return " " * len(match.group(0))

        cleaned = self._descriptor_pattern.sub(replace_match, text)
        # Normalize whitespace
        cleaned = re.sub(r"\s+", " ", cleaned).strip()
        return cleaned

    def filter_descriptors_tokens(self, tokens: set[str]) -> set[str]:
        """
        Filter descriptor tokens from a token set.
        """
        return {t for t in tokens if t.lower() not in self._all_descriptors}

    def get_relevant_descriptors(self, brand: str = "", category: str = "") -> list[str]:
        """
        Get descriptors relevant to a specific brand or category.
        Returns list sorted by length (longest first) for query expansion.
        Includes BOTH category descriptors and brand-specific words.
        """
        relevant = set()

        # Brand-specific descriptors (for query expansion)
        if brand:
            brand_lower = brand.lower()
            for b, words in self._data.get("brand_specific", {}).items():
                if b.lower() in brand_lower or brand_lower in b.lower():
                    relevant.update(w.lower() for w in words)

        # Category-specific descriptors
        if category:
            cat_lower = category.lower()
            for cat_name, cat_data in self._data.get("categories", {}).items():
                if cat_name.lower() in cat_lower or any(
                    kw in cat_lower for kw in cat_name.split("_")
                ):
                    relevant.update(w.lower() for w in cat_data.get("words", []))

        # Always include formulation and quality descriptors (most common)
        for cat_name in ["formulation", "quality_grade", "professional_use"]:
            if cat_name in self._data.get("categories", {}):
                relevant.update(w.lower() for w in self._data["categories"][cat_name]["words"])

        # Sort by length descending for query building
        return sorted(relevant, key=len, reverse=True)

    def expand_query(self, base_query: str, brand: str = "", category: str = "", max_expansions: int = 3) -> list[str]:
        """
        Expand a base search query with relevant descriptors.

        Args:
            base_query: The original search query
            brand: Product brand (for brand-specific descriptors)
            category: Product category (for category-specific descriptors)
            max_expansions: Maximum number of expanded queries to return

        Returns:
            List of queries including the base query and expanded versions
        """
        queries = [base_query]
        relevant = self.get_relevant_descriptors(brand, category)

        # Add 1-2 most relevant descriptors
        for desc in relevant[:max_expansions]:
            expanded = f"{base_query} {desc}"
            if expanded not in queries:
                queries.append(expanded)

        return queries

    def add_descriptor(self, word: str, category: str = "custom", brand: str | None = None) -> None:
        """
        Add a new descriptor word to the dictionary.

        Args:
            word: The descriptor word/phrase
            category: Category name (or "custom")
            brand: Optional brand for brand-specific descriptor
        """
        word_lower = word.lower()
        self._all_descriptors.add(word_lower)

        # Update JSON file
        if brand:
            if "brand_specific" not in self._data:
                self._data["brand_specific"] = {}
            if brand not in self._data["brand_specific"]:
                self._data["brand_specific"][brand] = []
            if word_lower not in [w.lower() for w in self._data["brand_specific"][brand]]:
                self._data["brand_specific"][brand].append(word)
        else:
            if "categories" not in self._data:
                self._data["categories"] = {}
            if category not in self._data["categories"]:
                self._data["categories"][category] = {"description": "", "words": []}
            if word_lower not in [w.lower() for w in self._data["categories"][category]["words"]]:
                self._data["categories"][category]["words"].append(word)

        self._save()
        self._load()  # Recompile pattern

    def _save(self) -> None:
        """Save dictionary to JSON file."""
        with open(self.dict_path, "w", encoding="utf-8") as f:
            json.dump(self._data, f, indent=2, ensure_ascii=False)

    def learn_from_mismatch(self, supplier_title: str, amazon_title: str, brand: str = "") -> list[str]:
        """
        Analyze a mismatch and suggest new descriptors to add.

        Finds words in Amazon title that aren't in supplier title
        and aren't size/variant/pack - likely descriptors.

        Returns:
            List of suggested new descriptor words
        """
        from main import clean_title, tokens

        supplier_clean = clean_title(supplier_title)
        amazon_clean = clean_title(amazon_title)

        supplier_tokens = tokens(supplier_clean)
        amazon_tokens = tokens(amazon_clean)

        # Words in Amazon but not supplier
        extra_tokens = amazon_tokens - supplier_tokens

        # Filter out known descriptors
        unknown_extra = {t for t in extra_tokens if t not in self._all_descriptors}

        # Filter out size-like tokens (numbers + units)
        size_like = {t for t in unknown_extra if re.match(r"\d+(ml|g|kg|l|mm|cm|count|pcs)", t)}

        # Filter out variant-like tokens (known variants)
        # This would need variant list - for now just return candidates
        candidates = unknown_extra - size_like

        # Sort by frequency heuristic (shorter words more likely to be descriptors)
        return sorted(candidates, key=len)


# Global instance for easy import
_descriptors_instance: ProductDescriptors | None = None


def get_descriptors() -> ProductDescriptors:
    """Get global ProductDescriptors instance (singleton)."""
    global _descriptors_instance
    if _descriptors_instance is None:
        _descriptors_instance = ProductDescriptors()
    return _descriptors_instance


# Convenience functions
def filter_descriptors(text: str) -> str:
    """Remove descriptors from text for matching."""
    return get_descriptors().filter_descriptors(text)


def is_descriptor(word: str) -> bool:
    """Check if word is a known descriptor."""
    return get_descriptors().is_descriptor(word)


def find_descriptors(text: str) -> list[tuple[str, str]]:
    """Find all descriptors in text with categories."""
    return get_descriptors().find_descriptors(text)


def expand_query(base_query: str, brand: str = "", category: str = "", max_expansions: int = 3) -> list[str]:
    """Expand query with relevant descriptors."""
    return get_descriptors().expand_query(base_query, brand, category, max_expansions)


if __name__ == "__main__":
    # Demo
    desc = ProductDescriptors()

    # Test filtering
    amazon_title = "Zoflora Concentrated Disinfectant - 4 x 120ml Lemon Zing - Pack of 4"
    filtered = desc.filter_descriptors(amazon_title)
    print(f"Original:  {amazon_title}")
    print(f"Filtered:  {filtered}")

    # Test finding
    found = desc.find_descriptors(amazon_title)
    print(f"Found descriptors: {found}")

    # Test query expansion
    expanded = desc.expand_query("Zoflora Disinfectant Lemon Zing", brand="Zoflora")
    print(f"Expanded queries: {expanded}")

    # Test is_descriptor
    print(f"is 'Concentrated' a descriptor? {desc.is_descriptor('Concentrated')}")
    print(f"is 'Lemon' a descriptor? {desc.is_descriptor('Lemon')}")
    print(f"is '120ml' a descriptor? {desc.is_descriptor('120ml')}")
    print(f"is 'Disinfectant' a descriptor? {desc.is_descriptor('Disinfectant')}")
    print(f"is 'Zoflora' a descriptor? {desc.is_descriptor('Zoflora')}")