import { randomUUID } from "node:crypto";
import { once } from "node:events";
import net from "node:net";
import walletHtml from "./wallet.html";
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

type RouteHandler = (request: Request) => Response | Promise<Response>;

type RouteEntry =
  | Response
  | {
      GET?: RouteHandler;
      POST?: RouteHandler;
      DELETE?: RouteHandler;
    };

function createPrefixedRoutes(routes: Record<string, RouteEntry>, basePath: string): Record<string, RouteEntry> {
  const result: Record<string, RouteEntry> = {};
  const normalizedBase = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
  const trailingBase = `${normalizedBase}/`;

  result[normalizedBase] = new Response(null, {
    status: 302,
    headers: {
      Location: trailingBase,
    },
  });

  for (const [path, entry] of Object.entries(routes)) {
    if (path === "/") {
      result[trailingBase] = entry;
      continue;
    }

    const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
    result[`${trailingBase}${normalizedPath}`] = entry;
  }

  return result;
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
  const port = await findAvailablePort(41000);
  const basePath = `/${port}`;

  const baseRoutes: Record<string, RouteEntry> = {
    "/": walletHtml,
    "/api/server-pubkey": {
      GET: (request: Request) => {
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
      },
      POST: async (request: Request) => {
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
      },
      DELETE: async (request: Request) => {
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
      },
    },
    "/api/balance": {
      GET: async (request: Request) => {
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
      },
    },
    "/api/make-invoice": {
      POST: async (request: Request) => {
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
      },
    },
    "/api/pay-invoice": {
      POST: async (request: Request) => {
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
      },
    },
    "/api/send-ecash": {
      POST: async (request: Request) => {
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
      },
    },
  };

  const routesWithBasePath = {
    ...baseRoutes,
    ...createPrefixedRoutes(baseRoutes, basePath),
  };

  const server = Bun.serve({
    port,
    routes: routesWithBasePath,
    error(err) {
      logger.error({ err }, "server error");
      return new Response("Internal Server Error", { status: 500 });
    },
    development: {
      hmr: true,
      console: true,
    },
    reusePort: false,
  });

  logger.info({ port: server.port }, `8Bit Cashubash wallet ready on port ${server.port}`);
  console.log(`[WINGMAN21-URL]https://host.otherstuff.ai/${server.port}`);

  await once(process, "SIGTERM");
  logger.info(undefined, "Received SIGTERM, shutting down.");
  server.stop();
  logger.info(undefined, "Server closed.");
  process.exit(0);
}

start().catch((error) => {
  logger.error({ err: error }, "Failed to start server");
  process.exit(1);
});
