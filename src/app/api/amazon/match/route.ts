import { load } from "cheerio";

export const maxDuration = 60;

// ============================================================
// CONFIGURATION
// ============================================================

const AMAZON_UK_BASE = "https://www.amazon.co.uk";
const SEARCH_URL = `${AMAZON_UK_BASE}/s`;
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "en-GB,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Cache-Control": "no-cache",
  "Pragma": "no-cache",
};

const MAX_PAGES = 5;
const MAX_SEARCH_QUERIES = 40;
const REQUEST_TIMEOUT = 30000;
const RETRY_500_MAX = 3;
const RETRY_500_BACKOFF = [2000, 4000, 8000]; // ms
const BLOCK_COOLDOWN = 60000; // ms for 403/429/503
const MIN_RESULTS_PER_PAGE = 20;

// Size normalization units (base units)
const VOLUME_UNITS: Record<string, number> = {
  'ml': 1, 'millilitre': 1, 'milliliter': 1, 'millilitres': 1, 'milliliters': 1,
  'cl': 10, 'centilitre': 10, 'centiliter': 10,
  'l': 1000, 'litre': 1000, 'liter': 1000, 'litres': 1000, 'liters': 1000,
  'fl oz': 29.5735, 'floz': 29.5735, 'fl.oz': 29.5735,
};
const WEIGHT_UNITS: Record<string, number> = {
  'mg': 1, 'milligram': 1, 'milligrams': 1,
  'g': 1000, 'gram': 1000, 'grams': 1000,
  'kg': 1000000, 'kilogram': 1000000, 'kilograms': 1000,
};
const LENGTH_UNITS: Record<string, number> = {
  'mm': 1, 'millimetre': 1, 'millimeter': 1,
  'cm': 10, 'centimetre': 10, 'centimeter': 10,
  'm': 1000, 'metre': 1000, 'meter': 1000,
};
const COUNT_UNITS: Record<string, number> = {
  'count': 1, 'pcs': 1, 'pc': 1, 'pieces': 1, 'piece': 1,
  'tablets': 1, 'tablet': 1, 'wipes': 1, 'wipe': 1,
  'sachets': 1, 'sachet': 1, 'capsules': 1, 'capsule': 1,
  'sheets': 1, 'sheet': 1, 'rolls': 1, 'roll': 1,
  'bags': 1, 'bag': 1, 'boxes': 1, 'box': 1,
  'tubes': 1, 'tube': 1, 'bars': 1, 'bar': 1,
  'packets': 1, 'packet': 1, 'pads': 1, 'pad': 1,
  'strips': 1, 'strip': 1, 'fill': 1, 'fills': 1,
  'pk': 1, 'pack': 1, 'x': 1,
};
const ALL_UNITS = { ...VOLUME_UNITS, ...WEIGHT_UNITS, ...LENGTH_UNITS, ...COUNT_UNITS };

// Known brands for extraction
const KNOWN_BRANDS = [
  'ZOFLORA', 'FLAMINGO', 'DISHMATIC', 'GALPHARM', 'SHIP', 'CIF',
  'KLEENEX', 'CUSSONS', 'UMBRO', 'SPONTEX', 'CHERISH', 'SQUEAKY',
  'SAMSON', 'IMPERIAL LEATHER', 'CAREX', 'FOXY', 'INSETTE',
  'OATBURST', 'REFLECTIONS', 'EASY', 'SUPERBRIGHT', 'NEUTRADOL',
  'SPLASH', 'CUSHELLE', 'ANDREX', 'ELBOW GREASE', 'ORIGINAL SOURCE',
  'PRETTY', 'BLOO', 'HUGGIES', 'ESSENTIAL POWER', 'COLGATE', 'DYLON',
  'WHITE ROCK', 'DUO', 'SQUEAKY CLEAN', 'SAMSON', 'SHIP'
].sort((a, b) => b.length - a.length);

// ============================================================
// TYPES
// ============================================================

interface SupplierProduct {
  ean: string;
  title: string;
  brand: string;
  variant: string;
  size: string;
  pack: string;
  imageUrl: string;
  rowNumber: number;
  no: string;
}

interface AmazonCandidate {
  asin: string;
  title: string;
  imageUrl: string;
  productUrl: string;
  price: string;
  seller: string;
  tier: "high" | "medium" | "low";
  reason: string;
  titleScore: number;
  eanMatch: boolean;
  brandMatch: boolean;
  variantMatch: boolean | null;
  sizeMatch: boolean;
  packMatch: boolean;
  packMatchType: string;
  amazonPackCount: number | null;
  amazonPackBreakdown: string;
  amazonUnitPrice: string;
  supplierPackEquivalentPrice: string;
  visualVerdict: string | null;
  visualReason: string;
  imageMatchScore: number | null;
  titleWordCoverage: number | null;
  amazonTitle: string;
  amazonBrand: string;
  searchedBy: string;
}

interface MatchResult {
  supplier: SupplierProduct;
  status: "high" | "medium" | "low" | "not-found" | "blocked" | "error";
  message: string;
  bestCandidate: AmazonCandidate | null;
  candidates: AmazonCandidate[];
  scannedCandidateCount: number;
  searchedQueries: Array<{ stage: string; query: string }>;
}

// ============================================================
// SIZE PARSING & NORMALIZATION
// ============================================================

const SIZE_PATTERN = new RegExp(
  '(?:(\\d+(?:[.,]\\d+)?)\\s*[x×]\\s*)?' + // Optional pack count prefix
  '(\\d+(?:[.,]\\d+)?)\\s*' +              // Number
  '(ml|cl|l|litre|litres|liter|liters|fl\\s?oz|floz|fl\\.oz|' + // Volume
  'g|kg|mg|gram|grams|kilogram|kilograms|milligram|milligrams|' + // Weight
  'mm|cm|m|millimetre|millimetre|centimetre|centimeter|metre|meter|' + // Length
  'count|pcs?|pieces?|tablets?|wipes?|sachets?|capsules?|' + // Count
  'sheets?|rolls?|bags?|boxes?|tubes?|bars?|packets?|pads?|strips?|fill|fills|pk|pack)',
  'i'
);

const PACK_PATTERN = /\b(?:pack\s*(?:of|:)?\s*|x\s*)?(\d{1,3})\s*(?:pk|pack|pcs?|pieces?|count|x)\b/i;

const MULTIPACK_PATTERN = /(\d+)\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*(ml|cl|l|g|kg|mg|cm|m|mm)/i;

function parseSize(sizeStr: string): [number | null, string | null, number | null] {
  if (!sizeStr) return [null, null, null];
  const s = sizeStr.trim();

  // Check for multipack format: "6x500ml" or "6 x 500ml"
  const multipack = MULTIPACK_PATTERN.exec(s);
  if (multipack) {
    const packCount = parseInt(multipack[1], 10);
    const value = parseFloat(multipack[2].replace(',', '.'));
    const unit = multipack[3].toLowerCase();
    const baseValue = value * (ALL_UNITS[unit] ?? 1);
    return [baseValue, unit, packCount];
  }

  // Standard size format
  const match = SIZE_PATTERN.exec(s);
  if (match) {
    const prefix = match[1]; // pack count prefix
    const value = parseFloat(match[2].replace(',', '.'));
    const unit = match[3].toLowerCase();
    const packCount = prefix ? parseInt(prefix, 10) : 1;
    const baseValue = value * (ALL_UNITS[unit] ?? 1);
    return [baseValue, unit, packCount];
  }

  // Try pack pattern separately
  const packMatch = PACK_PATTERN.exec(s);
  if (packMatch) {
    const packCount = parseInt(packMatch[1], 10);
    const match2 = SIZE_PATTERN.exec(s);
    if (match2) {
      const value = parseFloat(match2[2].replace(',', '.'));
      const unit = match2[3].toLowerCase();
      const baseValue = value * (ALL_UNITS[unit] ?? 1);
      return [baseValue, unit, packCount];
    }
  }

  return [null, null, null];
}

function parsePack(packStr: string): number | null {
  if (!packStr) return null;
  const match = PACK_PATTERN.exec(packStr);
  if (match) return parseInt(match[1], 10);
  const nums = packStr.match(/\b(\d{1,3})\b/);
  if (nums) return parseInt(nums[1], 10);
  return null;
}

function sizesMatch(supplierSize: string, amazonSize: string): boolean {
  const [supVal] = parseSize(supplierSize);
  const [amaVal] = parseSize(amazonSize);
  if (supVal === null || amaVal === null) return false;
  return Math.abs(supVal - amaVal) < 0.001;
}

function extractBrandFromTitle(title: string, brands: string[]): string {
  const titleLower = title.toLowerCase();
  for (const brand of brands) {
    if (titleLower.includes(brand.toLowerCase())) return brand;
  }
  return "";
}

// ============================================================
// SEARCH QUERY BUILDING
// ============================================================

function getSearchTitle(title: string): string {
  let cleaned = title.replace(/\s*\([^)]*\)\s*/g, ' ');
  cleaned = cleaned.replace(/[®™©]/g, '');
  return cleaned.replace(/\s+/g, ' ').trim();
}

function buildSearchQueries(product: SupplierProduct): Array<[string, string]> {
  const queries: Array<[string, string]> = [];
  const cleanTitle = getSearchTitle(product.title);
  const brand = product.brand.trim();
  const size = product.size.trim();
  const variant = product.variant.trim();
  const pack = product.pack.trim();

  const packCount = parsePack(pack);
  const packStr = packCount ? `Pack of ${packCount}` : "";

  // Priority 1: Brand + Title
  if (brand && cleanTitle) {
    queries.push([`${brand} ${cleanTitle}`, "brand-title"]);
    if (packStr) queries.push([`${brand} ${cleanTitle} ${packStr}`, "brand-title-pack"]);
  }

  // Priority 2: Brand + Title + Size
  if (brand && cleanTitle && size) {
    queries.push([`${brand} ${cleanTitle} ${size}`, "brand-title-size"]);
    if (packStr) queries.push([`${brand} ${cleanTitle} ${size} ${packStr}`, "brand-title-size-pack"]);
  }

  // Priority 3: Title original
  if (cleanTitle) {
    queries.push([cleanTitle, "title-original"]);
  }

  // Priority 4: Brand + Size
  if (brand && size) {
    queries.push([`${brand} ${size}`, "brand-size"]);
    if (packStr) queries.push([`${brand} ${size} ${packStr}`, "brand-size-pack"]);
  }

  // Priority 5: Brand + Variant
  if (brand && variant) {
    queries.push([`${brand} ${variant}`, "brand-variant"]);
  }

  // Priority 6: EAN
  if (product.ean && product.ean.length >= 8) {
    queries.push([product.ean, "ean"]);
  }

  // Priority 7: Size + Title
  if (size && cleanTitle) {
    queries.push([`${size} ${cleanTitle}`, "size-title"]);
    if (variant) queries.push([`${size} ${cleanTitle} ${variant}`, "size-title-variant"]);
  }

  // Priority 8: Brand only
  if (brand) {
    queries.push([brand, "brand-only"]);
  }

  // Priority 9: Title key terms
  if (cleanTitle) {
    const words = cleanTitle.split(' ');
    if (words.length > 3) {
      queries.push([words.slice(0, 5).join(' '), "title-key-terms"]);
    }
  }

  return queries.slice(0, MAX_SEARCH_QUERIES);
}

// ============================================================
// AMAZON SCRAPING
// ============================================================

let blockedUntil = 0;

async function fetchWithRetry(url: string): Promise<string | null> {
  const now = Date.now();
  if (now < blockedUntil) {
    await new Promise(r => setTimeout(r, blockedUntil - now));
  }

  for (let attempt = 0; attempt <= RETRY_500_MAX; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

      const response = await fetch(url, {
        headers: HEADERS,
        signal: controller.signal,
        redirect: 'follow',
      });

      clearTimeout(timeoutId);

      if (response.status === 200) {
        return await response.text();
      } else if (response.status === 500) {
        if (attempt < RETRY_500_MAX) {
          await new Promise(r => setTimeout(r, RETRY_500_BACKOFF[attempt]));
          continue;
        }
        return null;
      } else if ([403, 429, 503].includes(response.status)) {
        console.log(`Blocked (${response.status}), cooling down ${BLOCK_COOLDOWN}ms`);
        blockedUntil = Date.now() + BLOCK_COOLDOWN;
        return null;
      } else {
        console.log(`HTTP ${response.status}`);
        return null;
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        console.log('Timeout');
        if (attempt < RETRY_500_MAX) {
          await new Promise(r => setTimeout(r, RETRY_500_BACKOFF[attempt]));
          continue;
        }
        return null;
      }
      console.log(`Error: ${error}`);
      return null;
    }
  }
  return null;
}

function parseSearchResults(html: string): AmazonCandidate[] {
  const $ = load(html);
  const candidates: AmazonCandidate[] = [];

  // Try multiple selectors for robustness
  let productDivs = $('div[data-component-type="s-search-result"]');
  if (!productDivs.length) {
    productDivs = $('div.s-result-item[data-asin]');
  }

  productDivs.each((_, div) => {
    try {
      const $div = $(div);
      const asin = $div.attr('data-asin')?.trim() || '';
      if (!asin || asin.length !== 10) return;

      // Title
      const titleElem = $div.find('h2 a span, h2 span.a-text-normal, .a-text-normal').first();
      const title = titleElem.text().trim();
      if (!title) return;

      // Image
      const imgElem = $div.find('img.s-image').first();
      const imageUrl = imgElem.attr('src') || '';

      // Product URL
      const linkElem = $div.find('h2 a, a.a-link-normal[href*="/dp/"]').first();
      let productUrl = '';
      if (linkElem.attr('href')) {
        const href = linkElem.attr('href')!;
        productUrl = href.startsWith('/') ? `${AMAZON_UK_BASE}${href}` : href;
      }

      // Price
      const priceElem = $div.find('.a-price-whole, .a-offscreen').first();
      const price = priceElem.text().trim();

      // Seller
      const sellerElem = $div.find('[data-a-badge-color="sx-badge-assigned"]').first();
      const seller = sellerElem.text().trim();

      candidates.push({
        asin,
        title,
        imageUrl,
        productUrl,
        price,
        seller,
        tier: "low",
        reason: "",
        titleScore: 0,
        eanMatch: false,
        brandMatch: false,
        variantMatch: null,
        sizeMatch: false,
        packMatch: true,
        packMatchType: "unspecified",
        amazonPackCount: null,
        amazonPackBreakdown: "",
        amazonUnitPrice: "",
        supplierPackEquivalentPrice: "",
        visualVerdict: null,
        visualReason: "",
        imageMatchScore: null,
        titleWordCoverage: null,
        amazonTitle: "",
        amazonBrand: "",
        searchedBy: "",
      });
    } catch {
      // Skip malformed entries
    }
  });

  return candidates;
}

async function searchPage(query: string, page: number = 1): Promise<AmazonCandidate[]> {
  const params = new URLSearchParams({
    k: query,
    page: page.toString(),
    ref: `sr_pg_${page}`,
  });
  const url = `${SEARCH_URL}?${params.toString()}`;

  const html = await fetchWithRetry(url);
  if (!html) return [];

  return parseSearchResults(html);
}

async function searchAllPages(query: string): Promise<AmazonCandidate[]> {
  const allCandidates: AmazonCandidate[] = [];
  const seenAsins = new Set<string>();

  for (let page = 1; page <= MAX_PAGES; page++) {
    const candidates = await searchPage(query, page);
    if (!candidates.length) break;

    let newCount = 0;
    for (const c of candidates) {
      if (!seenAsins.has(c.asin)) {
        seenAsins.add(c.asin);
        allCandidates.push(c);
        newCount++;
      }
    }

    // Early exit if page has fewer results
    if (candidates.length < MIN_RESULTS_PER_PAGE) break;

    // Small delay between pages
    await new Promise(r => setTimeout(r, 1000));
  }

  return allCandidates;
}

// ============================================================
// MATCHING LOGIC
// ============================================================

const STOP_WORDS = new Set(['a', 'an', 'and', 'by', 'for', 'from', 'in', 'of', 'on', 'or', 'the', 'to', 'with', 'x']);
const GENERIC_WORDS = new Set([
  'bath', 'body', 'care', 'cleaner', 'cleaning', 'conditioner', 'cream',
  'deodorant', 'face', 'gel', 'hair', 'hand', 'home', 'liquid', 'lotion',
  'oil', 'pack', 'product', 'products', 'refill', 'set', 'shampoo',
  'soap', 'spray', 'wash', 'washing', 'wipes'
]);

function meaningfulWords(text: string): Set<string> {
  if (!text) return new Set();
  let normalized = text.toLowerCase();
  // Normalize measurements
  normalized = normalized.replace(/\b\d{1,3}\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*(ml|millilitres?)\b/gi, '$1ml');
  normalized = normalized.replace(/\b(\d+(?:[.,]\d+)?)\s*(ml|millilitres?)\s*[x×]\s*\d{1,3}\b/gi, '$1ml');
  normalized = normalized.replace(/\b(\d+(?:[.,]\d+)?)\s*(ml|millilitres?)\b/gi, '$1ml');
  const words = normalized.match(/[a-z0-9]+/g) || [];
  return new Set(words.filter(w => !STOP_WORDS.has(w) && !GENERIC_WORDS.has(w)));
}

function titleWordCoverage(source: string, candidate: string): number {
  const srcWords = meaningfulWords(source);
  if (!srcWords.size) return 0;
  const candWords = meaningfulWords(candidate);
  let matched = 0;
  const srcArray = Array.from(srcWords);
  for (const w of srcArray) if (candWords.has(w)) matched++;
  return matched / srcWords.size;
}

function classifyPackMatch(supplierPack: string, supplierSize: string, candidateTitle: string): [boolean, string] {
  const supPack = parsePack(supplierPack);
  if (supPack === null) return [true, "unspecified"];

  const packMatch = candidateTitle.match(/\b(\d{1,3})\s*(?:x|pack|pk|pcs?)\b/i);
  const amaPack = packMatch ? parseInt(packMatch[1], 10) : null;

  if (amaPack === null) {
    if (/single|each/i.test(candidateTitle)) return [true, "single-item-fallback"];
    return [true, "unspecified"];
  }

  if (amaPack === supPack) return [true, "exact"];
  return [true, "pack-count-difference-allowed"];
}

function classifyCandidate(
  product: SupplierProduct,
  candidate: AmazonCandidate,
  queryStage: string
): AmazonCandidate {
  // Build source title
  const sourceParts = [product.brand, product.title, product.variant, product.size].filter(Boolean);
  const sourceTitle = sourceParts.join(' ');

  // Title score
  candidate.titleScore = titleWordCoverage(sourceTitle, candidate.title);

  // EAN match
  candidate.eanMatch = Boolean(product.ean && (candidate.title.includes(product.ean) || candidate.asin.includes(product.ean)));

  // Brand match
  candidate.amazonBrand = extractBrandFromTitle(candidate.title, [product.brand]);
  candidate.amazonTitle = candidate.title;
  candidate.brandMatch = Boolean(product.brand && candidate.title.toLowerCase().includes(product.brand.toLowerCase()));

  // Variant match
  candidate.variantMatch = product.variant ? candidate.title.toLowerCase().includes(product.variant.toLowerCase()) : null;

  // Size match (HARD requirement)
  candidate.sizeMatch = sizesMatch(product.size, candidate.title);

  // Pack match (priority only)
  [candidate.packMatch, candidate.packMatchType] = classifyPackMatch(product.pack, product.size, candidate.title);

  // Determine tier
  if (candidate.eanMatch && candidate.brandMatch && candidate.sizeMatch && candidate.titleScore >= 0.9) {
    candidate.tier = "high";
    candidate.reason = "EAN match with strong brand, size, and title alignment";
  } else if (candidate.brandMatch && candidate.sizeMatch && candidate.titleScore >= 0.9) {
    candidate.tier = "medium";
    candidate.reason = `Brand and size match with ${Math.round(candidate.titleScore * 100)}% title coverage`;
  } else if (candidate.brandMatch && candidate.sizeMatch) {
    candidate.tier = "medium";
    candidate.reason = "Brand and size match (title coverage below 90%)";
  } else if (candidate.eanMatch) {
    candidate.tier = "medium";
    candidate.reason = "EAN match found";
  } else if (candidate.sizeMatch && candidate.titleScore >= 0.7) {
    candidate.tier = "low";
    candidate.reason = "Size match but brand unclear";
  } else {
    candidate.tier = "low";
    candidate.reason = "Insufficient match criteria";
  }

  // Size mismatch = always low
  if (!candidate.sizeMatch) {
    candidate.tier = "low";
    candidate.reason = `Size mismatch: supplier=${product.size}, amazon=${candidate.title}`;
  }

  // Brand mismatch = always low
  if (!candidate.brandMatch) {
    candidate.tier = "low";
    candidate.reason = `Brand mismatch: supplier=${product.brand}, amazon=${candidate.amazonBrand || 'unknown'}`;
  }

  candidate.searchedBy = queryStage;
  return candidate;
}

function candidateSortKey(c: AmazonCandidate): number[] {
  return [
    -Number(c.sizeMatch),
    -Number(c.brandMatch),
    -Number(c.variantMatch ?? true),
    -Number(c.eanMatch),
    -Math.round(c.titleScore * 1000),
    -Number(c.packMatchType === "exact"),
    -Number(c.packMatchType === "pack-count-difference-allowed"),
    -Number(c.packMatchType === "single-item-fallback"),
  ];
}

function compareCandidates(a: AmazonCandidate, b: AmazonCandidate): number {
  const ka = candidateSortKey(a);
  const kb = candidateSortKey(b);
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return kb[i] - ka[i];
  }
  return 0;
}

async function matchProduct(product: SupplierProduct): Promise<MatchResult> {
  const queries = buildSearchQueries(product);
  const allCandidates: AmazonCandidate[] = [];
  const searchedQueries: Array<{ stage: string; query: string }> = [];
  const seenAsins = new Set<string>();

  console.log(`Matching: ${product.brand} - ${product.title.slice(0, 50)}... (Size: ${product.size}, Pack: ${product.pack})`);

  for (const [query, stage] of queries) {
    console.log(`  Searching: ${stage} - '${query.slice(0, 60)}...'`);
    searchedQueries.push({ stage, query });

    const candidates = await searchAllPages(query);

    for (const c of candidates) {
      if (!seenAsins.has(c.asin)) {
        seenAsins.add(c.asin);
        const classified = classifyCandidate(product, c, stage);
        allCandidates.push(classified);
      }
    }

    // Early exit if we found good matches
    const highMedium = allCandidates.filter(c => c.tier === 'high' || c.tier === 'medium');
    if (highMedium.length >= 3) {
      console.log(`  Found ${highMedium.length} good matches, stopping early`);
      break;
    }
  }

  // Sort candidates
  allCandidates.sort(compareCandidates);

  const best = allCandidates[0] || null;

  let status: MatchResult["status"] = "not-found";
  let message = "No Amazon UK listings found";

  if (best) {
    if (best.tier === "high") {
      status = "high";
      message = `High confidence match: ${best.reason}`;
    } else if (best.tier === "medium") {
      status = "medium";
      message = `Medium confidence match: ${best.reason}`;
    } else {
      status = "low";
      message = `Low confidence match: ${best.reason}`;
    }
  }

  return {
    supplier: product,
    status,
    message,
    bestCandidate: best,
    candidates: allCandidates,
    scannedCandidateCount: allCandidates.length,
    searchedQueries,
  };
}

// ============================================================
// CSV PARSING
// ============================================================

function parseCSV(csvText: string): SupplierProduct[] {
  const lines = csvText.trim().split('\n');
  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map(h => h.replace(/"/g, '').trim());
  const products: SupplierProduct[] = [];

  // Find column indices
  const titleIdx = headers.findIndex(h => h.toLowerCase() === 'title');
  const eanIdx = headers.findIndex(h => h.toLowerCase() === 'ean');
  const sizeIdx = headers.findIndex(h => h.toLowerCase() === 'size');
  const packIdx = headers.findIndex(h => h.toLowerCase() === 'pack');
  const imageIdx = headers.findIndex(h => h.toLowerCase().includes('image'));

  for (let i = 1; i < lines.length; i++) {
    const row = lines[i].split(',').map(c => c.replace(/"/g, '').trim());
    if (row.length < headers.length) continue;

    const title = row[titleIdx] || '';
    const ean = (row[eanIdx] || '').replace(/\D/g, '');
    const size = row[sizeIdx] || '';
    const pack = row[packIdx] || '';
    const imageUrl = imageIdx >= 0 ? row[imageIdx] || '' : '';

    // Clean EAN
    const cleanEan = ean.length >= 8 ? ean : '';

    // Extract brand
    let brand = "";
    let variant = "";
    const titleUpper = title.toUpperCase();
    for (const b of KNOWN_BRANDS) {
      if (titleUpper.includes(b)) {
        brand = b;
        variant = titleUpper.replace(b, '').trim(); // replace first occurrence only
        variant = variant.replace(/^[-:\s]+/, '').replace(/\s+/, ' ');
        break;
      }
    }
    if (!brand) {
      const words = title.split(' ');
      brand = words[0] || '';
      variant = words.slice(1).join(' ') || '';
    }

    // Clean variant
    if (variant) {
      variant = variant.replace(/\b\d+(?:[.,]\d+)?\s*(?:ml|cl|l|g|kg|mg|cm|m|mm|count|pcs|pieces|tablets|wipes|sachets|capsules|sheets|rolls|bags|boxes|tubes|bars|packets|pads|strips|fill|fills|pk|pack|x)\b/gi, '');
      variant = variant.replace(/\s*[x×]\s*\d+/g, '');
      variant = variant.replace(/\s+/g, ' ').trim().replace(/^[-:]+|[-:]+$/g, '');
    }

    products.push({
      ean: cleanEan,
      title,
      brand,
      variant,
      size,
      pack,
      imageUrl: imageUrl && imageUrl !== 'nan' ? imageUrl : '',
      rowNumber: i,
      no: String(i),
    });
  }

  return products;
}

// ============================================================
// CSV EXPORT
// ============================================================

function generateCSV(results: MatchResult[]): string {
  const headers = [
    'Row', 'No', 'EAN', 'Brand', 'Title', 'Variant', 'Size', 'Pack',
    'Match Status', 'Match Message', 'Best ASIN', 'Best Title', 'Best Tier',
    'Best Price', 'Best URL', 'Best Reason', 'Brand Match', 'Size Match',
    'Pack Match Type', 'EAN Match', 'Title Score', 'Candidates Found',
    'Top 5 Candidates', 'Queries Run'
  ];

  const rows = [headers.join(',')];

  for (const r of results) {
    const s = r.supplier;
    const b = r.bestCandidate;

    const bestAsin = b?.asin || '';
    const bestTitle = b?.title?.replace(/"/g, '""') || '';
    const bestTier = b?.tier || '';
    const bestPrice = b?.price || '';
    const bestUrl = b?.productUrl || '';
    const bestReason = b?.reason?.replace(/"/g, '""') || '';
    const bestBrandMatch = b?.brandMatch ? 'Yes' : 'No';
    const bestSizeMatch = b?.sizeMatch ? 'Yes' : 'No';
    const bestPackMatch = b?.packMatchType || '';
    const bestEanMatch = b?.eanMatch ? 'Yes' : 'No';
    const bestTitleScore = b ? `${(b.titleScore * 100).toFixed(1)}%` : '';

    const candidateSummary = (r.candidates.slice(0, 5)
      .map(c => `${c.asin}:${c.tier}:${c.title.slice(0, 50).replace(/"/g, '""')}`)
      .join('; '));

    const row = [
      s.rowNumber,
      s.no,
      s.ean,
      s.brand,
      `"${s.title.replace(/"/g, '""')}"`,
      s.variant,
      s.size,
      s.pack,
      r.status,
      `"${r.message.replace(/"/g, '""')}"`,
      bestAsin,
      `"${bestTitle}"`,
      bestTier,
      bestPrice,
      bestUrl,
      `"${bestReason}"`,
      bestBrandMatch,
      bestSizeMatch,
      bestPackMatch,
      bestEanMatch,
      bestTitleScore,
      r.candidates.length,
      `"${candidateSummary}"`,
      r.searchedQueries.length,
    ];

    rows.push(row.join(','));
  }

  return rows.join('\n');
}

// ============================================================
// API HANDLER
// ============================================================

export async function POST(request: Request) {
  try {
    const contentType = request.headers.get('content-type') || '';

    let products: SupplierProduct[];

    if (contentType.includes('multipart/form-data')) {
      // File upload
      const formData = await request.formData();
      const file = formData.get('file') as File;
      if (!file) {
        return Response.json({ error: 'No file provided' }, { status: 400 });
      }
      const csvText = await file.text();
      products = parseCSV(csvText);
    } else if (contentType.includes('application/json')) {
      // JSON payload with products array
      const body = await request.json();
      if (body.products && Array.isArray(body.products)) {
        products = body.products.map((p: any, i: number) => ({
          ean: String(p.ean || '').replace(/\D/g, ''),
          title: String(p.title || ''),
          brand: String(p.brand || ''),
          variant: String(p.variant || ''),
          size: String(p.size || ''),
          pack: String(p.pack || ''),
          imageUrl: String(p.imageUrl || ''),
          rowNumber: i + 1,
          no: String(i + 1),
        }));
      } else {
        return Response.json({ error: 'Invalid JSON format. Provide { products: [...] }' }, { status: 400 });
      }
    } else {
      return Response.json({ error: 'Content-Type must be multipart/form-data or application/json' }, { status: 400 });
    }

    if (!products.length) {
      return Response.json({ error: 'No valid products found' }, { status: 400 });
    }

    console.log(`Loaded ${products.length} products`);

    // Match each product
    const results: MatchResult[] = [];

    for (let i = 0; i < products.length; i++) {
      const product = products[i];
      try {
        const result = await matchProduct(product);
        results.push(result);

        if (result.bestCandidate) {
          const b = result.bestCandidate;
          console.log(`  BEST: [${b.tier.toUpperCase()}] ${b.asin} - ${b.title.slice(0, 60)}`);
        } else {
          console.log('  NO MATCHES FOUND');
        }
      } catch (error) {
        console.error(`Error matching product ${product.title}:`, error);
        results.push({
          supplier: product,
          status: "error",
          message: error instanceof Error ? error.message : 'Unknown error',
          bestCandidate: null,
          candidates: [],
          scannedCandidateCount: 0,
          searchedQueries: [],
        });
      }

      // Rate limiting between products
      if (i < products.length - 1) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    // Generate CSV
    const csv = generateCSV(results);

    // Return both JSON and CSV
    return Response.json({
      success: true,
      totalProducts: products.length,
      summary: {
        high: results.filter(r => r.status === 'high').length,
        medium: results.filter(r => r.status === 'medium').length,
        low: results.filter(r => r.status === 'low').length,
        notFound: results.filter(r => r.status === 'not-found').length,
        error: results.filter(r => r.status === 'error').length,
      },
      results: results.map(r => ({
        row: r.supplier.rowNumber,
        ean: r.supplier.ean,
        brand: r.supplier.brand,
        title: r.supplier.title,
        size: r.supplier.size,
        pack: r.supplier.pack,
        status: r.status,
        message: r.message,
        bestCandidate: r.bestCandidate ? {
          asin: r.bestCandidate.asin,
          title: r.bestCandidate.title,
          tier: r.bestCandidate.tier,
          price: r.bestCandidate.price,
          productUrl: r.bestCandidate.productUrl,
          brandMatch: r.bestCandidate.brandMatch,
          sizeMatch: r.bestCandidate.sizeMatch,
          packMatchType: r.bestCandidate.packMatchType,
          eanMatch: r.bestCandidate.eanMatch,
          titleScore: r.bestCandidate.titleScore,
        } : null,
        candidatesFound: r.candidates.length,
      })),
      csv,
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      }
    });

  } catch (error) {
    console.error('API Error:', error);
    return Response.json({
      error: error instanceof Error ? error.message : 'Internal server error'
    }, { status: 500 });
  }
}