import { Router } from "express";
import { routeManifestForResponse } from "../apiManifest.js";
import { CORS_ALLOWED_HEADERS, listAllowedOrigins } from "../corsPolicy.js";

const router = Router();

/** Lets the frontend confirm deployed API routes (e.g. after Railway deploy). */
router.get("/", (_req, res) => {
  const manifest = routeManifestForResponse();
  res.json({
    ok: true,
    service: "raidhive-backend",
    cors: {
      allowedOrigins: listAllowedOrigins(),
      allowedHeaders: [...CORS_ALLOWED_HEADERS],
    },
    routes: manifest.routes,
    routeManifestPublic: manifest.routeManifestPublic,
  });
});

export default router;