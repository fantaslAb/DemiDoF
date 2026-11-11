#!/usr/bin/env python3
"""Local dev server for DemiDoF.

    python serve.py            # http://localhost:8000
    python serve.py --https    # https://<lan-ip>:8443  (needed for phone gyro / camera / Quest WebXR)

--https generates a self-signed certificate in .cert/ with openssl (Git for Windows ships one).
Your phone / headset will show a certificate warning once; accept it.
"""
import argparse
import http.server
import os
import pathlib
import shutil
import socket
import ssl
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent
CERT_DIR = ROOT / ".cert"


class Handler(http.server.SimpleHTTPRequestHandler):
    # Windows' registry sometimes maps .js to text/plain, which breaks ES modules.
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".json": "application/json",
        ".webmanifest": "application/manifest+json",
        ".wasm": "application/wasm",
    }

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        if "200" in str(args) or "304" in str(args):
            return
        super().log_message(fmt, *args)


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def find_openssl():
    found = shutil.which("openssl")
    if found:
        return found
    for cand in (r"C:\Program Files\Git\usr\bin\openssl.exe", r"C:\Program Files\Git\mingw64\bin\openssl.exe"):
        if os.path.exists(cand):
            return cand
    return None


def ensure_cert(ip):
    key, crt = CERT_DIR / "key.pem", CERT_DIR / "cert.pem"
    if key.exists() and crt.exists():
        return key, crt
    openssl = find_openssl()
    if not openssl:
        sys.exit("openssl not found; install Git for Windows or OpenSSL, or run without --https")
    CERT_DIR.mkdir(exist_ok=True)
    subprocess.check_call([
        openssl, "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "825",
        "-keyout", str(key), "-out", str(crt),
        "-subj", "/CN=demidof.local",
        "-addext", f"subjectAltName=DNS:localhost,IP:127.0.0.1,IP:{ip}",
    ])
    return key, crt


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--https", action="store_true")
    ap.add_argument("--port", type=int)
    ap.add_argument("--bind", default="0.0.0.0")
    args = ap.parse_args()
    port = args.port or (8443 if args.https else 8000)
    ip = lan_ip()

    httpd = http.server.ThreadingHTTPServer((args.bind, port), Handler)
    scheme = "http"
    if args.https:
        key, crt = ensure_cert(ip)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(str(crt), str(key))
        httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
        scheme = "https"

    print(f"DemiDoF  {scheme}://localhost:{port}")
    print(f"         {scheme}://{ip}:{port}   (phone / Quest on the same network)")
    if not args.https:
        print("         gyro, camera and WebXR need https on remote devices: python serve.py --https")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
