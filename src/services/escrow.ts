import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { asUsdc, config, MAINNET_USDC_MINT, solanaConnection, supabase } from "../config.js";

export async function readEscrowUsdcBalance(): Promise<number> {
  const mint = new PublicKey(MAINNET_USDC_MINT);
  const owner = new PublicKey(config.ESCROW_WALLET_ADDRESS);
  const tokenAccount = getAssociatedTokenAddressSync(mint, owner, false, TOKEN_PROGRAM_ID);
  const balance = await solanaConnection.getTokenAccountBalance(tokenAccount, "finalized");
  return asUsdc(balance.value.uiAmount ?? 0);
}

export async function readOwedObligationsUsdc(): Promise<number> {
  const [profiles, campaigns] = await Promise.all([
    supabase.from("profiles").select("available_usdc, pending_usdc"),
    supabase
      .from("campaigns")
      .select("remaining_budget_usdc")
      .in("status", ["active", "paused", "hidden", "expired", "refund_queued"]),
  ]);
  if (profiles.error) throw new Error(profiles.error.message);
  if (campaigns.error) throw new Error(campaigns.error.message);

  let owed = 0;
  for (const row of profiles.data ?? []) {
    owed += asUsdc(row.available_usdc) + asUsdc(row.pending_usdc);
  }
  for (const row of campaigns.data ?? []) {
    owed += asUsdc(row.remaining_budget_usdc);
  }
  return asUsdc(owed);
}