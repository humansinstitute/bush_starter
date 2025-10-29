import { once } from "node:events";
import net from "node:net";
import walletHtml from "./wallet.html";
import { cashubash } from "./ctxcn/CashubashClient.ts";

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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function badRequest(message: string): Response {
  logger.error({ message }, "bad request");
  return jsonResponse({ message }, 400);
}

async function start() {
  const port = await findAvailablePort(4000);
  const server = Bun.serve({
    port,
    routes: {
      "/": walletHtml,
      "/api/balance": {
        GET: async () => {
          try {
            const { result } = await cashubash.GetBalance({});
            return jsonResponse({ balance: result.balance });
          } catch (error) {
            logger.error({ error }, "failed to fetch balance");
            return jsonResponse({ message: "Failed to fetch balance" }, 502);
          }
        },
      },
      "/api/make-invoice": {
        POST: async (request: Request) => {
          let payload: MakeInvoiceBody;
          try {
            payload = (await request.json()) as MakeInvoiceBody;
          } catch {
            return badRequest("Invalid JSON body");
          }
          if (typeof payload.amount !== "number" || !Number.isFinite(payload.amount) || payload.amount <= 0) {
            return badRequest("Amount must be a positive number");
          }
          try {
            const { result } = await cashubash.MakeInvoice(
              payload.amount,
              payload.description,
              undefined,
              payload.expiry
            );
            return jsonResponse({
              invoice: result.invoice,
              amount: result.amount,
              expiresAt: result.expires_at,
            });
          } catch (error) {
            logger.error({ error }, "failed to make invoice");
            return jsonResponse({ message: "Failed to make invoice" }, 502);
          }
        },
      },
      "/api/pay-invoice": {
        POST: async (request: Request) => {
          let payload: PayInvoiceBody;
          try {
            payload = (await request.json()) as PayInvoiceBody;
          } catch {
            return badRequest("Invalid JSON body");
          }
          if (!payload.invoice) {
            return badRequest("Invoice is required");
          }
          const amount = payload.amount;
          if (typeof amount === "number" && (!Number.isFinite(amount) || amount <= 0)) {
            return badRequest("Amount override must be positive");
          }
          try {
            const { result } = await cashubash.PayInvoice(payload.invoice, amount);
            return jsonResponse({
              preimage: result.preimage,
              feesPaid: result.fees_paid,
            });
          } catch (error) {
            logger.error({ error }, "failed to pay invoice");
            return jsonResponse({ message: "Failed to pay invoice" }, 502);
          }
        },
      },
      "/api/send-ecash": {
        POST: async (request: Request) => {
          let payload: SendEcashBody;
          try {
            payload = (await request.json()) as SendEcashBody;
          } catch {
            return badRequest("Invalid JSON body");
          }
          if (typeof payload.amount !== "number" || !Number.isFinite(payload.amount) || payload.amount <= 0) {
            return badRequest("Amount must be a positive number");
          }
          try {
            const result = await cashubash.SendEcash(payload.amount);
            return jsonResponse({
              cashuToken: result.cashuToken,
              sentAmount: result.sentAmount,
              keepAmount: result.keepAmount,
              proofCount: result.proofCount,
              timestamp: result.timestamp,
            });
          } catch (error) {
            logger.error({ error }, "failed to send ecash");
            return jsonResponse({ message: "Failed to mint ecash" }, 502);
          }
        },
      },
    },
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
