import { Router } from "express";
import { z } from "zod";
import { asUsdc, HttpError, parseParams, supabase, throwDb } from "../config.js";
import { mapReputation, reputationColumns } from "../lib/reputation.js";

const router = Router();

const Handle = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .transform((value) => value.replace(/^@/, "").toLowerCase());

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

router.get("/:handle/reputation", async (req, res, next) => {
  try {
    const handle = parseParams(Handle, req.params.handle);

    const byHandle = await supabase
      .from("campaigns")
      .select("id, founder_id, project_name, project_handle, status, total_budget_usdc, remaining_budget_usdc, ends_at")
      .eq("project_handle", handle)
      .in("status", ["active", "paused", "completed", "expired"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (byHandle.error) throwDb(byHandle.error, "load project by handle");

    let founderId: string | null = (byHandle.data?.founder_id as string | undefined) ?? null;
    let projectName = (byHandle.data?.project_name as string | null) ?? null;

    if (!founderId) {
      const camps = await supabase
        .from("campaigns")
        .select("id, founder_id, project_name, project_handle, status, total_budget_usdc, remaining_budget_usdc, ends_at")
        .in("status", ["active", "paused", "completed", "expired"])
        .order("created_at", { ascending: false })
        .limit(200);
      if (camps.error) throwDb(camps.error, "load campaigns for handle");
      const match = (camps.data ?? []).find((row) => {
        const named = row.project_name ? slugify(String(row.project_name)) : "";
        const stored = row.project_handle ? String(row.project_handle).toLowerCase() : "";
        return named === handle || stored === handle;
      });
      if (match) {
        founderId = match.founder_id as string;
        projectName = (match.project_name as string | null) ?? null;
      }
    }

    if (!founderId) {
      const profile = await supabase
        .from("profiles")
        .select(reputationColumns)
        .ilike("x_username", handle)
        .maybeSingle();
      if (profile.error) throwDb(profile.error, "load founder by x username");
      if (!profile.data) throw new HttpError(404, "Project not found");
      res.json({
        ok: true,
        handle,
        projectName: profile.data.display_name ?? profile.data.x_username ?? handle,
        reputation: mapReputation(profile.data as Record<string, unknown>),
        campaigns: [],
      });
      return;
    }

    const profile = await supabase.from("profiles").select(reputationColumns).eq("id", founderId).maybeSingle();
    if (profile.error) throwDb(profile.error, "load founder reputation");
    if (!profile.data) throw new HttpError(404, "Project not found");

    const activeCampaigns = await supabase
      .from("campaigns")
      .select("id, status, project_name, total_budget_usdc, remaining_budget_usdc, ends_at")
      .eq("founder_id", founderId)
      .in("status", ["active", "paused", "completed", "expired"])
      .order("created_at", { ascending: false })
      .limit(20);
    if (activeCampaigns.error) throwDb(activeCampaigns.error, "load founder campaigns");

    res.json({
      ok: true,
      handle,
      projectName: projectName ?? activeCampaigns.data?.[0]?.project_name ?? null,
      reputation: mapReputation(profile.data as Record<string, unknown>),
      campaigns: (activeCampaigns.data ?? []).map((row) => ({
        campaignId: row.id,
        status: row.status,
        projectName: row.project_name ?? null,
        totalBudgetUsdc: asUsdc(row.total_budget_usdc),
        remainingBudgetUsdc: asUsdc(row.remaining_budget_usdc),
        endsAt: row.ends_at,
      })),
    });
  } catch (error) {
    next(error);
  }
});

export default router;