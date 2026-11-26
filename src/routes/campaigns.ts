import { Router } from "express";
import { z } from "zod";
import {
  asUsdc,
  clientIp,
  config,
  GAS_FEE_USDC,
  HttpError,
  parseBody,
  parseParams,
  recalculateCampaignDepositFees,
  REFERRAL_DEPOSIT_RATE,
  supabase,
  throwDb,
} from "../config.js";
import { currentUser, requireUser, touchProfileIp } from "../middleware/auth.js";
import { verifyUsdcCredit, verifyUsdcTransfer } from "../services/helius.js";

const router = Router();
router.use(requireUser);

const CampaignId = z.string().uuid();
const TemplateId = z.string().uuid();
const txSignature = z.string().trim().regex(/^[1-9A-HJ-NP-Za-km-z]{64,128}$/);

const templateName = z.string().trim().min(1).max(60);

function normalizeTemplateDraft(value: unknown): Record<string, unknown> {
  if (value == null) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      throw new HttpError(400, "Invalid request");
    }
    throw new HttpError(400, "Invalid request");
  }
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new HttpError(400, "Invalid request");
}

const templateSaveInput = z.object({
  name: z.string().optional(),
  templateName: z.string().optional(),
  draft: z.unknown().optional(),
  fields: z.unknown().optional(),
});

function parseTemplateSave(body: unknown): { name: string; draft: Record<string, unknown> } {
  const raw = parseBody(templateSaveInput, body);
  const name = (raw.name ?? raw.templateName ?? "").trim();
  templateName.parse(name);
  return { name, draft: normalizeTemplateDraft(raw.draft ?? raw.fields ?? {}) };
}

function parseTemplateDeleteId(body: unknown): string {
  const raw = parseBody(
    z.object({
      template_id: TemplateId.optional(),
      id: TemplateId.optional(),
      templateId: TemplateId.optional(),
    }),
    body,
  );
  const templateId = raw.template_id ?? raw.id ?? raw.templateId;
  if (!templateId) throw new HttpError(400, "Invalid request");
  return templateId;
}
const DraftId = z.string().uuid();
const campaignDraft = z.record(z.unknown());
const extraHours = z.union([z.literal(24), z.literal(48), z.literal(72)]);

router.get("/templates", async (req, res, next) => {
  try {
    const user = currentUser(req);
    const rows = await supabase
      .from("campaign_templates")
      .select("id, name, draft")
      .eq("user_id", user.id)
      .order("updated_at", { ascending: false });
    if (rows.error) throwDb(rows.error, "load campaign templates");
    res.json({ templates: rows.data ?? [] });
  } catch (error) {
    next(error);
  }
});

router.post("/templates", async (req, res, next) => {
  try {
    const user = currentUser(req);
    const body = parseTemplateSave(req.body);
    const saved = await supabase
      .from("campaign_templates")
      .insert({
        user_id: user.id,
        name: body.name,
        draft: body.draft,
        updated_at: new Date().toISOString(),
      })
      .select("id, name, draft")
      .single();
    if (saved.error) throwDb(saved.error, "save campaign template");
    res.status(201).json({ ok: true, template: saved.data });
  } catch (error) {
    next(error);
  }
});

router.post("/templates/delete", async (req, res, next) => {
  try {
    const user = currentUser(req);
    const templateId = parseTemplateDeleteId(req.body);
    const removed = await supabase
      .from("campaign_templates")
      .delete()
      .eq("id", templateId)
      .eq("user_id", user.id)
      .select("id")
      .maybeSingle();
    if (removed.error) throwDb(removed.error, "delete campaign template");
    if (!removed.data) throw new HttpError(404, "Template not found");
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.get("/drafts", async (req, res, next) => {
  try {
    const user = currentUser(req);
    const rows = await supabase
      .from("campaign_drafts")
      .select("id, campaign_id, draft, created_at, updated_at")
      .eq("user_id", user.id)
      .order("updated_at", { ascending: false });
    if (rows.error) throwDb(rows.error, "load campaign drafts");
    res.json({
      ok: true,
      drafts: (rows.data ?? []).map((row) => ({
        id: row.id,
        campaignId: row.campaign_id,
        draft: row.draft,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
    });
  } catch (error) {
    next(error);
  }
});

router.post("/drafts", async (req, res, next) => {
  try {
    const user = currentUser(req);
    const body = parseBody(
      z.object({
        draft: campaignDraft,
        campaignId: CampaignId.optional(),
      }),
      req.body,
    );
    if (body.campaignId) await ownedCampaign(user.id, body.campaignId);
    const saved = await supabase
      .from("campaign_drafts")
      .insert({
        user_id: user.id,
        campaign_id: body.campaignId ?? null,
        draft: body.draft,
        updated_at: new Date().toISOString(),
      })
      .select("id, campaign_id, draft, created_at, updated_at")
      .single();
    if (saved.error) throwDb(saved.error, "create campaign draft");
    res.status(201).json({ ok: true, draft: saved.data });
  } catch (error) {
    next(error);
  }
});

router.get("/drafts/:draftId", async (req, res, next) => {
  try {
    const user = currentUser(req);
    const draftId = parseParams(DraftId, req.params.draftId);
    const row = await supabase
      .from("campaign_drafts")
      .select("id, campaign_id, draft, created_at, updated_at")
      .eq("id", draftId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (row.error) throwDb(row.error, "load campaign draft");
    if (!row.data) throw new HttpError(404, "Draft not found");
    res.json({ ok: true, draft: row.data });
  } catch (error) {
    next(error);
  }
});

router.patch("/drafts/:draftId", async (req, res, next) => {
  try {
    const user = currentUser(req);
    const draftId = parseParams(DraftId, req.params.draftId);
    const body = parseBody(
      z.object({
        draft: campaignDraft,
        campaignId: CampaignId.nullable().optional(),
      }),
      req.body,
    );
    if (body.campaignId) await ownedCampaign(user.id, body.campaignId);

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString(), draft: body.draft };
    if (body.campaignId !== undefined) patch.campaign_id = body.campaignId;

    const updated = await supabase
      .from("campaign_drafts")
      .update(patch)
      .eq("id", draftId)
      .eq("user_id", user.id)
      .select("id, campaign_id, draft, created_at, updated_at")
      .maybeSingle();
    if (updated.error) throwDb(updated.error, "update campaign draft");
    if (!updated.data) throw new HttpError(404, "Draft not found");
    res.json({ ok: true, draft: updated.data });
  } catch (error) {
    next(error);
  }
});

router.delete("/drafts/:draftId", async (req, res, next) => {
  try {
    const user = currentUser(req);
    const draftId = parseParams(DraftId, req.params.draftId);
    const removed = await supabase
      .from("campaign_drafts")
      .delete()
      .eq("id", draftId)
      .eq("user_id", user.id)
      .select("id")
      .maybeSingle();
    if (removed.error) throwDb(removed.error, "delete campaign draft");
    if (!removed.data) throw new HttpError(404, "Draft not found");
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.get("/:campaignId/submissions", async (req, res, next) => {
  try {
    const user = currentUser(req);
    const campaignId = parseParams(CampaignId, req.params.campaignId);
    const campaign = await ownedCampaign(user.id, campaignId);

    const rows = await supabase
      .from("submissions")
      .select(
        "id, raider_id, action_type, tweet_url, tweet_text, status, earned_usdc, vests_at, vested, ai_reason, created_at, flagged_by_creator, flag_reason",
      )
      .eq("campaign_id", campaign.id)
      .order("created_at", { ascending: false });
    if (rows.error) throwDb(rows.error, "load submissions");

    res.json({ ok: true, campaignId: campaign.id, submissions: rows.data ?? [] });
  } catch (error) {
    next(error);
  }
});

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

function assertEndedWithBudget(campaign: Campaign): void {
  const ended = Date.parse(campaign.ends_at) <= Date.now();
  const remaining = asUsdc(campaign.remaining_budget_usdc);
  if (!["active", "expired"].includes(campaign.status) || !ended || remaining <= 0) {
    throw new HttpError(409, "Only an ended campaign with budget left can be extended or refunded");
  }
}

async function extendOwnedCampaign(userId: string, campaign: Campaign, hours: 24 | 48 | 72) {
  const endsAt = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("campaigns")
    .update({ status: "active", ends_at: endsAt })
    .eq("id", campaign.id)
    .eq("founder_id", userId)
    .in("status", ["active", "expired"])
    .gt("remaining_budget_usdc", 0)
    .lte("ends_at", new Date().toISOString())
    .select("id, status, ends_at, remaining_budget_usdc")
    .maybeSingle();
  if (error) throwDb(error, "extend campaign");
  if (!data) throw new HttpError(409, "Campaign could not be extended");
  return data;
}

async function queueOwnedRefund(userId: string, campaign: Campaign) {
  const queued = await supabase.rpc("queue_campaign_refund", {
    p_campaign_id: campaign.id,
    p_user_id: userId,
    p_gas_fee: GAS_FEE_USDC,
  });
  if (queued.error) throwDb(queued.error, "queue campaign refund");
  return queued.data;
}

const verifyDepositFields = z.object({
  campaignId: CampaignId.optional(),
  campaign_id: CampaignId.optional(),
  txSignature: txSignature.optional(),
  deposit_tx_hash: txSignature.optional(),
  revenue_tx_hash: txSignature.optional(),
});

function parseVerifyDepositBody(body: unknown): {
  campaignId: string;
  depositTxHash: string;
  revenueTxHash: string | null;
} {
  const raw = parseBody(verifyDepositFields, body);
  const campaignId = raw.campaignId ?? raw.campaign_id;
  const depositTxHash = raw.deposit_tx_hash ?? raw.txSignature;
  if (!campaignId || !depositTxHash) throw new HttpError(400, "Invalid request");
  return {
    campaignId,
    depositTxHash,
    revenueTxHash: raw.revenue_tx_hash ?? null,
  };
}

function depositCheckFailed(reason: string): never {
  throw new HttpError(400, reason);
}

router.post("/verify-deposit", async (req, res, next) => {
  try {
    const user = currentUser(req);
    await touchProfileIp(user.id, req);
    const body = parseVerifyDepositBody(req.body);
    const campaign = await ownedCampaign(user.id, body.campaignId);
    if (campaign.status !== "awaiting_deposit") {
      throw new HttpError(409, "Campaign is not awaiting a deposit");
    }

    const fees = recalculateCampaignDepositFees(campaign);

    if (body.revenueTxHash && body.revenueTxHash === body.depositTxHash) {
      depositCheckFailed("Deposit and revenue links must be different transactions");
    }

    await assertSignatureUnused(body.depositTxHash);
    if (body.revenueTxHash) await assertSignatureUnused(body.revenueTxHash);

    let senderWallet: string | undefined;

    if (body.revenueTxHash) {
      if (fees.revenueUsdc <= 0) {
        depositCheckFailed("This campaign does not require a separate revenue transfer");
      }
      const depositLeg = await verifyUsdcCredit(
        body.depositTxHash,
        config.ESCROW_WALLET_ADDRESS,
        fees.escrowUsdc,
        true,
      );
      if (!depositLeg.verified) {
        depositCheckFailed(depositLeg.error ?? "Escrow transfer could not be verified");
      }

      const revenueLeg = await verifyUsdcCredit(
        body.revenueTxHash,
        config.REVENUE_WALLET_ADDRESS,
        fees.revenueUsdc,
        true,
      );
      if (!revenueLeg.verified) {
        depositCheckFailed(revenueLeg.error ?? "Revenue transfer could not be verified");
      }

      if (!depositLeg.senderWallet || !revenueLeg.senderWallet) {
        depositCheckFailed("Sender wallet could not be determined");
      }
      if (depositLeg.senderWallet !== revenueLeg.senderWallet) {
        depositCheckFailed("Both transfers must come from the same wallet");
      }
      senderWallet = depositLeg.senderWallet;
    } else {
      const expected = [{ destinationWallet: config.ESCROW_WALLET_ADDRESS, minAmountUsdc: fees.escrowUsdc }];
      if (fees.revenueUsdc > 0) {
        expected.push({ destinationWallet: config.REVENUE_WALLET_ADDRESS, minAmountUsdc: fees.revenueUsdc });
      }
      const transfer = await verifyUsdcTransfer(body.depositTxHash, expected);
      if (!transfer.verified) {
        depositCheckFailed(transfer.error ?? "Deposit could not be verified");
      }
      senderWallet = transfer.senderWallet;
    }

    const activated = await supabase.rpc("activate_campaign_deposit", {
      p_campaign_id: campaign.id,
      p_founder_id: user.id,
      p_tx: body.depositTxHash,
      p_sender_wallet: senderWallet ?? null,
      p_referral_rate: REFERRAL_DEPOSIT_RATE,
      p_platform_fee: fees.platformFeeUsdc,
      p_boost_fee: fees.boostFeeUsdc,
      p_founder_ip: clientIp(req),
    });
    if (activated.error) throwDb(activated.error, "activate campaign");

    if (body.revenueTxHash) {
      const revenueUsed = await supabase
        .from("used_transactions")
        .insert({ signature: body.revenueTxHash, purpose: "deposit" });
      if (revenueUsed.error) {
        console.error(`[campaigns] revenue tx mark failed: ${revenueUsed.error.message}`);
        throw new HttpError(500, "Campaign activated but revenue transaction could not be recorded");
      }
    }

    res.json({
      ok: true,
      campaignId: campaign.id,
      status: "active",
      escrowUsdc: fees.escrowUsdc,
      platformFeeUsdc: fees.platformFeeUsdc,
      boostFeeUsdc: fees.boostFeeUsdc,
      remainingBudgetUsdc: fees.escrowUsdc,
      depositTxHash: body.depositTxHash,
      revenueTxHash: body.revenueTxHash,
      referralBonusUsdc: asUsdc(activated.data),
    });
  } catch (error) {
    next(error);
  }
});

router.post("/extend", async (req, res, next) => {
  try {
    const user = currentUser(req);
    const body = parseBody(
      z.object({
        campaignId: CampaignId,
        extraHours: extraHours.optional().default(24),
      }),
      req.body,
    );
    const campaign = await ownedCampaign(user.id, body.campaignId);
    assertEndedWithBudget(campaign);
    const hours = body.extraHours ?? 24;
    const data = await extendOwnedCampaign(user.id, campaign, hours);
    res.json({ ok: true, campaign: data, feeUsdc: 0 });
  } catch (error) {
    next(error);
  }
});

router.post("/refund", async (req, res, next) => {
  try {
    const user = currentUser(req);
    const body = parseBody(z.object({ campaignId: CampaignId }), req.body);
    const campaign = await ownedCampaign(user.id, body.campaignId);
    assertEndedWithBudget(campaign);
    const payoutRequestId = await queueOwnedRefund(user.id, campaign);
    res.json({ ok: true, payoutRequestId, gasFeeUsdc: GAS_FEE_USDC });
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
        extraHours: extraHours.optional(),
      }),
      req.body,
    );
    const campaign = await ownedCampaign(user.id, body.campaignId);
    assertEndedWithBudget(campaign);

    if (body.action === "extend") {
      if (!body.extraHours) throw new HttpError(400, "Invalid request");
      const data = await extendOwnedCampaign(user.id, campaign, body.extraHours);
      res.json({ ok: true, campaign: data, feeUsdc: 0 });
      return;
    }

    const payoutRequestId = await queueOwnedRefund(user.id, campaign);
    res.json({ ok: true, payoutRequestId, gasFeeUsdc: GAS_FEE_USDC });
  } catch (error) {
    next(error);
  }
});

export default router;