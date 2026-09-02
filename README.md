# Microsoft Edge CDP pipe crash reproduction

A dependency-free, controlled reproduction of a native Microsoft Edge crash during a CDP-driven download when the same browser profile is reused across launches.

The investigation isolates the failure boundary to **Microsoft Edge + reusable profile + CDP pipe transport + download finalization**. The repository includes a matching remote-debugging-port control, a documented hypothesis matrix, and a minidump parser.

> Status: reproduced on Microsoft Edge Stable 152.0.4191.53 on Windows 11 build 26200. The result is environment-specific until independently confirmed upstream.

Upstream tracking: [MicrosoftEdge/DevTools#461](https://github.com/MicrosoftEdge/DevTools/issues/461).

## Why this repository exists

The original application surfaced two high-level errors:

```text
browser_disconnected reason=unexpected
Download.save_as: Target page, context or browser has been closed
```

Those messages suggest an automation lifecycle problem but do not reveal the cause. Native crash dumps, transport controls, browser controls, and API-level controls establish that the browser process exits with a read access violation inside `msedge.dll`.

The standalone harness intentionally does **not** import or execute Playwright, Puppeteer, Selenium, or any third-party npm package.

## Executive result

| Path | Profile reuse | Observed result |
|---|---:|---|
| Edge 152 + raw CDP pipe | 2–3 launches | Native crash |
| Edge 152 + raw CDP port | 8 launches | 8/8 successful |
| Edge 152 + Playwright attached over CDP port | 2 launches | 2/2 successful |
| Playwright-bundled Chromium 151 + persistent pipe context | 5 launches × 5 downloads | 25/25 successful |
| Fresh Edge profile, one launch | 5 downloads | 5/5 successful |

The pipe reproduction and port control use the same Edge binary, page, generated 5 MiB payload, user-data lifecycle, CDP commands, and graceful browser shutdown. Only the debugging transport changes.

## Reproduce

### Requirements

- Windows
- Microsoft Edge installed in its default location
- Node.js 22 or later

No package installation is required.

```powershell
npm run repro
```

Equivalent explicit command:

```powershell
node repro.mjs --transport pipe --iterations 8
```

The script creates one dedicated generated Edge profile, launches Edge repeatedly with that profile, and downloads one generated 5 MiB file per launch. In the observed environment, the process normally exits with `0xC0000005` during launch two or three.

### Run the transport control

```powershell
npm run control
```

Equivalent explicit command:

```powershell
node repro.mjs --transport port --iterations 8
```

The control changes only the debugging transport from `--remote-debugging-pipe` to an ephemeral `--remote-debugging-port` WebSocket endpoint.

### Reproduce through Playwright

The companion Python reproduction exercises the original public API path. It launches Edge repeatedly with `chromium.launch_persistent_context(channel="msedge")`, reuses one dedicated generated profile, and downloads the same generated 5 MiB payload once per launch.

```powershell
python -m pip install -r requirements-playwright.txt
python playwright_repro.py --iterations 5
```

No Playwright browser download is required because the script selects the locally installed Edge Stable channel. Add `--headed` to verify that the failure is not limited to headless execution.

### Optional parameters

```text
--transport pipe|port
--download-behavior allow|allowAndName
--iterations <positive integer>
--edge-path <path to msedge.exe>
--artifacts <output directory>
```

## Expected and actual behavior

Expected:

- Every download completes.
- The downloaded content matches the generated SHA-256.
- Edge exits normally after `Browser.close`.
- The profile remains reusable.

Actual with CDP pipe:

- Edge exits while finalizing a download after profile reuse.
- A complete 5 MiB `.crdownload` can remain without its final rename.
- The process exit code is `3221225477` (`0xC0000005`).

## Native crash signature

Repeated independently collected dumps—Playwright headless, Playwright headed, and standalone raw CDP pipe—resolved to the same instruction:

```text
Exception:      0xC0000005 read access violation
Module:         msedge.dll 152.0.4191.53
Module offset:  0x9D5C88B
Invalid reads:  near-null addresses in the 0x18–0x21 range
```

The common instruction and module offset strongly indicate one native fault reached through independent entry paths.

## Repository map

```text
.
├── repro.mjs                         # Pipe reproduction and port control
├── playwright_repro.py               # Minimal Playwright public-API reproduction
├── requirements-playwright.txt       # Pinned Python binding used for validation
├── docs/
│   └── INVESTIGATION.md              # Hypotheses and controlled isolation
├── evidence/
│   └── VALIDATED_RUN_2026-09-03.md    # Sanitized final A/B validation
├── tools/
│   └── inspect_minidump.py           # Dependency-free minidump signature reader
├── .github/workflows/quality.yml     # Static syntax validation
├── CITATION.cff
└── LICENSE
```

## Controls

The investigation explicitly tested and rejected the following explanations:

- `download.save_as()` as the cause
- `download.path()` as the cause
- headless mode as the cause
- corruption unique to the original profile
- Playwright's `allowAndName` behavior as the cause
- a necessary dependency on Playwright's CDP command sequence
- `DestroyProfileOnBrowserClose` as the isolated trigger
- the complete Playwright `--disable-features=...` list as the isolated trigger

See [docs/INVESTIGATION.md](docs/INVESTIGATION.md) for the complete evidence chain.

## Practical mitigation

For applications that must keep an authenticated Edge profile, launch Edge independently with `--remote-debugging-port` and attach using Playwright's `connect_over_cdp()`.

When Edge-specific behavior is not required, Playwright-bundled Chromium is the simpler stable alternative in the tested environment.

## Privacy and responsible reporting

Artifacts remain under `.artifacts/` and are ignored by Git. Generated browser profiles and crash dumps must not be published because they may contain local paths, identifiers, or process memory.

This repository documents a stability defect. It does not claim exploitability, a security vulnerability, or CVE eligibility.

## Attribution

Reported and minimized by [Ryo S.](https://github.com/ryo-whaletech).

If this investigation is useful in another report or technical discussion, cite the repository URL or use [CITATION.cff](CITATION.cff).

## License

[MIT](LICENSE)
