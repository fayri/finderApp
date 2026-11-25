# FinderApp recovery and change record

Last updated: 2026-11-25

This file is the project’s human-readable recovery guide and decision summary. The GitHub repository and its commits are the authoritative source for the exact code and file-by-file diffs. This is not a verbatim transcript; the original discussion remains in the v0 chat.

## Restore the code

- Repository: https://github.com/fayri/finderapp
- Restore the source from the GitHub repository or reconnect it through the v0 project’s GitHub settings. Current changes are on `v0/full-page-amazon-matches`; `main` is the default branch and should not be overwritten with unfinished work.
- Vercel project settings hold runtime environment values. Never store credentials, API keys, supplier logins, or secret values in Git or this file.
- Git preserves committed code and its history. This document preserves the product requirements and key decisions that help explain the code.

## What the app does

FinderApp reads supplier spreadsheets, retrieves supplier products and images, and compares them with Amazon UK listings. The current web workflow is a Next.js frontend plus a FastAPI matcher service.

- `src/app/amazon/page.tsx` and `src/components/amazon-workbench.tsx` — spreadsheet upload, column mapping, search queue, and exports.
- `src/components/amazon-single-item-test.tsx` — one-product search form for quick checks.
- `src/components/amazon-match-card.tsx` — supplier reference, Amazon candidate grid, detail panels, and reviewer actions.
- `src/lib/amazon-visual-matching.ts` and `src/app/api/amazon/visual-match/route.ts` — independent visual and title evidence, with visual evidence required for an automatic confirmation.
- `backend/main.py` — supplier image lookup, Amazon UK result parsing, title/brand/variant/size/pack checks, seller/price extraction, and result ranking.
- `backend/product_category_terms.json` — local category terms used to broaden search queries.
- `backend/test_matcher.py` and `src/lib/amazon-visual-matching.test.mjs` — focused matcher tests.
- `src/app/globals.css` — responsive styles for the site and result grid.
- `finder.py` — legacy spreadsheet scraping utility, separate from the current Next.js Amazon workflow.
- `README.md` still documents the original EAN utility; the web workflow is the active app described above.

## Requirements and discussion decisions

- Use the supplier EAN, title, brand, variant, size, pack, and product image as separate matching evidence. An EAN or title alone must not overrule a visual conflict.
- Keep low-confidence results available for manual review, with listing title, seller, price, ASIN, and actions to open/read/select a listing when available.
- Search every product listing returned on each Amazon results page actually searched; do not stop after collecting five. Evaluate all collected candidates before showing the five strongest options.
- Rank visual matches first, then use title, size, brand, variant, pack, and EAN evidence to order/review them. A one-item Amazon listing remains eligible against a supplier multipack; show its estimated per-item price and the estimated equivalent at the supplier pack quantity.
- The normalized price is calculated from the Amazon listing price and pack count parsed from its title. A pack count is assumed to be one when no multiplier is stated. The app does not currently receive a supplier buy price, so the pack-equivalent figure is a like-for-like reference, not a profit-margin or wholesale-cost calculation.
- If an Amazon card has a title but no usable image, retain it for text/attribute review and mark its visual evidence unavailable.
- Keep Amazon requests at least three seconds apart and stop on CAPTCHA/rate-limit responses rather than retrying aggressively.
- No external database or new integration was selected for this workflow; do not introduce one without a new request.
- Image reference notes: the Amazon screenshot shows NIVEA MEN Sensitive Shower Gel in 4 × 250 ml and 2 × 250 ml offers. The app screenshot shows a supplier 250 ml, pack-of-6 product and five candidates, including single-item and multipack listings; the previous five-option cap could hide better matches.

## Current revision (2026-11-25)

- Removed the early extraction and result-count cutoffs. The matcher parses every titled Amazon result card on a searched page, including cards without image URLs, and keeps collecting fallback query pages until a page has a plausible title/brand/size result or the bounded query list is exhausted.
- Return all unique collected candidates with a scanned count. Run visual checks in batches of five, then rank by visual verdict/score before title and product attributes; return the top five for review.
- A pack-count difference no longer removes a strong visual/title candidate. Amazon pack count, estimated Amazon price per item, and estimated supplier-pack-equivalent price are available in the detail panel.
- Replaced the tall candidate cards with a compact responsive grid. Hover, keyboard focus, or the details button opens the full listing panel in the grid flow; it contains the existing scores, attributes, seller, price, ASIN, page-details action, open link, and manual selection action. The component also pins the panel to normal document flow so it cannot escape or be clipped by the outer card.
- Added live scanned-count display to both spreadsheet and single-item flows.
- Changed files: `PROJECT_RECOVERY.md`, `backend/main.py`, `backend/test_matcher.py`, `src/app/globals.css`, `src/components/amazon-match-card.tsx`, `src/components/amazon-single-item-test.tsx`, `src/components/amazon-workbench.tsx`, `src/lib/amazon-types.ts`, `src/lib/amazon-visual-matching.ts`, and `src/lib/amazon-visual-matching.test.mjs`.
- Validation: Python matcher tests, visual-matching tests, ESLint, TypeScript check, and browser interaction checks. The title-only browser smoke test returned 48 scanned listings and displayed the top five, including 250 ml single-item and multipack candidates. No supplier image was entered for that smoke test, so visual evidence correctly remained unavailable; it does not claim a confirmed image match.

## Existing Git history

The repository history contains the exact changes; this list is a quick index from the original app through the last merged revision:

- `eaaddf8` — Create README.md.
- `029d7e9` — Add files via upload.
- `9a6fa00` — Build Regal Sales EAN lookup app.
- `3885f0c` — Use spreadsheet pack and size values.
- `71446f9` — Use workbook product descriptions.
- `c6660bf` — Extract Regal images from noscript markup.
- `1e19eb7` — Add Amazon product matching workbench.
- `70c259b` — Ignore Python bytecode.
- `03ccf4b` — Add Regal and Amazon navigation menu.
- `5020f0d` — Add single-item Amazon image search.
- `69bf9cf` — Add retry for lookup errors.
- `686c434` — Add safer categorized Amazon matching.
- `2769174` — Show selectable Amazon alternatives.
- `36afcf5` — Show active build version in the header.
- `50fe89e` — Keep matching available when categories fail.
- `9f76609` — Merge pull request #1 from fayri/v0/amazon-matching-workbench.
- `405ae95` — Make category lookup local and non-blocking.
- `4f1dcf6` — Merge pull request #3 from fayri/v0/local-category-classification.
- `b06f1fa` — Fix Amazon UK matcher lookup and fallbacks.
- `3699de0` — Merge pull request #4 from fayri/v0/fix-amazon-match-route.
- `f5fbcf5` — Bundle matcher data with Python service.
- `4d014d1` — Merge pull request #5 from fayri/v0/fix-amazon-category-service-bundle.
- `592e622` — Improve Amazon product match verification.
- `cec0eaa` — Merge pull request #6 from fayri/v0/intelligent-product-visual-matching.
- `3ec4c6c` — Keep low-similarity Amazon options for review.
- `8ee3d47` — Merge pull request #7 from fayri/v0/show-low-similarity-options.
- `c6b4a8a` — Add image-label-aware Amazon searches.
- `63af71a` — Merge pull request #8 from fayri/v0/label-aware-amazon-search.
- `16a8dca` — Add separate Amazon match scores and offer details.
- `f083a80` — Merge pull request #9 from fayri/v0/separate-match-scores-seller-price.
- `b9510b8` — Require strong visual evidence for product matches.
- `b366f4a` — Merge pull request #10 from fayri/v0/require-title-and-visual-match.
- `1a77956` — Improve supplier and Amazon comparison.
- `3a78fbd` — Merge pull request #11 from fayri/v0/improve-product-comparison.
