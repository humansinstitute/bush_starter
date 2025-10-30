import { Client } from "@modelcontextprotocol/sdk/client";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  NostrClientTransport,
  type NostrTransportOptions,
  PrivateKeySigner,
  ApplesauceRelayPool,
} from "@contextvm/sdk";

export type GetBalanceInput = Record<string, unknown>;

export interface GetBalanceOutput {
  result_type: "get_balance";
  result: {
    balance: number;
  };
}

export interface PayInvoiceInput {
  invoice: string;
  amount?: number;
}

export interface PayInvoiceOutput {
  result_type: "pay_invoice";
  result: {
    preimage: string;
    fees_paid: number;
  };
}

export interface MakeInvoiceInput {
  amount: number;
  description?: string;
  description_hash?: string;
  expiry?: number;
}

export interface MakeInvoiceOutput {
  result_type: "make_invoice";
  result: {
    type: "incoming";
    state: "pending";
    invoice: string;
    description: string;
    description_hash: string;
    payment_hash: string;
    amount: number;
    created_at: number;
    expires_at: number;
  };
}

export interface SendEcashInput {
  amount: number;
}

export interface SendEcashOutput {
  sentAmount: number;
  keepAmount: number;
  cashuToken: string;
  proofCount: number;
  timestamp: string;
}

export interface LookupInvoiceInput {
  payment_hash?: string;
}

export interface LookupInvoiceOutput {
  result_type: "lookup_invoice";
  result: {
    isPaid: boolean;
    isIssued: boolean;
    payment_hash: string;
    amount: number;
  };
}

export type GetInfoInput = Record<string, unknown>;

export interface GetInfoOutput {
  result_type: "get_info";
  result: {
    methods: string[];
    info: {
      name: string;
      picture?: string;
      about?: string;
      nip05?: string;
      lud16?: string;
    };
    supported_methods: string[];
    max_amount: number;
    min_amount: number;
    currencies: string[];
    callback?: string;
    tag?: string;
    metadata?: string[][];
    max_sendable?: number;
    min_sendable?: number;
  };
}

export type Cashubash = {
  GetBalance: (args: GetBalanceInput) => Promise<GetBalanceOutput>;
  PayInvoice: (invoice: string, amount?: number) => Promise<PayInvoiceOutput>;
  MakeInvoice: (amount: number, description?: string, description_hash?: string, expiry?: number) => Promise<MakeInvoiceOutput>;
  SendEcash: (amount: number) => Promise<SendEcashOutput>;
  LookupInvoice: (payment_hash?: string) => Promise<LookupInvoiceOutput>;
  GetInfo: (args: GetInfoInput) => Promise<GetInfoOutput>;
};

export class CashubashClient implements Cashubash {
  static readonly DEFAULT_MINT_URL = "https://mint.minibits.cash/Bitcoin";
  private static normalizeMintUrl(mintUrl?: string): string {
    const trimmed = mintUrl?.trim();
    if (!trimmed) {
      return CashubashClient.DEFAULT_MINT_URL;
    }

    try {
      // Validate URL format, will throw if invalid
      void new URL(trimmed);
      return trimmed;
    } catch {
      console.warn(
        `[CashubashClient] Provided MINT_URL is invalid ("${trimmed}"), falling back to default mint`
      );
      return CashubashClient.DEFAULT_MINT_URL;
    }
  }

  static readonly SERVER_PUBKEY: string =
    process.env.SERVER_PUBKEY;
  static readonly MINT_URL = CashubashClient.normalizeMintUrl(process.env.MINT_URL);
  private client: Client;
  private transport: Transport;

  constructor(
    options: Partial<NostrTransportOptions> & { privateKey?: string; relays?: string[] } = {}
  ) {
    this.client = new Client({
      name: "CashubashClient",
      version: "1.0.0",
    });

    const {
      privateKey,
      relays = ["wss://relay.contextvm.org"],
      signer = new PrivateKeySigner(privateKey || ""),
      relayHandler = new ApplesauceRelayPool(relays),
 			serverPubkey = CashubashClient.SERVER_PUBKEY,
      ...rest
    } = options;

    console.info("[CashubashClient] Using relays:", relays);
    console.info("[CashubashClient] Target server pubkey:", serverPubkey ?? "(not provided)");

    this.transport = new NostrClientTransport({
      serverPubkey,
      signer,
      relayHandler,
      isStateless: true,
      ...rest,
    });

    // Auto-connect in constructor
    this.client.connect(this.transport).catch((error) => {
      console.error(`Failed to connect to server: ${error}`);
    });
  }

  async disconnect(): Promise<void> {
    await this.transport.close();
  }

  private async call<T = unknown>(
    name: string,
    args: Record<string, unknown>
  ): Promise<T> {
    const result = await this.client.callTool({
      name,
      arguments: { ...args },
    });
    return result.structuredContent as T;
  }

    /**
   * Get wallet balance in NWC API format
   * @returns {Promise<GetBalanceOutput>} The result of the get_balance operation
   */
  async GetBalance(
    args: GetBalanceInput
  ): Promise<GetBalanceOutput> {
    return this.call("get_balance", args);
  }

    /**
   * Pay a Lightning invoice in NWC API format
   * @param {string} invoice The invoice parameter
   * @param {number} amount [optional] The amount parameter
   * @returns {Promise<PayInvoiceOutput>} The result of the pay_invoice operation
   */
  async PayInvoice(
    invoice: string, amount?: number
  ): Promise<PayInvoiceOutput> {
    return this.call("pay_invoice", { invoice, amount });
  }

    /**
   * Create a Lightning invoice in NWC API format
   * @param {number} amount The amount parameter
   * @param {string} description [optional] The description parameter
   * @param {string} description_hash [optional] The description_hash parameter
   * @param {number} expiry [optional] The expiry parameter
   * @returns {Promise<MakeInvoiceOutput>} The result of the make_invoice operation
   */
  async MakeInvoice(
    amount: number, description?: string, description_hash?: string, expiry?: number
  ): Promise<MakeInvoiceOutput> {
    return this.call("make_invoice", { amount, description, description_hash, expiry });
  }

    /**
   * Create an eCash token
   * @param {number} amount The amount parameter
   * @returns {Promise<SendEcashOutput>} The result of the send_ecash operation
   */
  async SendEcash(
    amount: number
  ): Promise<SendEcashOutput> {
    const payload: Record<string, unknown> = { amount };
    if (CashubashClient.MINT_URL) {
      payload.mint_url = CashubashClient.MINT_URL;
    }
    return this.call("send_ecash", payload);
  }

    /**
   * Lookup invoice status in NWC API format - Use 'payment_hash' together with the quoteId to lookup a specific mint quote
   * @param {string} payment_hash [optional] The payment_hash parameter
   * @returns {Promise<LookupInvoiceOutput>} The result of the lookup_invoice operation
   */
  async LookupInvoice(
    payment_hash?: string
  ): Promise<LookupInvoiceOutput> {
    return this.call("lookup_invoice", { payment_hash });
  }

    /**
   * Get wallet information in NWC API format
   * @returns {Promise<GetInfoOutput>} The result of the get_info operation
   */
  async GetInfo(
    args: GetInfoInput
  ): Promise<GetInfoOutput> {
    return this.call("get_info", args);
  }
}

/**
 * Default singleton instance of CashubashClient.
 * This instance uses the default configuration and can be used directly
 * without creating a new instance.
 *
 * @example
 * import { createCashubashClient } from './CashubashClient';
 * const client = createCashubashClient();
 * const result = await client.SomeMethod();
 */
export function hasDefaultServerPubkey(): boolean {
  return typeof CashubashClient.SERVER_PUBKEY === "string" && CashubashClient.SERVER_PUBKEY.trim().length > 0;
}

export function getDefaultServerPubkey(): string | undefined {
  const configured = CashubashClient.SERVER_PUBKEY?.trim();
  return configured ? configured : undefined;
}

export function createCashubashClient(serverPubkey?: string): CashubashClient {
  const candidate = serverPubkey?.trim() || getDefaultServerPubkey();
  if (!candidate) {
    throw new Error("SERVER_PUBKEY is not configured");
  }
  return new CashubashClient({ serverPubkey: candidate });
}
