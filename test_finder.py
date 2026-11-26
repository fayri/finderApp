import sys
from pathlib import Path

import pandas as pd
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import finder  # noqa: E402
import mock_site  # noqa: E402


def test_end_to_end(tmp_path):
    srv = mock_site.start()
    base = f"http://127.0.0.1:{srv.server_port}"
    cfg = yaml.safe_load((Path(__file__).resolve().parents[1] / "config.example.yaml").read_text())
    cfg["site"].update(base_url=base, search_url=base + "/search?q={ean}", cookie_accept_selector=None)
    cfg["run"].update(delay_seconds=0, retries=0)
    cfg["images"]["selectors"] = ["div.gallery img", "meta[property='og:image']"]
    (tmp_path / "config.yaml").write_text(yaml.safe_dump(cfg))

    # EANs as floats/strings with junk, plus duplicate and unknown
    pd.DataFrame({"Description": ["Alpha wash", "Beta cloth", "Ghost", "Alpha dup"], "Size": ["400ml", "1kg", "x", "y"],
                  "Pack": [6, 8, 1, 1], "EAN": ["4006381333931", "5000000000017.0", "9999999999999", "4006381333931"],
                  "Case Barcode": ["0400", "0500", "0999", "0400"]}
                 ).to_excel(tmp_path / "supplier.xlsx", index=False)

    rows = finder.run(tmp_path / "supplier.xlsx", None, tmp_path / "config.yaml", tmp_path / "out", debug=True)
    assert (tmp_path / "out" / "debug" / "4006381333931_product.html").exists()
    by = {r["ean"]: r for r in rows}
    assert len(rows) == 3                                   # duplicate removed
    assert by["4006381333931"]["status"] == "matched"
    assert [u.rsplit("/", 1)[-1] for u in by["4006381333931"]["images"]][:3] == ["a_full.jpg", "b_full.jpg", "c_full.jpg"]
    assert any(u.endswith("json_extra.jpg") for u in by["4006381333931"]["images"])
    assert not any("placeholder" in u or "logo" in u for u in by["4006381333931"]["images"])
    assert by["5000000000017"]["status"] == "matched"       # direct redirect to product page
    assert by["9999999999999"]["status"] == "not_found"

    assert by["4006381333931"]["title"].startswith("Test Soap p1")
    assert by["4006381333931"]["pack"] == "6" and by["4006381333931"]["size"] == "400ml"   # pack/size come from the sheet
    prod = pd.read_csv(tmp_path / "out" / "products.csv", dtype=str).fillna("")
    assert list(prod.columns)[:5] == ["ean", "title", "image", "pack", "size"]
    assert prod.loc[prod.ean == "4006381333931", "image"].iloc[0].endswith("a_full.jpg")

    long_df = pd.read_csv(tmp_path / "out" / "images.csv", dtype=str)
    assert list(long_df.columns)[:5] == ["ean", "title", "image", "pack", "size"]
    a = long_df[long_df.ean == "4006381333931"]
    assert set(a.title) == {by["4006381333931"]["title"]} and set(a.pack) == {"6"} and set(a["size"]) == {"400ml"}
    assert (long_df.image.str.startswith("http://127.0.0.1")).all()
    xl = pd.read_excel(tmp_path / "out" / "images.xlsx", sheet_name=None)
    assert set(xl) == {"Products", "Summary", "Images"}
