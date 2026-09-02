from __future__ import annotations

import argparse
import hashlib
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.metadata import version
from pathlib import Path

from playwright.sync_api import BrowserContext, Error, sync_playwright


SAMPLE_SIZE = 5 * 1024 * 1024
CHUNK = bytes(range(256)) * 256
SAMPLE_HASH = hashlib.sha256(CHUNK * (SAMPLE_SIZE // len(CHUNK))).hexdigest()


class SampleHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path == "/":
            body = (
                b'<!doctype html><meta charset="utf-8">'
                b'<a id="download" href="/sample.bin" download>Download 5 MiB</a>'
            )
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if self.path == "/sample.bin":
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header(
                "Content-Disposition", 'attachment; filename="sample.bin"'
            )
            self.send_header("Content-Length", str(SAMPLE_SIZE))
            self.end_headers()
            for _ in range(SAMPLE_SIZE // len(CHUNK)):
                self.wfile.write(CHUNK)
            return

        self.send_error(404)

    def log_message(self, format: str, *args: object) -> None:
        return


def positive_integer(value: str) -> int:
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError("value must be positive")
    return parsed


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Reproduce the Edge persistent-profile download crash via Playwright."
    )
    parser.add_argument("--iterations", type=positive_integer, default=5)
    parser.add_argument("--headed", action="store_true")
    parser.add_argument(
        "--artifacts",
        type=Path,
        default=Path(".artifacts") / f"playwright-{time.time_ns()}",
    )
    return parser.parse_args()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def main() -> int:
    args = parse_args()
    artifact_root = args.artifacts.resolve()
    profile_dir = artifact_root / "profile"
    profile_dir.mkdir(parents=True, exist_ok=True)

    server = ThreadingHTTPServer(("127.0.0.1", 0), SampleHandler)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    page_url = f"http://127.0.0.1:{server.server_port}/"

    print(f"playwright={version('playwright')}")
    print(f"profile={profile_dir}")
    print(f"headless={not args.headed}")

    try:
        with sync_playwright() as playwright:
            for run in range(1, args.iterations + 1):
                download_dir = artifact_root / f"download-{run}"
                download_dir.mkdir(parents=True, exist_ok=True)
                context: BrowserContext | None = None
                try:
                    context = playwright.chromium.launch_persistent_context(
                        user_data_dir=profile_dir,
                        channel="msedge",
                        headless=not args.headed,
                        accept_downloads=True,
                        downloads_path=download_dir,
                    )
                    browser = context.browser
                    if browser is not None:
                        browser.on(
                            "disconnected",
                            lambda _browser, current_run=run: print(
                                f"run={current_run} event=browser_disconnected"
                            ),
                        )

                    page = context.pages[0] if context.pages else context.new_page()
                    page.goto(page_url, wait_until="domcontentloaded")
                    with page.expect_download(timeout=15_000) as download_info:
                        page.locator("#download").click()

                    destination = download_dir / "saved-sample.bin"
                    download_info.value.save_as(destination)
                    if destination.stat().st_size != SAMPLE_SIZE:
                        raise RuntimeError("download size mismatch")
                    if sha256(destination) != SAMPLE_HASH:
                        raise RuntimeError("download SHA-256 mismatch")
                    print(f"run={run} result=ok")
                except (Error, OSError, RuntimeError) as error:
                    print(f"run={run} result=failed error={error}")
                    print(f"crashpad={profile_dir / 'Crashpad' / 'reports'}")
                    return 1
                finally:
                    if context is not None:
                        try:
                            context.close()
                        except Error:
                            pass
    finally:
        server.shutdown()
        server.server_close()
        server_thread.join(timeout=5)

    print("all_runs=ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
