"""Tiny local 'supplier website' used for testing."""
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

PRODUCTS = {
    "4006381333931": ("p1", ["/img/a_full.jpg", "/img/b_full.jpg", "/img/c_full.jpg"]),
    "5000000000017": ("p2", ["/img/x_full.jpg"]),   # search redirects straight to product
}


def product_html(slug, ean, imgs):
    gallery = "".join(f'<img src="/img/t{i}_thumb.jpg" data-zoom-image="{u}">' for i, u in enumerate(imgs))
    return f"""<html><head>
<meta property="og:image" content="{imgs[0]}">
<script type="application/ld+json">{{"@type":"Product","image":["{imgs[0]}","/img/json_extra.jpg"]}}</script>
</head><body><h1>Test Soap {slug} 6 x 250ml</h1><p>EAN: {ean}</p>
<div class="gallery">{gallery}<img src="/img/placeholder.png"></div>
<img src="/img/logo.png"></body></html>"""


class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/search":
            q = parse_qs(u.query).get("q", [""])[0]
            if q in PRODUCTS and q.startswith("4"):
                body = f'<html><body><a class="product-item-link" href="/product/{PRODUCTS[q][0]}">hit</a></body></html>'
            elif q in PRODUCTS:
                self.send_response(302); self.send_header("Location", f"/product/{PRODUCTS[q][0]}"); self.end_headers(); return
            else:
                body = "<html><body>No results</body></html>"
        elif u.path.startswith("/product/"):
            slug = u.path.split("/")[-1]
            ean, (_, imgs) = next((e, v) for e, v in PRODUCTS.items() if v[0] == slug)
            body = product_html(slug, ean, imgs)
        else:
            body = "ok"
        self.send_response(200); self.send_header("Content-Type", "text/html"); self.end_headers()
        self.wfile.write(body.encode())


def start(port=0):
    srv = HTTPServer(("127.0.0.1", port), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv
