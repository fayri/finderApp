#!/usr/bin/env python3
"""finderApp - match supplier-sheet EANs to products on the supplier website
and list every product image.

Usage:
    python finder.py --input supplier.xlsx --ean-column EAN --config config.yaml --output out/
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path
from urllib.parse import urljoin, urlparse

import pandas as pd
import yaml
from playwright.sync_api import Page, TimeoutError as PWTimeout, sync_playwright


# ----------------------------------------------------------------- input ---
def _find_col(df, wanted: str | None, pattern: str | None = None):
    if wanted:
        low = {str(c).strip().lower(): c for c in df.columns}
        if wanted.strip().lower() in low:
            return low[wanted.strip().lower()]
        raise SystemExit(f"Column '{wanted}' not found. Columns: {list(df.columns)}")
    if pattern:
        return next((c for c in df.columns if re.search(pattern, str(c), re.I)), None)
    return None


def load_items(path: str, column: str | None, sheet=0, input_cols: dict | None = None) -> list[dict]:
    """Read supplier sheet -> [{ean, sheet_title, pack, size}], unique by EAN (first row wins).
    Keeps leading zeros, strips '.0' float artefacts."""
    p = Path(path)
    if p.suffix.lower() in (".csv", ".tsv"):
        df = pd.read_csv(p, dtype=str, sep="\t" if p.suffix.lower() == ".tsv" else None, engine="python")
    else:
        df = pd.read_excel(p, dtype=str, sheet_name=sheet)
    ic = input_cols or {}
    ean_c = _find_col(df, column, r"\b(ean|gtin|barcode)\b")
    if ean_c is None or str(ean_c).strip().lower() == "case barcode":
        raise SystemExit(f"Could not auto-detect EAN column, use --ean-column. Columns: {list(df.columns)}")
    title_c = _find_col(df, ic.get("title", "Description"))if ic.get("title", "Description") in df.columns else None
    pack_c = _find_col(df, ic.get("pack", "Pack")) if ic.get("pack", "Pack") in df.columns else None
    size_c = _find_col(df, ic.get("size", "Size")) if ic.get("size", "Size") in df.columns else None
    clean = lambda v: "" if pd.isna(v) else re.sub(r"\.0+$", "", str(v).strip())
    out, seen = [], set()
    for _, row in df.iterrows():
        e = re.sub(r"\D", "", clean(row[ean_c]))
        if not e or e in seen:
            continue
        seen.add(e)
        out.append({"ean": e,
                    "sheet_title": clean(row[title_c]) if title_c else "",
                    "pack": clean(row[pack_c]) if pack_c else "",
                    "size": clean(row[size_c]) if size_c else ""})
    return out


# ------------------------------------------------------------- scraping ---
def _largest_from_srcset(srcset: str) -> str | None:
    best, best_w = None, -1
    for part in srcset.split(","):
        bits = part.strip().split()
        if not bits:
            continue
        w = 0
        if len(bits) > 1:
            m = re.match(r"(\d+(?:\.\d+)?)[wx]", bits[1])
            w = float(m.group(1)) if m else 0
        if w >= best_w:
            best, best_w = bits[0], w
    return best


def _json_ld_images(page: Page) -> list[str]:
    urls: list[str] = []
    for raw in page.eval_on_selector_all(
        "script[type='application/ld+json']", "els => els.map(e => e.textContent)"
    ):
        try:
            data = json.loads(raw)
        except Exception:
            continue
        stack = data if isinstance(data, list) else [data]
        while stack:
            node = stack.pop()
            if isinstance(node, list):
                stack.extend(node)
            elif isinstance(node, dict):
                img = node.get("image")
                if isinstance(img, str):
                    urls.append(img)
                elif isinstance(img, list):
                    urls += [i if isinstance(i, str) else i.get("url", "") for i in img]
                elif isinstance(img, dict):
                    urls.append(img.get("url", ""))
                stack.extend(v for v in node.values() if isinstance(v, (dict, list)))
    return [u for u in urls if u]


def extract_images(page: Page, cfg: dict) -> list[str]:
    icfg = cfg["images"]
    attrs = icfg.get("attributes", ["src"])
    found: list[str] = []

    for sel in icfg.get("selectors", ["img"]):
        for el in page.query_selector_all(sel):
            if icfg.get("include_srcset", True):
                ss = el.get_attribute("srcset") or el.get_attribute("data-srcset")
                if ss and (best := _largest_from_srcset(ss)):
                    found.append(best)
            for a in attrs:
                v = el.get_attribute(a)
                if v and not v.startswith("data:"):
                    found.append(v)
                    break
    if icfg.get("include_json_ld", True):
        found += _json_ld_images(page)

    excl = [re.compile(p, re.I) for p in icfg.get("exclude_patterns", [])]
    rewrites = [(re.compile(r["pattern"]), r["replacement"]) for r in icfg.get("url_rewrites", [])]
    out, seen = [], set()
    for u in found:
        u = urljoin(page.url, u.strip())
        for pat, rep in rewrites:
            u = pat.sub(rep, u)
        if not u.startswith("http") or any(x.search(u) for x in excl):
            continue
        key = u.split("#")[0]
        if key not in seen:
            seen.add(key)
            out.append(key)
    return out


def _first_text(page: Page, selectors: list[str]) -> str:
    for sel in selectors or []:
        try:
            el = page.query_selector(sel)
        except Exception:
            continue
        if el:
            t = (el.get_attribute("content") if el.evaluate("e => e.tagName") == "META" else el.inner_text()) or ""
            t = re.sub(r"\s+", " ", t).strip()
            if t:
                return t
    return ""


PACK_RE = re.compile(r"(\b\d+\s*(?:x|pk|pack|pcs|ct)\b|\bpack of \d+\b|\b\d+\s*x\s*\d+)", re.I)
SIZE_RE = re.compile(r"(\b\d+(?:[.,]\d+)?\s*(?:ml|cl|ltr|l|g|kg|oz|sheets?|m|cm|mm)\b)", re.I)


def extract_fields(page: Page, cfg: dict) -> dict:
    """title / pack / size: CSS selectors first, then regex on the title as fallback."""
    f = cfg.get("fields", {})
    title = _first_text(page, f.get("title", ["h1", "meta[property='og:title']"]))
    pack = _first_text(page, f.get("pack", []))
    size = _first_text(page, f.get("size", []))
    if not pack and (m := PACK_RE.search(title)):
        pack = m.group(1).strip()
    if not size and (m := SIZE_RE.search(title)):
        size = m.group(1).strip()
    return {"title": title, "pack": pack, "size": size}


def login(page: Page, site: dict, timeout: int) -> None:
    lg = site.get("login") or {}
    if not lg.get("enabled"):
        return
    user, pw = os.environ.get("SUPPLIER_USER"), os.environ.get("SUPPLIER_PASS")
    if not user or not pw:
        raise SystemExit("Login enabled but SUPPLIER_USER / SUPPLIER_PASS env vars are not set.")
    page.goto(lg["url"], timeout=timeout)
    page.fill(lg["user_selector"], user)
    page.fill(lg["pass_selector"], pw)
    page.click(lg["submit_selector"])
    page.wait_for_load_state("networkidle", timeout=timeout)


def _dump(page: Page, debug_dir: Path | None, name: str) -> None:
    if debug_dir:
        debug_dir.mkdir(parents=True, exist_ok=True)
        (debug_dir / f"{name}.html").write_text(page.content(), encoding="utf-8")
        page.screenshot(path=str(debug_dir / f"{name}.png"), full_page=True)


def _title(page: Page, site: dict) -> str:
    for sel in [site.get("title_selector") or "h1", "meta[property='og:title']"]:
        el = page.query_selector(sel)
        if el:
            t = el.get_attribute("content") if sel.startswith("meta") else el.inner_text()
            if t and t.strip():
                return re.sub(r"\s+", " ", t).strip()
    return ""


def find_product(page: Page, ean: str, cfg: dict, debug_dir: Path | None = None) -> dict:
    """Return dict(status, product_url, title, images)."""
    site, timeout = cfg["site"], cfg["run"].get("timeout_ms", 20000)
    empty = {"product_url": "", "title": "", "images": []}
    page.goto(site["search_url"].format(ean=ean), timeout=timeout, wait_until="domcontentloaded")
    if sel := site.get("cookie_accept_selector"):
        try:
            page.click(sel, timeout=1500)
        except PWTimeout:
            pass
    page.wait_for_load_state("networkidle", timeout=timeout)

    link_sel, nf = site.get("result_link_selector"), site.get("not_found_text")
    if link_sel:
        # JS shops (e.g. Sana Commerce) render results late: wait for a hit OR the 'not found' text
        try:
            page.wait_for_function(
                "([s, t, p]) => document.querySelector(s) || location.pathname !== p || "
                "(t && document.body.innerText.toLowerCase().includes(t.toLowerCase()))",
                arg=[link_sel, nf or "", urlparse(site["search_url"]).path], timeout=timeout)
        except PWTimeout:
            pass
        _dump(page, debug_dir, f"{ean}_search")
        links = page.query_selector_all(link_sel)
        if links:
            href = links[0].get_attribute("href")
            page.goto(urljoin(page.url, href), timeout=timeout, wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle", timeout=timeout)
        elif nf and nf.lower() in page.inner_text("body").lower():
            return {"status": "not_found", **empty}

    if sel := site.get("product_ready_selector"):
        try:
            page.wait_for_selector(sel, timeout=timeout)
        except PWTimeout:
            pass
    _dump(page, debug_dir, f"{ean}_product")
    images, title = extract_images(page, cfg), _title(page, site)
    if cfg.get("matching", {}).get("verify_ean_on_page", True) and ean not in page.content():
        return {"status": "ean_not_on_page", "product_url": page.url, "title": title, "images": images}
    if not images:
        return {"status": "no_images", "product_url": page.url, "title": title, "images": []}
    return {"status": "matched", "product_url": page.url, "title": title, "images": images}


# ---------------------------------------------------------------- output ---
def write_outputs(rows: list[dict], outdir: Path) -> None:
    outdir.mkdir(parents=True, exist_ok=True)
    long_rows, summary = [], []
    for r in rows:
        title = r["title"] or r["sheet_title"]          # website title, else sheet description
        base = {"ean": r["ean"], "title": title, "pack": r["pack"], "size": r["size"]}
        for url in r["images"]:
            long_rows.append({"ean": base["ean"], "title": title, "image": url,
                              "pack": base["pack"], "size": base["size"],
                              "product_url": r["product_url"], "status": r["status"]})
        summary.append({**base, "status": r["status"], "product_url": r["product_url"],
                        "image_count": len(r["images"]),
                        **{f"image_{i}": u for i, u in enumerate(r["images"], 1)}})
    cols = ["ean", "title", "image", "pack", "size", "product_url", "status"]
    long_df, sum_df = pd.DataFrame(long_rows, columns=cols), pd.DataFrame(summary)
    # one row per EAN with the main (first) image - the sheet you asked for
    prod_df = pd.DataFrame([{"ean": r["ean"], "title": r["title"] or r["sheet_title"],
                             "image": r["images"][0] if r["images"] else "", "pack": r["pack"],
                             "size": r["size"], "product_url": r["product_url"], "status": r["status"]}
                            for r in rows], columns=cols)
    prod_df.to_csv(outdir / "products.csv", index=False)
    long_df.to_csv(outdir / "images.csv", index=False)
    sum_df.to_csv(outdir / "summary.csv", index=False)
    with pd.ExcelWriter(outdir / "images.xlsx", engine="openpyxl") as xw:
        prod_df.to_excel(xw, sheet_name="Products", index=False)
        long_df.to_excel(xw, sheet_name="Images", index=False)
        sum_df.to_excel(xw, sheet_name="Summary", index=False)
        for ws in xw.book.worksheets:
            ws.freeze_panes = "A2"
            for col in ws.columns:
                ws.column_dimensions[col[0].column_letter].width = min(
                    60, max(len(str(c.value or "")) for c in col[:50]) + 2)


# ------------------------------------------------------------------ main ---
def run(input_path, ean_column, config_path, outdir, sheet=0, limit=None, debug=False, headed=False) -> list[dict]:
    cfg = yaml.safe_load(Path(config_path).read_text())
    items = load_items(input_path, ean_column, sheet, cfg.get("input_columns"))[:limit]
    print(f"{len(items)} unique EANs loaded")
    debug_dir = Path(outdir) / "debug" if debug else None
    rows: list[dict] = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=cfg["run"].get("headless", True) and not headed)
        ctx = browser.new_context(user_agent="Mozilla/5.0 (X11; Linux x86_64) finderApp/1.0")
        page = ctx.new_page()
        page.set_default_timeout(cfg["run"].get("timeout_ms", 20000))
        login(page, cfg["site"], cfg["run"].get("timeout_ms", 20000))
        for n, item in enumerate(items, 1):
            res = {"status": "error", "product_url": "", "title": "", "images": []}
            for attempt in range(cfg["run"].get("retries", 2) + 1):
                try:
                    res = find_product(page, item["ean"], cfg, debug_dir)
                    break
                except Exception as exc:  # network / timeout
                    res = {"status": f"error: {type(exc).__name__}", "product_url": "", "title": "", "images": []}
                    time.sleep(1.5 * (attempt + 1))
            rows.append({**item, **res})
            print(f"[{n}/{len(items)}] {item['ean']} -> {res['status']} ({len(res['images'])} images)")
            write_outputs(rows, Path(outdir))  # incremental save so a crash loses nothing
            time.sleep(cfg["run"].get("delay_seconds", 1.0))
        browser.close()
    return rows


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--input", required=True, help="supplier sheet (.xlsx/.xls/.csv)")
    ap.add_argument("--ean-column", help="EAN column name (auto-detected if omitted)")
    ap.add_argument("--sheet", default=0, help="sheet name/index for Excel (default first)")
    ap.add_argument("--config", default="config.yaml")
    ap.add_argument("--output", default="output")
    ap.add_argument("--limit", type=int, help="only process first N EANs (for testing)")
    ap.add_argument("--debug", action="store_true", help="save HTML + screenshot of each page to output/debug")
    ap.add_argument("--headed", action="store_true", help="show the browser window")
    a = ap.parse_args(argv)
    sheet = int(a.sheet) if str(a.sheet).isdigit() else a.sheet
    run(a.input, a.ean_column, a.config, a.output, sheet, a.limit, a.debug, a.headed)


if __name__ == "__main__":
    sys.exit(main())
