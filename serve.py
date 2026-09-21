#!/usr/bin/env python3
"""本地静态服务器。Service Worker 要求 localhost 或 HTTPS 环境。"""
import http.server
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # 服务器自身不缓存，缓存行为完全由 SW 策略控制，保证实验可复现
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # 静默日志


if __name__ == "__main__":
    with http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler) as srv:
        print(f"▶ http://localhost:{PORT}  (Ctrl+C 停止)")
        srv.serve_forever()
