import { Router } from "express";
import { z } from "zod";
import { assertWalletAddress, HttpError, MIN_PAYOUT_USDC, parseBody, supabase, throwDb } from "../config.js";
import { currentUser, requireUser, touchProfileIp } from "../middleware/auth.js";
import { payoutsRequestLimiter } from "../middleware/rateLimits.js";

const router = Router();
router.use(requireUser);

router.post("/request", payoutsRequestLimiter, async (req, res, next) => {
  try {
    const user = currentUser(req);
    await touchProfileIp(user.id, req);
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