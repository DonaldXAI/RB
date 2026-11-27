import { Router } from "express";
import { z } from "zod";
import { asUsdc, assertWalletAddress, HttpError, MIN_PAYOUT_USDC, parseBody, supabase, throwDb } from "../config.js";
import { currentUser, requireUser } from "../middleware/auth.js";
import { payoutsRequestLimiter } from "../middleware/rateLimits.js";

const router = Router();
router.use(requireUser);

const receiptLimit = z.coerce.number().int().min(1).max(100).default(50);

router.get("/receipts", async (req, res, next) => {
  try {
    const user = currentUser(req);
    const limit = receiptLimit.parse(req.query.limit ?? 50);
    const [payouts, deposits] = await Promise.all([
      supabase
        .from("payout_requests")
        .select(
          "id, request_type, status, gross_amount_usdc, net_amount_usdc, gas_fee_usdc, destination_wallet, payout_tx_hash, campaign_id, created_at, processed_at",
        )
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(limit),
      supabase
        .from("campaigns")
        .select("id, project_name, status, total_budget_usdc, deposit_tx_hash, created_at")
        .eq("founder_id", user.id)
        .not("deposit_tx_hash", "is", null)
        .order("created_at", { ascending: false })
        .limit(limit),
    ]);
    if (payouts.error) throwDb(payouts.error, "load payout receipts");
    if (deposits.error) throwDb(deposits.error, "load deposit receipts");

    const items = [
      ...(payouts.data ?? []).map((row) => ({
        kind: "payout" as const,
        id: row.id,
        requestType: row.request_type,
        status: row.status,
        grossAmountUsdc: asUsdc(row.gross_amount_usdc),
        netAmountUsdc: asUsdc(row.net_amount_usdc),
        gasFeeUsdc: asUsdc(row.gas_fee_usdc),
        destinationWallet: row.destination_wallet,
        txHash: row.payout_tx_hash,
        campaignId: row.campaign_id,
        createdAt: row.created_at,
        processedAt: row.processed_at,
      })),
      ...(deposits.data ?? []).map((row) => ({
        kind: "campaign_deposit" as const,
        id: row.id,
        campaignId: row.id,
        projectName: row.project_name,
        status: row.status,
        totalBudgetUsdc: asUsdc(row.total_budget_usdc),
        txHash: row.deposit_tx_hash,
        createdAt: row.created_at,
        processedAt: null,
      })),
    ].sort((a, b) => Date.parse(String(b.createdAt)) - Date.parse(String(a.createdAt)));

    res.json({ ok: true, receipts: items.slice(0, limit) });
  } catch (error) {
    next(error);
  }
});

router.post("/request", payoutsRequestLimiter, async (req, res, next) => {
  try {
    const user = currentUser(req);
    const body = parseBody(
      z.object({
        amountUsdc: z.coerce.number().positive().max(1_000_000),
        destinationWallet: z.string().trim().min(32).max(64),
      }),
      req.body,
    );

    if (body.amountUsdc < MIN_PAYOUT_USDC) {
      throw new HttpError(400, `Minimum payout is ${MIN_PAYOUT_USDC.toFixed(2)} USDC`);
    }
    const destinationWallet = assertWalletAddress(body.destinationWallet);

    const queued = await supabase.rpc("atomic_request_payout", {
      p_user_id: user.id,
      p_amount_usdc: body.amountUsdc,
      p_destination_wallet: destinationWallet,
    });
    if (queued.error) throwDb(queued.error, "queue payout");

    res.status(201).json({
      ok: true,
      payoutRequestId: queued.data,
      grossAmountUsdc: body.amountUsdc,
      status: "queued",
    });
  } catch (error) {
    next(error);
  }
});

export default router;