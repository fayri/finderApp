import categoryDictionary from "../../product_category_terms.json";

const categories = categoryDictionary.categories;

export type ProductCategoryId = keyof typeof categories;

function normalizePhrase(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function isProductCategoryId(value: unknown): value is ProductCategoryId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(categories, value);
}

export function fallbackCategory(title: string): ProductCategoryId {
  const normalizedTitle = ` ${normalizePhrase(title)} `;
  const matches: Array<{ id: ProductCategoryId; words: number; length: number }> = [];

  for (const [id, category] of Object.entries(categories) as Array<[ProductCategoryId, (typeof categories)[ProductCategoryId]]>) {
    for (const hint of category.titleHints) {
      const normalizedHint = normalizePhrase(hint);
      if (normalizedHint && normalizedTitle.includes(` ${normalizedHint} `)) {
        matches.push({ id, words: normalizedHint.split(" ").length, length: normalizedHint.length });
      }
    }
  }

  matches.sort((left, right) => right.words - left.words || right.length - left.length);
  return matches[0]?.id ?? "other";
}
