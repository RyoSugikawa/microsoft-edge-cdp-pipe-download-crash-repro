# Investigation record

## Executive finding

The observed failure is a native Microsoft Edge crash associated with a reused user-data directory, CDP-controlled downloading, and the `--remote-debugging-pipe` transport.

The strongest ownership signal is a standalone reproduction that does not import or execute Playwright. The same workload remains stable when only the CDP transport is changed from pipe to WebSocket over a remote-debugging port.

## Environment

| Component | Version |
|---|---|
| Operating system | Windows 11 Home 10.0.26200, build 26200 |
| Microsoft Edge Stable | 152.0.4191.53 |
| Playwright for Python | 1.62.0 |
| Playwright-bundled Chromium | 151.0.7922.34 |
| Python | 3.12.14 |
| Node.js | 24.18.1 |

## Initial symptom

An application using `chromium.launch_persistent_context(channel="msedge")` could download successfully with a fresh profile, then terminate unexpectedly during a download after reusing that profile.

The visible Playwright exceptions were:

```text
browser_disconnected reason=unexpected
Download.save_as: Target page, context or browser has been closed
```

These messages describe the loss of the browser process. They do not identify the native fault.

## Hypotheses and falsification

### H1: `download.save_as()` closes the browser

Falsified.

- The crash reproduced when `download.save_as()` was never called.
- The crash also reproduced while resolving `download.path()`.
- Waiting on the Playwright event loop after the download event was sufficient to observe the browser termination.

### H2: Headless mode is responsible

Falsified.

- Headless and headed executions both crashed.
- Both dumps resolved to the same instruction in `msedge.dll`.

### H3: The original profile is corrupt

Falsified as a complete explanation.

- A fresh profile completed five downloads in its first launch.
- The newly created profile became vulnerable after browser restart and reuse.
- Multiple independent fresh profiles produced the same native crash signature.

### H4: Playwright's `Browser.setDownloadBehavior` mode is responsible

Falsified.

- Raw CDP with `allowAndName` over a port completed eight consecutive profile reuses.
- Raw CDP over a pipe reproduced with both `allow` and `allowAndName`.

### H5: A specific Playwright default switch is responsible

Not supported by the controls.

- Removing the complete `--disable-features=...` argument did not prevent the crash.
- Restoring `DestroyProfileOnBrowserClose` did not prevent the crash.
- Removing Edge-specific updater and compatibility switches did not prevent the crash.
- A minimal raw-CDP pipe launch still reproduced, although the failure moved from launch two to launch three in one run. The failure count is therefore nondeterministic.

### H6: Playwright's CDP command sequence is responsible

Falsified as a necessary condition.

- A standalone Node.js script using only built-in modules and direct CDP messages reproduced the native crash.

## Controlled transport comparison

The repository harness holds the following variables constant:

- Edge binary
- user-data directory
- 5 MiB HTTP payload
- page and link activation
- `Browser.setDownloadBehavior`
- CDP target creation and attachment
- graceful `Browser.close` between launches

The independent variable is the debugging transport:

```text
Reproduction: --remote-debugging-pipe
Control:      --remote-debugging-port=<ephemeral port>
```

Observed results:

| Browser and control path | Reuse count | Result |
|---|---:|---|
| Edge 152 + raw CDP pipe, no Playwright | 2–3 launches | Native crash |
| Edge 152 + raw CDP port, `allowAndName` | 8 launches | 8/8 successful |
| Edge 152 launched directly + Playwright `connect_over_cdp()` | 2 launches | 2/2 successful |
| Edge 152 + Playwright defaults, CDP via port | 2 launches | 2/2 successful |
| Bundled Chromium 151 + Playwright persistent context / pipe | 5 launches × 5 downloads | 25/25 successful |
| Fresh Edge profile, one launch | 5 downloads | 5/5 successful |

## Native crash signature

Repeated independently collected dumps were parsed from Playwright headless, Playwright headed, and standalone raw-CDP pipe executions.

```text
Exception code:    0xC0000005
Access type:       read
Exception address: 0x00007FFE8975C88B
Module:            msedge.dll 152.0.4191.53
Module base:       0x00007FFE7FA00000
Module offset:     0x9D5C88B
Invalid addresses: near-null addresses in the 0x18–0x21 range
```

The identical exception instruction and module offset strongly indicate one native fault reached through three independent automation paths.

## Component isolation

The evidence localizes the native failure to Microsoft Edge:

1. Edge produces an access-violation crash inside `msedge.dll`.
2. Playwright is absent from the standalone reproduction.
3. Playwright's bundled Chromium remains stable under the persistent-context pipe workload.
4. Edge remains stable when the transport changes to a debugging port.

Playwright participates in the exposure path by selecting `--remote-debugging-pipe` for Chromium-family launches, but it is not required to reproduce the native fault.

## Practical mitigations

In descending order of confidence:

1. Launch Edge independently with `--remote-debugging-port` and attach using `connect_over_cdp()`.
2. Use Playwright-bundled Chromium when Edge-specific behavior is not required.
3. Use a new profile for each Edge launch if persistent authentication is not required.

These are mitigations, not fixes for the native Edge defect.
