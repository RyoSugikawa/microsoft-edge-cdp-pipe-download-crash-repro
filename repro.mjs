import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import path from "node:path";
import process from "node:process";


const DEFAULT_EDGE_PATH =
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const SAMPLE_SIZE = 5 * 1024 * 1024;
const SAMPLE_CONTENT = Buffer.alloc(SAMPLE_SIZE, 0x41);
const SAMPLE_HASH = createHash("sha256").update(SAMPLE_CONTENT).digest("hex");
const VALID_TRANSPORTS = new Set(["pipe", "port"]);
const VALID_DOWNLOAD_BEHAVIORS = new Set(["allow", "allowAndName"]);


const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));


function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}


function integerOption(name, fallback) {
  const value = Number.parseInt(option(name, String(fallback)), 10);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}


function parseOptions() {
  const transport = option("--transport", "pipe");
  const downloadBehavior = option("--download-behavior", "allow");
  if (!VALID_TRANSPORTS.has(transport)) {
    throw new Error(`--transport must be one of: ${[...VALID_TRANSPORTS].join(", ")}`);
  }
  if (!VALID_DOWNLOAD_BEHAVIORS.has(downloadBehavior)) {
    throw new Error(
      `--download-behavior must be one of: ${[...VALID_DOWNLOAD_BEHAVIORS].join(", ")}`,
    );
  }

  const artifactRoot = path.resolve(
    option(
      "--artifacts",
      path.join(".artifacts", `${transport}-${Date.now()}-${randomUUID()}`),
    ),
  );
  return {
    artifactRoot,
    downloadBehavior,
    edgePath: option("--edge-path", DEFAULT_EDGE_PATH),
    iterations: integerOption("--iterations", 8),
    transport,
  };
}


function printHelp() {
  console.log(`Usage: node repro.mjs [options]

Options:
  --transport pipe|port                  CDP transport (default: pipe)
  --download-behavior allow|allowAndName CDP download behavior (default: allow)
  --iterations <number>                  Profile reuse count (default: 8)
  --edge-path <path>                     Path to msedge.exe
  --artifacts <directory>                Artifact output root
  --help                                 Show this help`);
}


class CdpCommandDispatcher {
  constructor() {
    this.nextId = 1;
    this.pending = new Map();
  }

  createCommand(method, params, sessionId) {
    const id = this.nextId++;
    const result = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return { message, result };
  }

  dispatch(message) {
    if (!message.id) return;
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result);
  }

  rejectAll(error) {
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }
}


class PipeCdpConnection {
  constructor(child) {
    this.child = child;
    this.dispatcher = new CdpCommandDispatcher();
    this.writePipe = child.stdio[3];
    this.readPipe = child.stdio[4];
    this.buffer = Buffer.alloc(0);

    this.readPipe.on("data", (chunk) => this.onData(chunk));
    this.readPipe.on("close", () =>
      this.dispatcher.rejectAll(new Error("CDP pipe closed")),
    );
    child.on("exit", (code) =>
      this.dispatcher.rejectAll(new Error(`Edge exited with ${code}`)),
    );
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let separator = this.buffer.indexOf(0);
    while (separator !== -1) {
      const raw = this.buffer.subarray(0, separator).toString("utf8");
      this.buffer = this.buffer.subarray(separator + 1);
      if (raw) this.dispatcher.dispatch(JSON.parse(raw));
      separator = this.buffer.indexOf(0);
    }
  }

  async send(method, params = {}, sessionId = undefined) {
    const { message, result } = this.dispatcher.createCommand(
      method,
      params,
      sessionId,
    );
    this.writePipe.write(`${JSON.stringify(message)}\0`);
    return await result;
  }
}


class WebSocketCdpConnection {
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    return new WebSocketCdpConnection(socket);
  }

  constructor(socket) {
    this.socket = socket;
    this.dispatcher = new CdpCommandDispatcher();
    socket.addEventListener("message", (event) =>
      this.dispatcher.dispatch(JSON.parse(String(event.data))),
    );
    socket.addEventListener("close", () =>
      this.dispatcher.rejectAll(new Error("CDP WebSocket closed")),
    );
  }

  async send(method, params = {}, sessionId = undefined) {
    const { message, result } = this.dispatcher.createCommand(
      method,
      params,
      sessionId,
    );
    this.socket.send(JSON.stringify(message));
    return await result;
  }
}


async function reservePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}


async function waitForDevTools(port, child, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Edge exited with ${child.exitCode} before DevTools started`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return await response.json();
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(`DevTools endpoint did not start: ${lastError ?? "timeout"}`);
}


async function waitForPage(cdp, sessionId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await cdp.send(
      "Runtime.evaluate",
      {
        expression:
          "document.readyState === 'complete' && !!document.querySelector('#download')",
        returnByValue: true,
      },
      sessionId,
    );
    if (result.result?.value === true) return;
    await sleep(50);
  }
  throw new Error("Test page did not become ready");
}


async function waitForDownload(downloadDir, child, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Edge exited with ${child.exitCode} before finalizing the download`);
    }
    for (const name of await readdir(downloadDir)) {
      if (name.endsWith(".crdownload")) continue;
      const candidate = path.join(downloadDir, name);
      const info = await stat(candidate);
      if (info.isFile() && info.size === SAMPLE_SIZE) return candidate;
    }
    await sleep(100);
  }
  throw new Error("Download did not finish before the timeout");
}


async function sha256(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}


function waitForChildExit(child, timeoutMs = 10_000) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    sleep(timeoutMs).then(() => {
      throw new Error("Edge did not exit after Browser.close");
    }),
  ]);
}


async function launchOnce({
  downloadBehavior,
  downloadDir,
  edgePath,
  pageUrl,
  profileDir,
  run,
  transport,
}) {
  await mkdir(downloadDir, { recursive: true });
  const debuggingPort = transport === "port" ? await reservePort() : undefined;
  const transportSwitch =
    transport === "pipe"
      ? "--remote-debugging-pipe"
      : `--remote-debugging-port=${debuggingPort}`;
  const child = spawn(
    edgePath,
    [
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-mode",
      `--user-data-dir=${profileDir}`,
      transportSwitch,
      "about:blank",
    ],
    {
      stdio:
        transport === "pipe"
          ? ["ignore", "pipe", "pipe", "pipe", "pipe"]
          : ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    if (stderr.length < 8_000) stderr += String(chunk);
  });

  try {
    let cdp;
    if (transport === "pipe") {
      cdp = new PipeCdpConnection(child);
    } else {
      const endpoint = await waitForDevTools(debuggingPort, child);
      cdp = await WebSocketCdpConnection.connect(endpoint.webSocketDebuggerUrl);
    }

    const version = await cdp.send("Browser.getVersion");
    await cdp.send("Browser.setDownloadBehavior", {
      behavior: downloadBehavior,
      downloadPath: downloadDir,
      eventsEnabled: true,
    });
    const created = await cdp.send("Target.createTarget", { url: pageUrl });
    const attached = await cdp.send("Target.attachToTarget", {
      targetId: created.targetId,
      flatten: true,
    });
    await cdp.send("Page.enable", {}, attached.sessionId);
    await waitForPage(cdp, attached.sessionId);
    await cdp.send(
      "Runtime.evaluate",
      {
        expression: "document.querySelector('#download').click()",
        returnByValue: true,
      },
      attached.sessionId,
    );

    const downloadedFile = await waitForDownload(downloadDir, child);
    if ((await sha256(downloadedFile)) !== SAMPLE_HASH) {
      throw new Error("Downloaded file SHA-256 does not match");
    }
    console.log(
      `run=${run} transport=${transport} edge=${version.product} result=ok file=${downloadedFile}`,
    );

    await cdp.send("Browser.close").catch(() => {});
    await waitForChildExit(child);
    return true;
  } catch (error) {
    const unsignedExitCode = child.exitCode === null ? null : child.exitCode >>> 0;
    const hexadecimalExitCode =
      unsignedExitCode === null
        ? "n/a"
        : `0x${unsignedExitCode.toString(16).toUpperCase().padStart(8, "0")}`;
    console.error(
      `run=${run} transport=${transport} result=failed exit_code=${unsignedExitCode} (${hexadecimalExitCode})`,
    );
    console.error(error.message);
    if (stderr.trim()) console.error(stderr.trim());
    return false;
  } finally {
    if (child.exitCode === null) child.kill();
  }
}


function createSampleServer() {
  return createHttpServer((request, response) => {
    if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        '<!doctype html><meta charset="utf-8"><title>Edge CDP download reproduction</title><a id="download" href="/sample.bin" download>Download 5 MiB sample</a>',
      );
      return;
    }
    if (request.url === "/sample.bin") {
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(SAMPLE_SIZE),
        "content-disposition": 'attachment; filename="sample.bin"',
      });
      response.end(SAMPLE_CONTENT);
      return;
    }
    response.writeHead(404).end();
  });
}


async function main() {
  if (process.argv.includes("--help")) {
    printHelp();
    return;
  }
  const options = parseOptions();
  const profileDir = path.join(options.artifactRoot, "profile");
  await mkdir(profileDir, { recursive: true });

  const server = createSampleServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const pageUrl = `http://127.0.0.1:${server.address().port}/`;

  console.log(`transport=${options.transport}`);
  console.log(`download_behavior=${options.downloadBehavior}`);
  console.log(`artifacts=${options.artifactRoot}`);
  console.log(`profile=${profileDir}`);
  console.log(`iterations=${options.iterations}`);

  let allSucceeded = true;
  try {
    for (let run = 1; run <= options.iterations; run += 1) {
      const succeeded = await launchOnce({
        ...options,
        profileDir,
        downloadDir: path.join(options.artifactRoot, `download-${run}`),
        pageUrl,
        run,
      });
      if (!succeeded) {
        allSucceeded = false;
        break;
      }
    }
  } finally {
    server.close();
  }

  if (!allSucceeded) {
    console.error(
      `Failure captured. Crashpad directory: ${path.join(profileDir, "Crashpad", "reports")}`,
    );
    process.exitCode = 1;
  } else {
    console.log("All launches completed without a crash.");
  }
}


await main();
