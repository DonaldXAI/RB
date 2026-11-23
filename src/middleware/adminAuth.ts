import type { NextFunction, Request, Response } from "express";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { assertWalletAddress, config, HttpError, supabase } from "../config.js";

const FIVE_MINUTES_MS = 5 * 60 * 1000;

declare global {
  namespace Express {
    interface Request {
      adminWallet?: string;
    }
  }
}

function readTimestamp(headerValue: string, message: string): number {
  const fromHeader = Date.parse(headerValue.trim());
  if (Number.isFinite(fromHeader)) return fromHeader;

  const labeled = message.match(/Issued At:\s*([^\n]+)/i)?.[1]?.trim();
  const candidate = labeled ?? message.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/)?.[0];
  const parsed = candidate ? Date.parse(candidate) : Number.NaN;
  if (!Number.isFinite(parsed)) throw new HttpError(401, "Admin request has no valid timestamp");
  return parsed;
}

export async function requireAdmin(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const walletHeader = req.get("x-admin-wallet") ?? "";
    const signature = req.get("x-admin-signature") ?? "";
    const message = req.get("x-admin-message") ?? "";
    const nonce = (req.get("x-admin-nonce") ?? "").trim();
    const timestampHeader = req.get("x-admin-timestamp") ?? "";

    if (!walletHeader || !signature || !message || !nonce || !timestampHeader) {
      throw new HttpError(401, "Admin signature headers are required");
    }
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(nonce)) throw new HttpError(401, "Admin nonce is invalid");
    if (message.length > 8_000) throw new HttpError(401, "Admin message is too long");

    const wallet = assertWalletAddress(walletHeader);
    if (wallet !== config.ESCROW_WALLET_ADDRESS) throw new HttpError(403, "Signer is not the escrow wallet");

    const issuedAt = readTimestamp(timestampHeader, message);
    if (Math.abs(Date.now() - issuedAt) > FIVE_MINUTES_MS) {
      throw new HttpError(401, "Admin request has expired");
    }

    let signatureBytes: Uint8Array;
    try {
      signatureBytes = bs58.decode(signature);
    } catch {
      throw new HttpError(401, "Admin signature is not valid");
    }
    if (signatureBytes.length !== 64) throw new HttpError(401, "Admin signature is not valid");

    const valid = nacl.sign.detached.verify(
      new TextEncoder().encode(message),
      signatureBytes,
      new PublicKey(wallet).toBytes(),
    );
    if (!valid) throw new HttpError(401, "Admin signature is not valid");

    const known = await supabase.from("admin_nonces").select("nonce").eq("nonce", nonce).maybeSingle();
    if (known.error) {
      console.error(`[admin] nonce lookup failed: ${known.error.message}`);
      throw new HttpError(500, "Could not verify admin request");
    }
    if (known.data) throw new HttpError(401, "Replay detected");

    const stored = await supabase.from("admin_nonces").insert({
      nonce,
      admin_wallet: wallet,
      message_timestamp: new Date(issuedAt).toISOString(),
    });
    if (stored.error) {
      if (stored.error.code === "23505") throw new HttpError(401, "Replay detected");
      console.error(`[admin] nonce insert failed: ${stored.error.message}`);
      throw new HttpError(500, "Could not verify admin request");
    }

    req.adminWallet = wallet;
    next();
  } catch (error) {
    next(error);
  }
}