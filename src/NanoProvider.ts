import type { PaymentPayload } from '@x402/core/types';

// Nano (XNO) is the fee-free, instant rail of the Nano network. Unlike EVM or
// Solana it has no gas, no token accounts and no facilitator role: a settlement
// is a single confirmed block that moves raw XNO from one account to another.
// That makes it the cheapest possible x402 settlement — nothing for the buyer
// to fund beyond the price itself, and nothing for the merchant to run to settle.

export interface NanoPaymentRequirement {
  scheme: 'exact';
  network: 'nano:mainnet' | 'nano:nano-test-network';
  amount: string; // integer raw XNO, 30 decimals
  asset: 'XNO';
  payTo: string; // receive-only nano_... address (no private key needed)
  maxTimeoutSeconds: number;
  extra: {
    name: 'Nano';
    version: '2';
    work: 'required';
  };
}

export interface NanoVerifyResult {
  isValid: boolean;
  payer?: string;
  blockHash?: string;
  invalidReason?: string;
}

export interface NanoSettleResult {
  success: boolean;
  transaction?: string;
  network: string;
  payer?: string;
  errorReason?: string;
}

export const NANO_RAW_PER_XNO = 1_000_000_000_000_000_000_000_000_000_000; // 1 XNO = 1e30 raw

const DEFAULT_MAX_TIMEOUT_SECONDS = 600;

// Both Nano networks use the same address alphabet but different network
// prefix; this maps a CAIP-2-like network value to a Nano RPC node.
const NANO_NETWORKS = ['nano:mainnet', 'nano:nano-test-network'] as const;
export type NanoNetwork = (typeof NANO_NETWORKS)[number];

/**
 * Convert a decimal XNO amount (e.g. 0.001) into integer raw units (1e27).
 * Preserves the 30-decimal denomination used across Nano tooling. Uses the
 * shortest round-trip decimal of the number (String(x)) then scales by 1e30
 * with exact integer digit arithmetic, so 0.1 -> 1e29 raw exactly.
 */
export function xnoToRaw(xno: number): string {
  if (!Number.isFinite(xno) || xno < 0) {
    throw new Error(`Invalid Nano amount: ${xno}`);
  }
  if (xno === 0) return '0';

  const str = String(xno); // shortest round-trip decimal, no exponent for < 1e21
  const [whole = '0', frac = ''] = str.split('.');
  const intPart = whole.replace(/^0+(?=\d)/, '') || '0';
  const scaled = intPart + frac.padEnd(30, '0');
  return scaled.replace(/^0+(?=\d)/, '') || '0';
}

/**
 * Convert integer raw XNO back to a decimal XNO value, for display/logging.
 */
export function rawToXno(raw: string | bigint): number {
  return Number(raw) / NANO_RAW_PER_XNO;
}

function isNanoPayTo(address: string): boolean {
  return (
    (address.startsWith('nano_') || address.startsWith('xrb_')) &&
    address.includes('_') &&
    address.split('_').pop()!.length >= 60
  );
}

export interface NanoProviderOptions {
  payToAddress: string;
  network: string; // 'nano:mainnet' | 'nano:nano-test-network' | 'nano'
  price: number; // in XNO
  rpcUrl?: string; // default rpc.nano.to
  fetchFn?: typeof fetch; // injectable for testing
}

/**
 * Merchant-side provider for settling x402 payments in Nano (XNO).
 *
 * Cost model: the buyer sends raw XNO to a receive-only nano_ address; the
 * block confirming that transfer is the settlement, so verify and settle are
 * the same check with no facilitator and no second on-chain step.
 */
export class NanoProvider {
  private readonly payTo: string;
  private readonly network: NanoNetwork;
  private readonly priceXno: number;
  private readonly rpcUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: NanoProviderOptions) {
    if (!isNanoPayTo(options.payToAddress)) {
      throw new Error(
        `payToAddress must be a nano_ (or xrb_) receive address, got: ${options.payToAddress}`
      );
    }
    this.payTo = options.payToAddress;
    // Accept the bare "nano" shorthand as mainnet, and reject unknown values.
    const normalized =
      options.network === 'nano'
        ? 'nano:mainnet'
        : options.network;
    if (!NANO_NETWORKS.includes(normalized as NanoNetwork)) {
      throw new Error(
        `Unknown Nano network "${options.network}". Use "nano:mainnet" or "nano:nano-test-network".`
      );
    }
    this.network = normalized as NanoNetwork;
    this.priceXno = options.price;
    this.rpcUrl = options.rpcUrl || 'https://rpc.nano.to';
    this.fetchFn = options.fetchFn || fetch;
  }

  /** Build the x402 v2 payment requirement for Nano. */
  buildRequirements(): NanoPaymentRequirement {
    return {
      scheme: 'exact',
      network: this.network,
      amount: xnoToRaw(this.priceXno),
      asset: 'XNO',
      payTo: this.payTo,
      maxTimeoutSeconds: DEFAULT_MAX_TIMEOUT_SECONDS,
      extra: {
        name: 'Nano',
        version: '2',
        work: 'required',
      },
    };
  }

  /** The HTTP 402 response body shape the server returns while unpaid. */
  createPaymentRequiredResponse() {
    return {
      x402Version: 2,
      accepts: [this.buildRequirements()],
      error: 'Payment required for service: /process-request',
      resource: {
        description: 'AI request processing service',
        mimeType: 'application/json',
      },
    };
  }

  private async rpc(action: 'account_history' | 'block_info', body: object): Promise<any> {
    const response = await this.fetchFn(this.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...body }),
    });
    if (!response.ok) {
      throw new Error(`Nano RPC ${action} failed (${response.status})`);
    }
    return response.json();
  }

  /**
   * Confirm that a paid Nano block with the exact required amount reached the
   * merchant address. The confirmation is the settlement, so this doubles as
   * the settle check.
   */
  async confirmPayment(
    expectedAmountRaw: string
  ): Promise<NanoVerifyResult> {
    try {
      const history = await this.rpc('account_history', {
        account: this.payTo,
        count: '20',
        raw: 'false',
      });

      const blocks = Array.isArray(history?.history) ? history.history : [];
      if (blocks.length === 0) {
        return {
          isValid: false,
          invalidReason: 'No Nano blocks found for the merchant account',
        };
      }

      // account_history returns confirmed blocks in newest-first order. Look
      // for a receive block matching the exact amount we asked for.
      const requiredBig = BigInt(expectedAmountRaw);
      const matched = blocks.find((b: any) => {
        if (!b || b.type !== 'receive') return false;
        // Incoming amounts are the raw value in the "amount" field.
        const amount = BigInt(b.amount || 0);
        return amount === requiredBig;
      });

      if (!matched) {
        return {
          isValid: false,
          invalidReason: `No confirmed Nano receive block of exactly ${expectedAmountRaw} raw found`,
        };
      }

      // Ensure the payment was sent to our address.
      if (matched.account && matched.account !== this.payTo) {
        return {
          isValid: false,
          invalidReason: 'Nano block destination does not match merchant address',
        };
      }

      return {
        isValid: true,
        payer: matched.source,
        blockHash: matched.hash,
      };
    } catch (error) {
      return {
        isValid: false,
        invalidReason:
          error instanceof Error ? error.message : 'Nano RPC error',
      };
    }
  }

  /** For Nano the payment is settled the moment the confirmed block exists. */
  async settle(expectedAmountRaw: string): Promise<NanoSettleResult> {
    const check = await this.confirmPayment(expectedAmountRaw);
    if (!check.isValid) {
      return {
        success: false,
        network: this.network,
        errorReason: check.invalidReason,
      };
    }
    return {
      success: true,
      transaction: check.blockHash,
      network: this.network,
      payer: check.payer,
    };
  }
}

export type { PaymentPayload };
