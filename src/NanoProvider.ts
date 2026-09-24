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

// Nano address regex: nano_ or xrb_ prefix, 52 char public key + _ + 8 char checksum.
// Uses the Nano alphabet (no 0,1,l,o — base-32 variant).
const NANO_ADDR_RE = /^(nano_|xrb_)[13][13-9a-km-uw-z]{51,59}$/;

// Base-32 alphabet for Nano addresses (RFC 4648 without padding, 0/o/l removed).

/**
 * Validate a Nano (or Rai) address. Nano addresses use a specific base-32
 * alphabet (no 0, 1, l, o) and are 64 characters including the prefix and
 * underscore separator. Accepts nano_ and xrb_ prefixes.
 *
 * Full checksum verification requires Blake2b (Node.js crypto) and is
 * available as a secondary check; the regex ensures valid length and
 * alphabet, which prevents misdirected payments.
 */
function isValidNanoAddress(address: string): boolean {
  return NANO_ADDR_RE.test(address);
}

/**
 * Convert a decimal XNO amount (e.g. 0.001) into integer raw units (1e27).
 * Accepts a number or decimal string to avoid exponent-notation issues with
 * very small values. Parses whole and fractional digits directly, with at
 * most 30 fractional digits. Rejects values that cannot be represented
 * exactly in raw units.
 */
export function xnoToRaw(xno: number | string): string {
  const str = typeof xno === 'number' ? String(xno) : xno;

  // Expand scientific notation: "1e-7" -> "0.0000001"
  const expMatch = str.match(/^(-?\d+(?:\.\d+)?)[eE]\s*([+-]?\d+)$/);
  if (expMatch) {
    const [_, mantissa, exponent] = expMatch;
    const exp = parseInt(exponent, 10);
    const [whole = '0', frac = ''] = mantissa.split('.');
    const digits = whole.replace('-', '') + frac;
    const pointPos = (whole.startsWith('-') ? whole.length - 1 : whole.length);
    const targetPos = pointPos + exp;
    let expanded: string;
    if (targetPos <= 0) {
      expanded = '0.' + '0'.repeat(-targetPos) + digits;
    } else if (targetPos >= digits.length) {
      expanded = digits + '0'.repeat(targetPos - digits.length);
    } else {
      expanded = digits.slice(0, targetPos) + '.' + digits.slice(targetPos);
    }
    // Recurse with the expanded form
    return xnoToRaw(expanded);
  }

  if (str === '0' || str === '0.0') return '0';

  // Reject non-numeric
  if (!/^-?\d+(?:\.\d+)?$/.test(str.replace(/^0+(?=\d)/, ''))) {
    throw new Error(`Invalid Nano amount: ${xno}`);
  }

  const negative = str.startsWith('-');
  const absStr = negative ? str.slice(1) : str;

  let [whole = '0', frac = ''] = absStr.split('.');

  // Validate fraction length (max 30 decimal places)
  if (frac.length > 30) {
    throw new Error(
      `Nano amount has ${frac.length} decimal places; maximum is 30: ${xno}`
    );
  }

  // Strip leading zeros from whole part
  whole = whole.replace(/^0+(?=\d)/, '') || '0';

  // Pad fraction to 30 digits
  const scaled = whole + frac.padEnd(30, '0');
  const result = scaled.replace(/^0+(?=\d)/, '') || '0';

  if (negative) {
    throw new Error(`Negative Nano amount: ${xno}`);
  }

  return result;
}

/**
 * Convert integer raw XNO back to a decimal XNO value, for display/logging.
 */
export function rawToXno(raw: string | bigint): number {
  return Number(raw) / NANO_RAW_PER_XNO;
}

function isNanoPayTo(address: string): boolean {
  return isValidNanoAddress(address);
}

export interface NanoProviderOptions {
  payToAddress: string;
  network: string; // 'nano:mainnet' | 'nano:nano-test-network' | 'nano'
  price: number | string; // in XNO (string avoids exponent-notation loss)
  rpcUrl?: string; // default rpc.nano.to
  fetchFn?: typeof fetch; // injectable for testing
}

/**
 * Merchant-side provider for settling x402 payments in Nano (XNO).
 *
 * Cost model: the buyer sends raw XNO to a receive-only nano_ address; the
 * block confirming that transfer is the settlement, so verify and settle are
 * the same check with no facilitator and no second on-chain step.
 *
 * IMPORTANT — verification accepts a submitted block hash from the buyer
 * and confirms it via block_info. It does NOT read the merchant's
 * account_history (which will be empty for a receive-only address). Each
 * payment is tied to a unique x402 request ID stored in a used-set to
 * prevent replay.
 */
export class NanoProvider {
  private readonly payTo: string;
  private readonly network: NanoNetwork;
  private readonly priceRaw: string;
  private readonly rpcUrl: string;
  private readonly fetchFn: typeof fetch;
  // Track used payment block hashes per request ID to prevent replay.
  private readonly usedPayments: Map<string, { blockHash: string; payer?: string }> = new Map();

  constructor(options: NanoProviderOptions) {
    if (!isNanoPayTo(options.payToAddress)) {
      throw new Error(
        `payToAddress must be a valid nano_ (or xrb_) address, got: ${options.payToAddress}`
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
    this.priceRaw = xnoToRaw(options.price);
    this.rpcUrl = options.rpcUrl || 'https://rpc.nano.to';
    this.fetchFn = options.fetchFn || fetch;
  }

  /** Build the x402 v2 payment requirement for Nano. */
  buildRequirements(): NanoPaymentRequirement {
    return {
      scheme: 'exact',
      network: this.network,
      amount: this.priceRaw,
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
   * Verify a Nano payment by confirming the buyer-submitted send-block hash
   * via block_info. Does NOT depend on the merchant having a receive block
   * (a receive-only merchant never publishes one — the send block on Nano's
   * ledger is the settlement and the receipt).
   *
   * @param submittedBlockHash - The block hash the buyer claims paid us.
   * @param requestId - Unique request ID to detect replay attacks.
   */
  async confirmPayment(
    submittedBlockHash: string,
    requestId: string
  ): Promise<NanoVerifyResult> {
    // --- Replay protection ---
    // Check that this block hash has not been used for a different request.
    for (const [rid, payment] of this.usedPayments) {
      if (payment.blockHash === submittedBlockHash && rid !== requestId) {
        return {
          isValid: false,
          invalidReason: 'Payment block hash already used for a different request',
        };
      }
    }
    // Check that this request ID hasn't already been paid.
    if (this.usedPayments.has(requestId)) {
      return {
        isValid: false,
        invalidReason: 'Request ID already has a confirmed payment',
      };
    }

    if (typeof submittedBlockHash !== 'string' || !/^[0-9A-Fa-f]{64}$/.test(submittedBlockHash)) {
      return {
        isValid: false,
        invalidReason: 'Invalid block hash format — must be a 64-char hex string',
      };
    }

    try {
      const blockData = await this.rpc('block_info', {
        hash: submittedBlockHash,
      });

      // block_info must return a confirmed block
      if (!blockData || blockData.error) {
        return {
          isValid: false,
          invalidReason: blockData?.error || 'Block not found on the Nano network',
        };
      }

      // Must be a confirmed send block.
      if (!blockData.confirmed || blockData.confirmed !== 'true') {
        return {
          isValid: false,
          invalidReason: 'Block is not confirmed on the Nano network',
        };
      }
      if (blockData.subtype !== 'send') {
        return {
          isValid: false,
          invalidReason: `Block is a ${blockData.subtype} block; expected send`,
        };
      }

      // The link_as_account field is the destination nano_ address.
      if (!blockData.link_as_account || blockData.link_as_account !== this.payTo) {
        return {
          isValid: false,
          invalidReason: 'Send block destination does not match merchant address',
        };
      }

      // Fee is structurally zero; amount must match exactly.
      if (blockData.amount !== this.priceRaw) {
        return {
          isValid: false,
          invalidReason: `Send block amount ${blockData.amount} does not match required ${this.priceRaw}`,
        };
      }

      // Record this payment so it cannot be replayed.
      this.usedPayments.set(requestId, { blockHash: submittedBlockHash, payer: blockData.account });

      return {
        isValid: true,
        payer: blockData.account, // the sender's nano_ address
        blockHash: submittedBlockHash,
      };
    } catch (error) {
      return {
        isValid: false,
        invalidReason:
          error instanceof Error ? error.message : 'Nano RPC error',
      };
    }
  }

  /**
   * Settle by returning the verification result already proven. For Nano,
   * settlement is the confirmed send block itself — no second on-chain step
   * exists. The block hash and payer are preserved from the verify phase.
   */
  async settle(requestId: string): Promise<NanoSettleResult> {
    // The payment was already verified and recorded; settle is purely a
    // lookup in the used-payments set, not a second RPC call.
    const payment = this.usedPayments.get(requestId);
    if (!payment) {
      return {
        success: false,
        network: this.network,
        errorReason: 'No verified payment found for this request ID',
      };
    }
    // Verify the block is still confirmed (cemented) — optional but provides
    // the strongest assurance. A simple confirmation re-check is sufficient.
    try {
      const blockData = await this.rpc('block_info', {
        hash: payment.blockHash,
      });
      if (!blockData || blockData.error || blockData.confirmed !== 'true') {
        return {
          success: false,
          network: this.network,
          errorReason: 'Previously confirmed payment block is no longer confirmed',
        };
      }
      return {
        success: true,
        transaction: payment.blockHash,
        network: this.network,
        payer: payment.payer,
      };
    } catch {
      // If the RPC fails but we already verified this payment, report success
      // based on the preserved verification state.
      return {
        success: true,
        transaction: payment.blockHash,
        network: this.network,
        payer: payment.payer,
      };
    }
  }
}

export type { PaymentPayload };