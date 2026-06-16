// ── Constants — update these on each release ───────────────────────────────
const LATEST_VERSION = "__VERSION__";
const PUB_DATE       = "__PUB_DATE__";
const RELEASE_NOTES  = "__RELEASE_NOTES__";

// AI skill files — baked in at build time by build-worker.js
const SKILL_FILAMENTAL    = __SKILL_FILAMENTAL__;
const SKILL_FORMAT_REF    = __SKILL_FORMAT_REF__;

// GitHub release asset URLs
const DOWNLOAD_EXE = "__EXE_URL__";
const DOWNLOAD_MSI = "__MSI_URL__";
const DOWNLOAD_DMG = "__DMG_URL__";

// Content of Filamental_x.x.x_x64-setup.exe.sig
const SIGNATURE_WINDOWS = "__SIGNATURE__";

// ── Semver compare: true if `a` > `b` ─────────────────────────────────────
function isNewer(a, b) {
  const p = s => s.split('.').map(Number);
  const [a1,a2,a3] = p(a), [b1,b2,b3] = p(b);
  return a1 !== b1 ? a1 > b1 : a2 !== b2 ? a2 > b2 : a3 > b3;
}

// ── Creem licence proxy helpers ────────────────────────────────────────────

async function proxyLicence(req, endpoint, apiKey, corsHeaders) {
  const body = await req.text();
  const up = await fetch(`https://api.creem.io/v1/licenses/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body,
  });
  const text = await up.text();
  return new Response(text, {
    status: up.status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function verifyCreemWebhook(req, secret) {
  const sig  = req.headers.get("creem-signature") ?? "";
  const body = await req.text();
  const enc  = new TextEncoder();
  const key  = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const mac  = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  const hex  = Array.from(new Uint8Array(mac)).map(b => b.toString(16).padStart(2, "0")).join("");
  return sig === `sha256=${hex}`;
}

// ── Handler ────────────────────────────────────────────────────────────────
export default {
  async fetch(req, env) {
    const url     = new URL(req.url);
    const path    = url.pathname;
    const method  = req.method;
    const corsHeaders = { "Access-Control-Allow-Origin": "*" };

    // POST /v1/app-status  — call-home from the app
    if (method === "POST" && path === "/v1/app-status") {
      return Response.json({
        latest_version: LATEST_VERSION,
        notification:   null,
      }, { headers: corsHeaders });
    }

    // GET /v1/update/:target/:current_version  — Tauri updater endpoint
    const updateMatch = path.match(/^\/v1\/update\/([^/]+)\/([^/]+)$/);
    if (method === "GET" && updateMatch) {
      const [, target, currentVersion] = updateMatch;
      if (!isNewer(LATEST_VERSION, currentVersion)) {
        return new Response(null, { status: 204 });
      }
      // Accept both "windows" (Tauri {{target}}) and "windows-x86_64" ({{target}}-{{arch}})
      const isWindows = target === "windows-x86_64" || target === "windows";
      if (!isWindows) {
        return new Response(null, { status: 204 });
      }
      return Response.json({
        version:   LATEST_VERSION,
        notes:     RELEASE_NOTES,
        pub_date:  PUB_DATE,
        platforms: {
          "windows-x86_64": {
            signature: SIGNATURE_WINDOWS,
            url:       DOWNLOAD_EXE,
          },
        },
      }, { headers: corsHeaders });
    }

    // GET /v1/skills/:filename  — serve AI skill .md files
    if (method === "GET" && path === "/v1/skills/filamental_SKILL.md") {
      return new Response(SKILL_FILAMENTAL, {
        headers: { ...corsHeaders, "Content-Type": "text/markdown; charset=utf-8" },
      });
    }
    if (method === "GET" && path === "/v1/skills/filamental_format_reference.md") {
      return new Response(SKILL_FORMAT_REF, {
        headers: { ...corsHeaders, "Content-Type": "text/markdown; charset=utf-8" },
      });
    }

    // GET /download/latest  — redirect to .exe
    if (method === "GET" && path === "/download/latest") {
      return Response.redirect(DOWNLOAD_EXE, 302);
    }

    // GET /download/latest/msi  — redirect to .msi
    if (method === "GET" && path === "/download/latest/msi") {
      return Response.redirect(DOWNLOAD_MSI, 302);
    }

    // GET /download/latest/mac  — redirect to .dmg
    if (method === "GET" && path === "/download/latest/mac") {
      if (!DOWNLOAD_DMG) return new Response("Not found", { status: 404 });
      return Response.redirect(DOWNLOAD_DMG, 302);
    }

    // CORS preflight
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // POST /v1/licenses/{activate,validate,deactivate}  — proxy to Creem
    if (method === "POST" && path === "/v1/licenses/activate") {
      return proxyLicence(req, "activate", env.CREEM_API_KEY, corsHeaders);
    }
    if (method === "POST" && path === "/v1/licenses/validate") {
      return proxyLicence(req, "validate", env.CREEM_API_KEY, corsHeaders);
    }
    if (method === "POST" && path === "/v1/licenses/deactivate") {
      return proxyLicence(req, "deactivate", env.CREEM_API_KEY, corsHeaders);
    }

    // POST /v1/webhooks/creem  — verify HMAC signature, return 200
    if (method === "POST" && path === "/v1/webhooks/creem") {
      const valid = await verifyCreemWebhook(req, env.CREEM_WEBHOOK_SECRET);
      if (!valid) return new Response("Unauthorized", { status: 401 });
      return new Response("OK", { status: 200, headers: corsHeaders });
    }

    // Fallback — basic status
    return Response.json({
      latest_version: LATEST_VERSION,
      notification:   null,
    }, { headers: corsHeaders });
  },
};
