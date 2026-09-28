"""Writes icons/app-qr.svg: a QR code of the Android app's permanent download link,
for the site's app dialog on a computer, to scan with the phone.

    pip install qrcode && python tools/app-qr.py

The link never changes (it always serves the newest release), so neither does this.
"""
import os
import qrcode

URL = "https://github.com/soroushaz1/roja/releases/latest/download/roja.apk"
qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, border=2)
qr.add_data(URL)
qr.make(fit=True)
m = qr.get_matrix()
n = len(m)
# One path of unit squares, merged along each row.
d = []
for y, row in enumerate(m):
    x = 0
    while x < n:
        if row[x]:
            start = x
            while x < n and row[x]:
                x += 1
            d.append(f"M{start} {y}h{x - start}v1H{start}z")
        else:
            x += 1
svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {n} {n}" shape-rendering="crispEdges">'
       f'<title>{URL}</title><rect width="{n}" height="{n}" fill="#fff"/>'
       f'<path fill="#140C11" d="{"".join(d)}"/></svg>\n')
root = os.path.join(os.path.dirname(__file__), "..")
with open(os.path.join(root, "icons", "app-qr.svg"), "w") as f:
    f.write(svg)
print(f"icons/app-qr.svg: {n}x{n} modules, {len(svg)} bytes")
