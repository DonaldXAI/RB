import type { ParsedTransactionMeta, ParsedTransactionWithMeta } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import { config, MAINNET_USDC_MINT, solanaConnection, USDC_DECIMALS } from "../config.js";

export type TransferCheck = {
  verified: boolean;
  senderWallet?: string;
  error?: string;
};

type ExpectedTransfer = {
  destinationWallet: string;
  minAmountUsdc: number;
};

type BatchTransfer = {
  destinationWallet: string;
  netAmountUsdc: number;
};

function usdcRaw(amount: number): bigint {
  return BigInt(Math.round(amount * 10 ** USDC_DECIMALS));
}

function formatRaw(raw: bigint): string {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const scale = 10n ** BigInt(USDC_DECIMALS);
  const whole = abs / scale;
  const fraction = (abs % scale).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  const text = fraction ? `${whole}.${fraction}` : whole.toString();
  return negative ? `-${text}` : text;
}

function usdcDeltas(meta: ParsedTransactionMeta): Map<string, bigint> {
  const summed = (balances: ParsedTransactionMeta["preTokenBalances"]): Map<string, bigint> => {
    const totals = new Map<string, bigint>();
    for (const balance of balances ?? []) {
      if (balance.mint !== MAINNET_USDC_MINT) continue;
      if (!balance.owner) continue;
      const owner = new PublicKey(balance.owner).toBase58();
      const raw = BigInt(balance.uiTokenAmount?.amount ?? "0");
      totals.set(owner, (totals.get(owner) ?? 0n) + raw);
    }
    return totals;
  };

  const pre = summed(meta.preTokenBalances);
  const post = summed(meta.postTokenBalances);
  const deltas = new Map<string, bigint>();
  for (const owner of new Set([...pre.keys(), ...post.keys()])) {
    deltas.set(owner, (post.get(owner) ?? 0n) - (pre.get(owner) ?? 0n));
  }
  return deltas;
}

function senderFrom(deltas: Map<string, bigint>): string | undefined {
  let sender: string | undefined;
  let lowest = 0n;
  for (const [owner, delta] of deltas) {
    if (delta < lowest) {
      lowest = delta;
      sender = owner;
    }
  }
  return sender;
}

async function loadTransaction(txSignature: string): Promise<
  { ok: true; tx: ParsedTransactionWithMeta } | { ok: false; error: string }
> {
  try {
    const tx = await solanaConnection.getParsedTransaction(txSignature, {
      maxSupportedTransactionVersion: 0,
      commitment: "finalized",
    });
    if (!tx) return { ok: false, error: "Transaction not found" };
    if (tx.meta?.err) return { ok: false, error: "Transaction failed on-chain" };
    return { ok: true, tx };
  } catch (error) {
    const message = error instanceof Error ? error.message : "RPC request failed";
    return { ok: false, error: message };
  }
}

/** Verifies a single USDC credit to one wallet (manual split deposits). */
export async function verifyUsdcCredit(
  txSignature: string,
  destinationWallet: string,
  amountUsdc: number,
  exact = true,
): Promise<TransferCheck> {
  if (amountUsdc <= 0) return { verified: true, senderWallet: undefined };
  const loaded = await loadTransaction(txSignature);
  if (!loaded.ok) return { verified: false, error: loaded.error };
  if (!loaded.tx.meta) return { verified: false, error: "Transaction has no balance data" };

  const deltas = usdcDeltas(loaded.tx.meta);
  const senderWallet = senderFrom(deltas);
  let destination: string;
  try {
    destination = new PublicKey(destinationWallet).toBase58();
  } catch {
    return { verified: false, senderWallet, error: "Expected destination is not a public wallet" };
  }
  const received = deltas.get(destination) ?? 0n;
  const expected = usdcRaw(amountUsdc);
  if (exact) {
    if (received !== expected) {
      return {
        verified: false,
        senderWallet,
        error: `${destination} received ${formatRaw(received)} USDC, expected exactly ${amountUsdc}`,
      };
    }
  } else if (received < expected) {
    return {
      verified: false,
      senderWallet,
      error: `${destination} received ${formatRaw(received)} USDC, expected at least ${amountUsdc}`,
    };
  }

  return { verified: true, senderWallet };
}

export async function verifyUsdcTransfer(
  txSignature: string,
  expectedTransfers: ExpectedTransfer[],
): Promise<TransferCheck> {
  const loaded = await loadTransaction(txSignature);
  if (!loaded.ok) return { verified: false, error: loaded.error };
  if (!loaded.tx.meta) return { verified: false, error: "Transaction has no balance data" };

  const deltas = usdcDeltas(loaded.tx.meta);
  const senderWallet = senderFrom(deltas);

  for (const expected of expectedTransfers) {
    if (expected.minAmountUsdc <= 0) continue;
    let destination: string;
    try {
      destination = new PublicKey(expected.destinationWallet).toBase58();
    } catch {
      return { verified: false, senderWallet, error: "Expected destination is not a public wallet" };
    }
    const received = deltas.get(destination) ?? 0n;
    const minimum = usdcRaw(expected.minAmountUsdc);
    if (received < minimum) {
      return {
        verified: false,
        senderWallet,
        error: `${destination} received ${formatRaw(received)} USDC, expected at least ${expected.minAmountUsdc}`,
      };
    }
  }

  return { verified: true, senderWallet };
}

export async function verifyBatchPayoutTx(
  txSignature: string,
  expectedTransfers: BatchTransfer[],
): Promise<TransferCheck> {
  const loaded = await loadTransaction(txSignature);
  if (!loaded.ok) return { verified: false, error: loaded.error };
  if (!loaded.tx.meta) return { verified: false, error: "Transaction has no balance data" };

  const deltas = usdcDeltas(loaded.tx.meta);
  const escrow = config.ESCROW_WALLET_ADDRESS;
  const escrowDelta = deltas.get(escrow) ?? 0n;
  if (escrowDelta >= 0n) {
    return { verified: false, senderWallet: escrow, error: "Escrow wallet did not send USDC" };
  }

  const expected = new Map<string, bigint>();
  for (const transfer of expectedTransfers) {
    let destination: string;
    try {
      destination = new PublicKey(transfer.destinationWallet).toBase58();
    } catch {
      return { verified: false, senderWallet: escrow, error: "Payout destination is not a public wallet" };
    }
    if (destination === escrow) {
      return { verified: false, senderWallet: escrow, error: "Payout destination cannot be the escrow wallet" };
    }
    expected.set(destination, (expected.get(destination) ?? 0n) + usdcRaw(transfer.netAmountUsdc));
  }

  let total = 0n;
  for (const [destination, raw] of expected) {
    total += raw;
    const received = deltas.get(destination) ?? 0n;
    if (received < raw) {
      return {
        verified: false,
        senderWallet: escrow,
        error: `${destination} received ${formatRaw(received)} USDC, expected ${formatRaw(raw)}`,
      };
    }
  }

  if (escrowDelta > -total) {
    return {
      verified: false,
      senderWallet: escrow,
      error: `Escrow sent ${formatRaw(-escrowDelta)} USDC, expected at least ${formatRaw(total)}`,
    };
  }

  return { verified: true, senderWallet: escrow };
}