import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "path";
import { fileURLToPath } from "url";
import router from "./routes";
import { logger } from "./lib/logger";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// In production the frontend is built to artifacts/visitor-tracker/dist/
// The API server dist lives at artifacts/api-server/dist/
// so relative path is ../../visitor-tracker/dist
const FRONTEND_DIST = path.resolve(__dirname, "../../visitor-tracker/dist");

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

// Serve frontend static assets
app.use(express.static(FRONTEND_DIST));

// SPA fallback — all non-API GET requests get index.html
app.get("*", (_req, res) => {
  res.sendFile(path.join(FRONTEND_DIST, "index.html"));
});

export default app;
