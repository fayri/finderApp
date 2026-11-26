# finderApp

Reads EANs from a supplier sheet, searches the supplier website in a real browser (Playwright/Chromium),
matches each EAN to its product page and exports **every product image URL** to CSV + Excel.

## Setup
```bash
pip install -r requirements.txt
python -m playwright install chromium
cp config.example.yaml config.yaml   # then edit selectors for your supplier site
```

## Run
```bash
python finder.py --input supplier.xlsx --ean-column EAN --config config.yaml --output output/ --limit 5
```
Regal example: `cp config.regal.yaml config.yaml`, then `python finder.py --input supplier.xlsx --ean-column EAN --limit 1 --debug --headed`.

Outputs in `output/`:
- `products.csv` – one row per EAN: `ean, title, image (main), pack, size, product_url, status`
  (title from the website, falling back to the sheet's Description; pack/size from the sheet's Pack/Size columns)
- `images.csv` – one row per image (`ean, product_url, image_no, image_url`)
- `summary.csv` – one row per EAN (status, product URL, image_count, image_1..n)
- `images.xlsx` – sheets `Products`, `Images`, `Summary`

Status values: `matched`, `not_found`, `ean_not_on_page`, `no_images`, `error: ...`.

If the site needs a login, set `login.enabled: true` and export `SUPPLIER_USER` / `SUPPLIER_PASS`.

## Test
```bash
python -m pytest -q tests
```
