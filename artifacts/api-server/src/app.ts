import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "path";
import fs from "fs";
import router from "./routes";
import { logger } from "./lib/logger";

// Use __dirname (injected by esbuild banner as the dist/ dir) to get a CWD-independent path.
// This resolves correctly on both Render (CWD = repo root) and local dev (CWD = package dir).
// Vite is configured to output to dist/public (not dist directly).
const FRONTEND_DIST = path.resolve(__dirname, "../../visitor-tracker/dist/public");
const INDEX_HTML = path.join(FRONTEND_DIST, "index.html");

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return { id: req.id, method: req.method, url: req.url?.split("?")[0] };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  }),
);
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// API routes
app.use("/api", router);

// Serve frontend static files if dist exists
if (fs.existsSync(FRONTEND_DIST)) {
  logger.info({ FRONTEND_DIST }, "Serving frontend static files");
  app.use(express.static(FRONTEND_DIST));
  // SPA fallback — Express 5 requires a named wildcard, not bare *
  app.get("/*splat", (_req, res) => {
    if (fs.existsSync(INDEX_HTML)) {
      res.sendFile(INDEX_HTML);
    } else {
      res.status(404).send("Not found");
    }
  });
} else {
  logger.warn({ FRONTEND_DIST }, "Frontend dist not found — API-only mode");
  app.get("/", (_req, res) => res.json({ status: "API running", dist: FRONTEND_DIST }));
}

export default app;
