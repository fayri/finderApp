interface AmazonProductSearchQueryInput {
  brand?: string;
  title?: string;
  variant?: string;
  imageTerms?: string;
  size?: string;
}

function containsWholePhrase(text: string, value: string): boolean {
  const escapedValue = value
    .trim()
    .split(/\s+/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
  return Boolean(escapedValue && new RegExp(`(?<![a-z0-9])${escapedValue}(?![a-z0-9])`, "i").test(text));
}

function containsExactSize(text: string, size: string): boolean {
  const measurement = size.trim().match(/^(\d+(?:[.,]\d+)?)\s*([a-z]+(?:\s+[a-z]+)?)$/i);
  if (measurement) {
    const number = measurement[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const unit = measurement[2]
      .trim()
      .split(/\s+/)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("\\s*");
    return new RegExp(`(?<!\\d)${number}\\s*${unit}(?![a-z0-9])`, "i").test(text);
  }

  const escapedSize = size.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*");
  return Boolean(escapedSize && new RegExp(`(?<![a-z0-9])${escapedSize}(?![a-z0-9])`, "i").test(text));
}

export function buildAmazonProductSearchQuery({
  brand = "",
  title = "",
  variant = "",
  imageTerms = "",
  size = "",
}: AmazonProductSearchQueryInput): string {
  const productText = [title, variant, imageTerms].filter(Boolean).join(" ");
  const parts = [containsWholePhrase(productText, brand) ? "" : brand, title, variant, imageTerms].filter(Boolean);
  if (size && !containsExactSize(parts.join(" "), size)) parts.push(size);
  return parts.join(" ");
}

export function buildAmazonSearchUrl(query: string): string {
  return `https://www.amazon.co.uk/s?${new URLSearchParams({ k: query })}`;
}
