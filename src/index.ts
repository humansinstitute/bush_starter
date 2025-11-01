import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, statSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { createCashubashClient, getDefaultServerPubkey } from "./ctxcn/CashubashClient.ts";
import type { CashubashClient } from "./ctxcn/CashubashClient.ts";

type LogLevel = "info" | "error";

type LogFields = Record<string, unknown> | undefined;

interface MakeInvoiceBody {
  amount?: number;
  description?: string;
  expiry?: number;
}

interface PayInvoiceBody {
  invoice: string;
  amount?: number;
}

interface SendEcashBody {
  amount?: number;
}

function createLogger({ name }: { name: string }) {
  const prefix = `[${name}]`;

  function log(level: LogLevel, fields: LogFields, message: string) {
    const writer = level === "error" ? console.error : console.log;
    if (fields && Object.keys(fields).length > 0) {
      writer(`${prefix} ${message}`, fields);
    } else {
      writer(`${prefix} ${message}`);
    }
  }

  return {
    info(fields: LogFields, message: string) {
      log("info", fields, message);
    },
    error(fields: LogFields, message: string) {
      log("error", fields, message);
    },
  };
}

const logger = createLogger({ name: "cashubash-8bit" });

const SESSION_COOKIE = "cashubash_session";

interface SessionContext {
  serverPubkey?: string;
  client?: CashubashClient;
}

interface SessionHandle {
  id: string;
  context: SessionContext;
  setCookie?: string;
}

const sessions = new Map<string, SessionContext>();

const srcDir = import.meta.dir;

function ensureDirectory(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

function htmlResponse(body: string): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function fileResponse(filePath: string): Response {
  const ext = path.extname(filePath).toLowerCase();
  let contentType = "application/octet-stream";
  switch (ext) {
    case ".js":
      contentType = "application/javascript; charset=utf-8";
      break;
    case ".css":
      contentType = "text/css; charset=utf-8";
      break;
    case ".json":
    case ".map":
      contentType = "application/json; charset=utf-8";
      break;
    case ".svg":
      contentType = "image/svg+xml";
      break;
    case ".png":
      contentType = "image/png";
      break;
    case ".jpg":
    case ".jpeg":
      contentType = "image/jpeg";
      break;
    case ".gif":
      contentType = "image/gif";
      break;
    case ".webp":
      contentType = "image/webp";
      break;
    default:
      break;
  }

  const cacheControl = ext === ".js" || ext === ".css" ? "no-cache" : "no-store";

  return new Response(Bun.file(filePath), {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": cacheControl,
    },
  });
}

function resolveAsset(assetDir: string, requestPath: string): string | null {
  const relative = requestPath.replace(/^\/+/, "");
  if (!relative || relative.endsWith("/")) {
    return null;
  }
  const base = path.resolve(assetDir);
  const candidate = path.resolve(assetDir, relative);
  if (!candidate.startsWith(base)) {
    return null;
  }
  if (!existsSync(candidate)) {
    return null;
  }
  try {
    if (!statSync(candidate).isFile()) {
      return null;
    }
  } catch {
    return null;
  }
  return candidate;
}

interface ServeContext {
  basePrefix: string;
  walletHtml: string;
  assetDir: string;
}

async function findAvailablePort(startPort: number): Promise<number> {
  let port = Math.max(0, startPort);

  while (true) {
    // eslint-disable-next-line no-await-in-loop
    const available = await isPortAvailable(port);
    if (available) {
      return port;
    }
    port += 1;
  }
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net.createServer();

    tester.once("error", () => {
      resolve(false);
    });

    tester.once("listening", () => {
      tester.close(() => resolve(true));
    });

    tester.listen(port, "0.0.0.0");
  });
}

function jsonResponse(body: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers({
    "Content-Type": "application/json",
  });
  if (extraHeaders) {
    const additions = new Headers(extraHeaders);
    additions.forEach((value, key) => {
      if (key.toLowerCase() === "set-cookie") {
        headers.append(key, value);
      } else {
        headers.set(key, value);
      }
    });
  }
  return new Response(JSON.stringify(body), {
    status,
    headers,
  });
}

function serviceUnavailable(message: string, extraHeaders?: HeadersInit): Response {
  logger.info({ message }, "service unavailable");
  return jsonResponse({ message }, 503, extraHeaders);
}

function badRequest(message: string, extraHeaders?: HeadersInit): Response {
  logger.error({ message }, "bad request");
  return jsonResponse({ message }, 400, extraHeaders);
}

function parseCookies(header: string | null): Record<string, string> {
  if (!header) {
    return {};
  }
  return header.split(";").reduce<Record<string, string>>((acc, part) => {
    const [rawKey, ...valueParts] = part.split("=");
    const key = rawKey?.trim();
    if (!key) {
      return acc;
    }
    acc[key] = valueParts.join("=").trim();
    return acc;
  }, {});
}

function ensureSession(request: Request): SessionHandle {
  const cookies = parseCookies(request.headers.get("cookie"));
  let id = cookies[SESSION_COOKIE];
  let isNew = false;

  if (!id) {
    id = randomUUID();
    isNew = true;
  }

  let context = sessions.get(id);
  if (!context) {
    context = {};
    const defaultPubkey = getDefaultServerPubkey();
    if (defaultPubkey) {
      context.serverPubkey = defaultPubkey;
    }
    sessions.set(id, context);
  }

  const setCookie = isNew
    ? `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`
    : undefined;

  return {
    id,
    context,
    setCookie,
  };
}

function sessionHeaders(handle: SessionHandle): HeadersInit | undefined {
  if (!handle.setCookie) {
    return undefined;
  }
  return {
    "Set-Cookie": handle.setCookie,
  };
}

async function disconnectSessionClient(context: SessionContext): Promise<void> {
  if (!context.client) {
    return;
  }
  try {
    await context.client.disconnect();
  } catch (error) {
    logger.error({ error }, "failed to disconnect session client");
  }
  context.client = undefined;
}

function ensureSessionClient(context: SessionContext): CashubashClient | null {
  const pubkey = context.serverPubkey?.trim();
  if (!pubkey) {
    return null;
  }
  if (context.client) {
    return context.client;
  }
  try {
    context.client = createCashubashClient(pubkey);
    return context.client;
  } catch (error) {
    logger.error({ error }, "failed to create session client");
    context.client = undefined;
    context.serverPubkey = undefined;
    return null;
  }
}

async function start() {
  const envPortRaw = Bun.env.PORT ?? process.env.PORT ?? null;
  const preferredPort = (() => {
    if (!envPortRaw) {
      return null;
    }
    const parsed = Number.parseInt(envPortRaw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
      logger.error({ envPortRaw }, "Invalid PORT value provided, falling back to auto selection");
      return null;
    }
    return parsed;
  })();

  const port = preferredPort ?? (await findAvailablePort(41000));
  const basePrefix = `/${port}`;

  const assetDir = path.join(srcDir, "..", "tmp", "public");
  ensureDirectory(assetDir);

  const buildResult = await Bun.build({
    entrypoints: [path.join(srcDir, "wallet-frontend.ts")],
    outdir: assetDir,
    target: "browser",
    splitting: false,
    format: "esm",
  });

  if (!buildResult.success) {
    logger.error({ errors: buildResult.logs }, "Failed to build frontend bundle");
    throw new Error("Failed to compile wallet frontend");
  }

  const walletHtmlPath = path.join(srcDir, "wallet.html");
  const walletHtml = await Bun.file(walletHtmlPath).text();

  const context: ServeContext = {
    basePrefix,
    walletHtml,
    assetDir,
  };

  const server = Bun.serve({
    port,
    development: false,
    reusePort: false,
    error(err) {
      logger.error({ err }, "server error");
      return new Response("Internal Server Error", { status: 500 });
    },
    fetch(request) {
      return handleRequest(request, context);
    },
  });

  logger.info({ port: server.port }, `8Bit Cashubash wallet ready on port ${server.port}`);
  console.log(`[WINGMAN21-URL]https://host.otherstuff.ai/${server.port}`);

  await once(process, "SIGTERM");
  logger.info(undefined, "Received SIGTERM, shutting down.");
  server.stop();
  logger.info(undefined, "Server closed.");
  process.exit(0);
}

async function handleRequest(request: Request, context: ServeContext): Promise<Response> {
  const url = new URL(request.url);
  const { basePrefix, walletHtml, assetDir } = context;

  if (url.pathname === basePrefix) {
    return new Response(null, {
      status: 302,
      headers: {
        Location: `${basePrefix}/`,
      },
    });
  }

  const prefixed = url.pathname.startsWith(`${basePrefix}/`);
  let normalizedPath = prefixed ? url.pathname.slice(basePrefix.length) : url.pathname;
  if (normalizedPath === "") {
    normalizedPath = "/";
  }
  if (!normalizedPath.startsWith("/")) {
    normalizedPath = `/${normalizedPath}`;
  }

  if (normalizedPath === "/" && request.method === "GET") {
    return htmlResponse(walletHtml);
  }

  if (normalizedPath === "/ui/plain-skin.css" && request.method === "GET") {
    const cssPath = path.join(srcDir, "ui", "plain-skin.css");
    return fileResponse(cssPath);
  }

  if (request.method === "GET") {
    const assetPath = resolveAsset(assetDir, normalizedPath);
    if (assetPath) {
      return fileResponse(assetPath);
    }
  }

  if (normalizedPath === "/favicon.ico") {
    return new Response(null, { status: 204 });
  }

  if (normalizedPath.startsWith("/api/")) {
    const apiResponse = await handleApi(normalizedPath, request);
    if (apiResponse) {
      return apiResponse;
    }
    return new Response("Not Found", { status: 404 });
  }

  return new Response("Not Found", { status: 404 });
}

async function handleApi(pathname: string, request: Request): Promise<Response | null> {
  switch (pathname) {
    case "/api/server-pubkey": {
      if (request.method === "GET") {
        const sessionHandle = ensureSession(request);
        const headers = sessionHeaders(sessionHandle);
        return jsonResponse(
          {
            hasServerPubkey: Boolean(sessionHandle.context.serverPubkey),
            serverPubkey: sessionHandle.context.serverPubkey,
          },
          200,
          headers
        );
      }
      if (request.method === "POST") {
        const sessionHandle = ensureSession(request);
        const headers = sessionHeaders(sessionHandle);
        let payload: { serverPubkey?: string };
        try {
          payload = (await request.json()) as { serverPubkey?: string };
        } catch {
          return badRequest("Invalid JSON body", headers);
        }

        const candidate = payload.serverPubkey;
        if (typeof candidate !== "string") {
          return badRequest("serverPubkey must be a string", headers);
        }

        try {
          const trimmed = candidate.trim();
          if (!trimmed) {
            return badRequest("Server pubkey cannot be empty", headers);
          }

          if (sessionHandle.context.serverPubkey === trimmed) {
            ensureSessionClient(sessionHandle.context);
            return jsonResponse(
              {
                configured: true,
                serverPubkey: sessionHandle.context.serverPubkey,
              },
              200,
              headers
            );
          }

          await disconnectSessionClient(sessionHandle.context);
          sessionHandle.context.serverPubkey = trimmed;
          const client = ensureSessionClient(sessionHandle.context);
          if (!client) {
            sessionHandle.context.serverPubkey = undefined;
            return serviceUnavailable("Failed to configure server pubkey", headers);
          }
          return jsonResponse(
            {
              configured: true,
              serverPubkey: sessionHandle.context.serverPubkey,
            },
            200,
            headers
          );
        } catch (error) {
          logger.error({ error }, "failed to configure server pubkey");
          await disconnectSessionClient(sessionHandle.context);
          sessionHandle.context.serverPubkey = undefined;
          return jsonResponse({ message: "Failed to configure server pubkey" }, 400, headers);
        }
      }
      if (request.method === "DELETE") {
        const sessionHandle = ensureSession(request);
        const headers = sessionHeaders(sessionHandle);
        try {
          await disconnectSessionClient(sessionHandle.context);
        } catch (error) {
          logger.error({ error }, "failed to disconnect session during pubkey reset");
        }
        sessionHandle.context.client = undefined;
        sessionHandle.context.serverPubkey = undefined;
        return jsonResponse({ cleared: true }, 200, headers);
      }
      return jsonResponse({ message: "Method not allowed" }, 405, { Allow: "GET, POST, DELETE" });
    }
    case "/api/balance": {
      if (request.method !== "GET") {
        return jsonResponse({ message: "Method not allowed" }, 405, { Allow: "GET" });
      }
      const sessionHandle = ensureSession(request);
      const headers = sessionHeaders(sessionHandle);
      const client = ensureSessionClient(sessionHandle.context);
      if (!client) {
        return serviceUnavailable("Server pubkey not configured", headers);
      }
      try {
        const { result } = await client.GetBalance({});
        return jsonResponse({ balance: result.balance }, 200, headers);
      } catch (error) {
        logger.error({ error }, "failed to fetch balance");
        return jsonResponse({ message: "Failed to fetch balance" }, 502, headers);
      }
    }
    case "/api/make-invoice": {
      if (request.method !== "POST") {
        return jsonResponse({ message: "Method not allowed" }, 405, { Allow: "POST" });
      }
      const sessionHandle = ensureSession(request);
      const headers = sessionHeaders(sessionHandle);
      let payload: MakeInvoiceBody;
      try {
        payload = (await request.json()) as MakeInvoiceBody;
      } catch {
        return badRequest("Invalid JSON body", headers);
      }
      if (typeof payload.amount !== "number" || !Number.isFinite(payload.amount) || payload.amount <= 0) {
        return badRequest("Amount must be a positive number", headers);
      }
      const client = ensureSessionClient(sessionHandle.context);
      if (!client) {
        return serviceUnavailable("Server pubkey not configured", headers);
      }
      try {
        const { result } = await client.MakeInvoice(
          payload.amount,
          payload.description,
          undefined,
          payload.expiry
        );
        return jsonResponse(
          {
            invoice: result.invoice,
            amount: result.amount,
            expiresAt: result.expires_at,
          },
          200,
          headers
        );
      } catch (error) {
        logger.error({ error }, "failed to make invoice");
        return jsonResponse({ message: "Failed to make invoice" }, 502, headers);
      }
    }
    case "/api/pay-invoice": {
      if (request.method !== "POST") {
        return jsonResponse({ message: "Method not allowed" }, 405, { Allow: "POST" });
      }
      const sessionHandle = ensureSession(request);
      const headers = sessionHeaders(sessionHandle);
      let payload: PayInvoiceBody;
      try {
        payload = (await request.json()) as PayInvoiceBody;
      } catch {
        return badRequest("Invalid JSON body", headers);
      }
      if (!payload.invoice) {
        return badRequest("Invoice is required", headers);
      }
      const amount = payload.amount;
      if (typeof amount === "number" && (!Number.isFinite(amount) || amount <= 0)) {
        return badRequest("Amount override must be positive", headers);
      }
      const client = ensureSessionClient(sessionHandle.context);
      if (!client) {
        return serviceUnavailable("Server pubkey not configured", headers);
      }
      try {
        const { result } = await client.PayInvoice(payload.invoice, amount);
        return jsonResponse(
          {
            preimage: result.preimage,
            feesPaid: result.fees_paid,
          },
          200,
          headers
        );
      } catch (error) {
        logger.error({ error }, "failed to pay invoice");
        return jsonResponse({ message: "Failed to pay invoice" }, 502, headers);
      }
    }
    case "/api/send-ecash": {
      if (request.method !== "POST") {
        return jsonResponse({ message: "Method not allowed" }, 405, { Allow: "POST" });
      }
      const sessionHandle = ensureSession(request);
      const headers = sessionHeaders(sessionHandle);
      let payload: SendEcashBody;
      try {
        payload = (await request.json()) as SendEcashBody;
      } catch {
        return badRequest("Invalid JSON body", headers);
      }
      if (typeof payload.amount !== "number" || !Number.isFinite(payload.amount) || payload.amount <= 0) {
        return badRequest("Amount must be a positive number", headers);
      }
      const client = ensureSessionClient(sessionHandle.context);
      if (!client) {
        return serviceUnavailable("Server pubkey not configured", headers);
      }
      try {
        const result = await client.SendEcash(payload.amount);
        return jsonResponse(
          {
            cashuToken: result.cashuToken,
            sentAmount: result.sentAmount,
            keepAmount: result.keepAmount,
            proofCount: result.proofCount,
            timestamp: result.timestamp,
          },
          200,
          headers
        );
      } catch (error) {
        logger.error({ error }, "failed to send ecash");
        return jsonResponse({ message: "Failed to mint ecash" }, 502, headers);
      }
    }
    default:
      return null;
  }
}

start().catch((error) => {
  logger.error({ err: error }, "Failed to start server");
  process.exit(1);
});
