export function buildAmazonSearchUrl(query: string): string {
  return `https://www.amazon.co.uk/s?${new URLSearchParams({ k: query })}`;
}
