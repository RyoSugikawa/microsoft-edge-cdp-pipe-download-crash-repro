# Validated run — 2026-09-03

This record contains sanitized results from the final standalone harness validation. Machine-specific artifact paths and minidumps are intentionally excluded.

## Reproduction

Command:

```powershell
node repro.mjs --transport pipe --iterations 5 --download-behavior allow
```

Result:

```text
run=1 transport=pipe edge=Edg/152.0.4191.53 result=ok
run=2 transport=pipe result=failed exit_code=3221225477 (0xC0000005)
Edge exited with 3221225477 before finalizing the download
```

The generated crash dump resolved to:

```text
exception_code=0xC0000005
exception_address=0x00007FFE8975C88B
access_type=read
access_address=0x000000000000001A
module=msedge.dll 152.0.4191.53
module_offset=0x9D5C88B
```

## Transport control

Command:

```powershell
node repro.mjs --transport port --iterations 8 --download-behavior allow
```

Result:

```text
run=1 transport=port result=ok
run=2 transport=port result=ok
run=3 transport=port result=ok
run=4 transport=port result=ok
run=5 transport=port result=ok
run=6 transport=port result=ok
run=7 transport=port result=ok
run=8 transport=port result=ok
All launches completed without a crash.
```

## Integrity checks

- Every successful download was exactly 5 MiB.
- Every successful download matched the generated SHA-256.
- Both paths used the same Edge binary, generated profile lifecycle, HTTP payload, and CDP command sequence.
- The debugging transport was the controlled independent variable.

## Playwright-equivalent download behavior

A second A/B run used `Browser.setDownloadBehavior` with `allowAndName`, matching Playwright 1.62:

```text
pipe: run 1 succeeded; run 2 crashed with 0xC0000005
port: runs 1–4 succeeded
```

## Playwright public-API reproduction

The minimized `playwright_repro.py` companion was validated with Playwright for Python 1.62.0 in both modes:

```text
headless: run 1 succeeded; run 2 disconnected and save_as reported a closed target
headed:   run 1 succeeded; run 2 disconnected and save_as reported a closed target
```

Each run used a newly generated profile that was then reused for the second Edge launch. The independently generated dumps retained the same native signature:

```text
exception_code=0xC0000005
access_type=read
module=msedge.dll 152.0.4191.53
module_offset=0x9D5C88B
headless_access_address=0x1A
headed_access_address=0x21
```
