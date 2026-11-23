import { Router } from "express";
import { z } from "zod";
import {
  asUsdc,
  clientIp,
  config,
  GAS_FEE_USDC,
  HttpError,
  parseBody,
  recalculateCampaignDepositFees,
  REFERRAL_DEPOSIT_RATE,
  supabase,
  throwDb,
} from "../config.js";
import { currentUser, requireUser, touchProfileIp } from "../middleware/auth.js";
import { verifyUsdcTransfer } from "../services/helius.js";

const router = Router();
router.use(requireUser);

const CampaignId = z.string().uuid();
const txSignature = z.string().trim().regex(/^[1-9A-HJ-NP-Za-km-z]{64,128}$/);

type Campaign = {
  id: string;
  founder_id: string;
  status: string;
  total_budget_usdc: number | string;
  platform_fee_usdc: number | string;
  boost_fee_usdc: number | string;
  bundle_boost_fee_usdc?: number | string;
  remaining_budget_usdc: number | string;
  ends_at: string;
};

async function ownedCampaign(founderId: string, campaignId: string): Promise<Campaign> {
  const { data, error } = await supabase.from("campaigns").select("*").eq("id", campaignId).maybeSingle();
  if (error) throwDb(error, "load campaign");
  if (!data) throw new HttpError(404, "Campaign not found");
  if (data.founder_id !== founderId) throw new HttpError(403, "You do not own this campaign");
  return data as Campaign;
}

async function assertSignatureUnused(signature: string): Promise<void> {
  const { data, error } = await supabase.from("used_transactions").select("signature").eq("signature", signature).maybeSingle();
  if (error) throwDb(error, "check transaction");
  if (data) throw new HttpError(409, "Transaction signature was already used");
}

router.post("/verify-deposit", async (req, res, next) => {
  try {
    const user = currentUser(req);
    await touchProfileIp(user.id, req);
    const body = parseBody(z.object({ campaignId: CampaignId, txSignature }), req.body);
    const campaign = await ownedCampaign(user.id, body.campaignId);
    if (campaign.status !== "awaiting_deposit") throw new HttpError(409, "Campaign is not awaiting a deposit");

    const fees = recalculateCampaignDepositFees(campaign);
    await assertSignatureUnused(body.txSignature);

    const expected = [{ destinationWallet: config.ESCROW_WALLET_ADDRESS, minAmountUsdc: fees.escrowUsdc }];
    if (fees.revenueUsdc > 0) {
      expected.push({ destinationWallet: config.REVENUE_WALLET_ADDRESS, minAmountUsdc: fees.revenueUsdc });
    }

    const transfer = await verifyUsdcTransfer(body.txSignature, expected);
    if (!transfer.verified) throw new HttpError(400, "Deposit could not be verified");

    const activated = await supabase.rpc("activate_campaign_deposit", {
      p_campaign_id: campaign.id,
      p_founder_id: user.id,
      p_tx: body.txSignature,
      p_sender_wallet: transfer.senderWallet ?? null,
      p_referral_rate: REFERRAL_DEPOSIT_RATE,
      p_platform_fee: fees.platformFeeUsdc,
      p_boost_fee: fees.boostFeeUsdc,
      p_founder_ip: clientIp(req),
    });
    if (activated.error) throwDb(activated.error, "activate campaign");

    res.json({
      ok: true,
      campaignId: campaign.id,
      status: "active",
      escrowUsdc: fees.escrowUsdc,
      platformFeeUsdc: fees.platformFeeUsdc,
      boostFeeUsdc: fees.boostFeeUsdc,
      remainingBudgetUsdc: fees.escrowUsdc,
      depositTxHash: body.txSignature,
      referralBonusUsdc: asUsdc(activated.data),
    });
  } catch (error) {
    next(error);
  }
});

router.post("/expire-action", async (req, res, next) => {
  try {
    const user = currentUser(req);
    const body = parseBody(
      z.object({
        campaignId: CampaignId,
        action: z.enum(["extend", "refund"]),
        extraHours: z.union([z.literal(24), z.literal(48), z.literal(72)]).optional(),
      }),
      req.body,
    );
    const campaign = await ownedCampaign(user.id, body.campaignId);
    const ended = Date.parse(campaign.ends_at) <= Date.now();
    const remaining = asUsdc(campaign.remaining_budget_usdc);
    if (!["active", "expired"].includes(campaign.status) || !ended || remaining <= 0) {
      throw new HttpError(409, "Only an ended campaign with budget left can be extended or refunded");
    }

    if (body.action === "extend") {
      if (!body.extraHours) throw new HttpError(400, "Invalid request");
      const endsAt = new Date(Date.now() + body.extraHours * 60 * 60 * 1000).toISOString();
      const { data, error } = await supabase
        .from("campaigns")
        .update({ status: "active", ends_at: endsAt })
        .eq("id", campaign.id)
        .eq("founder_id", user.id)
        .in("status", ["active", "expired"])
        .gt("remaining_budget_usdc", 0)
        .lte("ends_at", new Date().toISOString())
        .select("id, status, ends_at, remaining_budget_usdc")
        .maybeSingle();
      if (error) throwDb(error, "extend campaign");
      if (!data) throw new HttpError(409, "Campaign could not be extended");
      res.json({ ok: true, campaign: data, feeUsdc: 0 });
      return;
    }

    const queued = await supabase.rpc("queue_campaign_refund", {
      p_campaign_id: campaign.id,
      p_user_id: user.id,
      p_gas_fee: GAS_FEE_USDC,
    });
    if (queued.error) throwDb(queued.error, "queue campaign refund");
    res.json({ ok: true, payoutRequestId: queued.data, gasFeeUsdc: GAS_FEE_USDC });
  } catch (error) {
    next(error);
  }
});

export default router;