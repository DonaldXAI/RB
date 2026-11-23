import { Router } from "express";
import { z } from "zod";
import { HttpError, parseBody, supabase, throwDb } from "../config.js";
import { currentUser, requireUser, touchProfileIp } from "../middleware/auth.js";
import { socialVerifyLimiter } from "../middleware/rateLimits.js";
import { assessBotRisk } from "../services/openai.js";
import { verifyChannelMembership, verifyTelegramLoginWidget } from "../services/telegram.js";
import { getUserProfile, verifyOfficialFollow } from "../services/twitter.js";

const router = Router();
router.use(requireUser);

router.post("/verify-x", socialVerifyLimiter, async (req, res, next) => {
  try {
    const user = currentUser(req);
    parseBody(z.object({}).strict(), req.body ?? {});
    await touchProfileIp(user.id, req);

    const profile = await supabase.from("profiles").select("x_username").eq("id", user.id).maybeSingle();
    if (profile.error) throwDb(profile.error, "load x username");
    const username = profile.data?.x_username as string | null;
    if (!username) throw new HttpError(400, "Set your X username before verifying");

    const xProfile = await getUserProfile(username);
    const risk = await assessBotRisk(xProfile);
    if (risk.isBotLikely) throw new HttpError(403, "X account did not pass the bot check");

    const follows = await verifyOfficialFollow(username);
    if (!follows) throw new HttpError(400, "X account does not follow the official RaidHive account");

    const { data, error } = await supabase
      .from("profiles")
      .update({ x_followed: true, x_followers: xProfile.followers })
      .eq("id", user.id)
      .select("x_username, x_followed, x_followers")
      .single();
    if (error) throwDb(error, "save x verification");

    res.json({ ok: true, profile: data });
  } catch (error) {
    next(error);
  }
});

const telegramAuthField = z.union([z.string(), z.number()]);

router.post("/verify-telegram", socialVerifyLimiter, async (req, res, next) => {
  try {
    const user = currentUser(req);
    await touchProfileIp(user.id, req);
    const body = parseBody(
      z.object({
        telegramUserId: z.union([z.string().regex(/^\d+$/), z.number().int().positive()]),
        authData: z.record(telegramAuthField).optional(),
      }),
      req.body,
    );

    const telegramUserId = String(body.telegramUserId);
    if (body.authData) {
      const authId = String(body.authData.id ?? "");
      if (authId !== telegramUserId) throw new HttpError(400, "Telegram login data does not match");
      if (!verifyTelegramLoginWidget(body.authData)) throw new HttpError(400, "Telegram login data is invalid");
    }

    const joined = await verifyChannelMembership(telegramUserId);
    if (!joined) throw new HttpError(400, "Telegram account is not a member of the channel");

    const { data, error } = await supabase
      .from("profiles")
      .update({ tg_joined: true, telegram_user_id: telegramUserId })
      .eq("id", user.id)
      .select("telegram_user_id, tg_joined")
      .single();
    if (error) throwDb(error, "save telegram verification");

    res.json({ ok: true, profile: data });
  } catch (error) {
    next(error);
  }
});

export default router;