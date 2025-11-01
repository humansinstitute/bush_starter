import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const PROJECT_ROOT = path.resolve(import.meta.dir, "..");
const TMP_DIR = path.join(PROJECT_ROOT, "tmp");
const PID_FILE = path.join(TMP_DIR, "server.pid");

type Action = "start" | "stop" | "restart";

function ensureTmpDir() {
  if (!existsSync(TMP_DIR)) {
    mkdirSync(TMP_DIR, { recursive: true });
  }
}

function writePidFile(pid: number) {
  ensureTmpDir();
  writeFileSync(PID_FILE, `${pid}`, "utf8");
}

function readPidFile(): number | null {
  if (!existsSync(PID_FILE)) {
    return null;
  }

  const content = readFileSync(PID_FILE, "utf8").trim();
  const pid = Number.parseInt(content, 10);
  return Number.isFinite(pid) ? pid : null;
}

function removePidFile() {
  if (existsSync(PID_FILE)) {
    rmSync(PID_FILE);
  }
}

function isProcessRunning(pid: number | null): pid is number {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function delay(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function startServer() {
  const existingPid = readPidFile();
  if (isProcessRunning(existingPid)) {
    console.log(`Server already running with PID ${existingPid}`);
    return;
  }

  const child = spawn("bun", ["run", "src/index.ts"], {
    cwd: PROJECT_ROOT,
    stdio: ["inherit", "pipe", "inherit"],
  });

  if (!child.pid) {
    console.error("Failed to start server process.");
    process.exit(1);
  }

  let wingmanLogged = false;
  let stdoutBuffer = "";

  child.stdout?.on("data", (chunk) => {
    const text = chunk.toString();
    process.stdout.write(chunk);
    if (wingmanLogged) {
      return;
    }
    stdoutBuffer += text;
    let newlineIndex = stdoutBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (line.includes("[WINGMAN21-URL]")) {
        wingmanLogged = true;
        break;
      }
      const match = line.match(/wallet ready on port (\d+)/i);
      if (match?.[1]) {
        console.log(`[WINGMAN21-URL]https://host.otherstuff.ai/${match[1]}`);
        wingmanLogged = true;
        break;
      }
      newlineIndex = stdoutBuffer.indexOf("\n");
    }
  });

  writePidFile(child.pid);
  console.log(`Started server on PID ${child.pid}`);

  const handleSignal = (signal: NodeJS.Signals) => {
    console.log(`Received ${signal}, stopping server...`);
    if (isProcessRunning(child.pid)) {
      process.kill(child.pid, "SIGTERM");
    }
  };

  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  try {
    const [code, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
    if (code !== null && code !== 0) {
      console.error(`Server process exited with code ${code}`);
      process.exitCode = code;
    } else if (signal) {
      console.log(`Server process terminated with signal ${signal}`);
    }
  } finally {
    removePidFile();
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);
  }
}

async function stopServer() {
  const pid = readPidFile();

  if (!isProcessRunning(pid)) {
    removePidFile();
    console.log("Server is not running");
    return;
  }

  process.kill(pid, "SIGTERM");
  console.log(`Sent SIGTERM to PID ${pid}`);

  removePidFile();
}

async function restartServer() {
  await stopServer();
  // Small delay to give the OS time to release the port before restarting.
  await delay(500);
  await startServer();
}

function parseAction(): Action {
  const [, , maybeAction] = Bun.argv;
  const action = (maybeAction ?? "").toLowerCase();

  if (action === "start" || action === "stop" || action === "restart") {
    return action;
  }

  console.error("Usage: bun run scripts/manage.ts <start|stop|restart>");
  process.exit(1);
}

const action = parseAction();

async function main() {
  switch (action) {
    case "start":
      await startServer();
      break;
    case "stop":
      await stopServer();
      break;
    case "restart":
      await restartServer();
      break;
    default:
      process.exit(1);
  }
}

await main();
