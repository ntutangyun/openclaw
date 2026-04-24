#!/usr/bin/env python3
"""
One-shot Ollama reverse proxy that tees the first /api/chat request body to
a capture file, then forwards to the real Ollama. All other endpoints are
transparently proxied (tags, show, ps, etc.) so the gateway's health probes
don't notice.

Run:
  python3 ollama_tap.py --upstream http://127.0.0.1:11434 --listen 0.0.0.0:11435 \
      --capture ./capture.json

Stops capturing after the first /api/chat. The proxy keeps running until
Ctrl-C so the gateway can finish the request and stream back tokens.
"""

from __future__ import annotations

import argparse
import http.server
import json
import pathlib
import socketserver
import sys
import threading
import time
import urllib.parse
import urllib.request


def run(args: argparse.Namespace) -> None:
    upstream = args.upstream.rstrip("/")
    host, _, port_str = args.listen.rpartition(":")
    port = int(port_str)
    capture_path = pathlib.Path(args.capture).resolve()
    captured = threading.Event()

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, fmt, *a):
            sys.stderr.write(f"[tap] {self.address_string()} {fmt % a}\n")

        def _forward(self, body: bytes | None):
            url = upstream + self.path
            req = urllib.request.Request(url, data=body, method=self.command)
            for h in ("content-type", "accept"):
                v = self.headers.get(h)
                if v:
                    req.add_header(h, v)
            try:
                with urllib.request.urlopen(req, timeout=600) as resp:
                    self.send_response(resp.status)
                    for k, v in resp.getheaders():
                        if k.lower() in ("transfer-encoding", "connection"):
                            continue
                        self.send_header(k, v)
                    self.end_headers()
                    while True:
                        chunk = resp.read(4096)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        self.wfile.flush()
            except urllib.error.HTTPError as e:
                self.send_response(e.code)
                for k, v in e.headers.items():
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(e.read())
            except Exception as e:
                self.send_response(502)
                self.send_header("Content-Type", "text/plain")
                self.end_headers()
                self.wfile.write(f"tap error: {e}".encode())

        def do_GET(self):
            self._forward(None)

        def do_POST(self):
            length = int(self.headers.get("Content-Length", "0") or "0")
            body = self.rfile.read(length) if length else b""
            if self.path.startswith("/api/chat") and not captured.is_set():
                try:
                    parsed = json.loads(body.decode("utf-8"))
                except Exception:
                    parsed = {"_raw": body.decode("utf-8", "replace")}
                capture_path.write_text(json.dumps(parsed, indent=2),
                                        encoding="utf-8")
                captured.set()
                sys.stderr.write(f"[tap] captured /api/chat ({length} bytes) -> "
                                 f"{capture_path}\n")
            self._forward(body)

    class Threaded(socketserver.ThreadingMixIn, http.server.HTTPServer):
        daemon_threads = True
        allow_reuse_address = True

    srv = Threaded((host, port), Handler)
    sys.stderr.write(f"[tap] listening on {host}:{port}, upstream={upstream}, "
                     f"capture={capture_path}\n")
    sys.stderr.write(f"[tap] waiting for first /api/chat... Ctrl-C to stop\n")
    server_thread = threading.Thread(target=srv.serve_forever, daemon=True)
    server_thread.start()
    try:
        if args.stop_after_capture:
            captured.wait()
            sys.stderr.write("[tap] captured one request; waiting 30s for the "
                             "stream to finish, then exiting\n")
            time.sleep(30)
        else:
            while True:
                time.sleep(3600)
    except KeyboardInterrupt:
        pass
    finally:
        srv.shutdown()
        srv.server_close()


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--upstream", default="http://127.0.0.1:11434")
    p.add_argument("--listen", default="0.0.0.0:11435")
    p.add_argument("--capture", default="capture.json")
    p.add_argument("--stop-after-capture", action="store_true")
    args = p.parse_args()
    run(args)


if __name__ == "__main__":
    main()
