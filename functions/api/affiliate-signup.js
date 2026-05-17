// Cloudflare Pages Function — affiliate program signup.
//
// POST /api/affiliate-signup
// Body: { firstName, lastName, email, handle, platform, audienceSize, notes? }
// Writes a new affiliate record to KV (status=pending) and notifies admin via Formspree.
// Auto-generates a unique discount code (e.g. "FNAME15" or "FNAMEXXXX") and stores it.
//
// Binding required in wrangler.toml / dashboard:
//   - STRATUS_DATA (KV namespace) — keys: affiliate:<id>, promo:<code>
//
// Env vars (optional):
//   - FORMSPREE_NOTIFY_URL — Formspree endpoint to email admin on new applications
//   - DEFAULT_COMMISSION_PCT (default 15)
//   - DEFAULT_DISCOUNT_PCT   (default 10)

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function clean(s, max = 200) {
  if (typeof s !== "string") return "";
  return s.replace(/[\x00-\x1F\x7F]/g, "").trim().slice(0, max);
}

function isValidEmail(e) {
  return /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(e);
}

function genCode(firstName, discountPct) {
  // Code format: <FIRSTNAME_ALPHANUM_UPPER><DISCOUNT> — e.g. "DANIEL10"
  // Falls back to random suffix if first name produces a too-short or duplicate code.
  const base = (firstName || "FRIEND").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10) || "FRIEND";
  const suffix = String(discountPct);
  return base + suffix;
}

function randomSuffix(n = 4) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // unambiguous
  let s = "";
  for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }

  const firstName    = clean(body?.firstName, 50);
  const lastName     = clean(body?.lastName, 50);
  const email        = clean(body?.email, 120).toLowerCase();
  const handle       = clean(body?.handle, 120);
  const platform     = clean(body?.platform, 60);
  const audienceSize = clean(body?.audienceSize, 60);
  const notes        = clean(body?.notes, 600);

  if (!firstName || !lastName || !email || !handle || !platform || !audienceSize) {
    return json({ ok: false, error: "Missing required fields" }, 400);
  }
  if (!isValidEmail(email)) return json({ ok: false, error: "Invalid email" }, 400);

  if (!env.STRATUS_DATA) {
    // Function deployed but KV not bound yet — fail loudly.
    return json({ ok: false, error: "Server storage not configured. Please contact info@stratusbiolabs.com." }, 503);
  }

  // Reject duplicate applicants by email.
  const existingByEmail = await env.STRATUS_DATA.get(`affiliate-email:${email}`);
  if (existingByEmail) {
    return json({ ok: false, error: "An application with this email already exists. Check your inbox." }, 409);
  }

  const commissionPct = parseInt(env.DEFAULT_COMMISSION_PCT) || 15;
  const discountPct   = parseInt(env.DEFAULT_DISCOUNT_PCT)   || 10;

  // Generate unique code (try name-based first, then add random suffix if taken).
  let code = genCode(firstName, discountPct);
  for (let attempts = 0; attempts < 5; attempts++) {
    const taken = await env.STRATUS_DATA.get(`promo:${code}`);
    if (!taken) break;
    code = genCode(firstName, discountPct) + randomSuffix(3);
  }

  const id = `aff_${Date.now()}_${randomSuffix(6)}`;
  const now = new Date().toISOString();
  const record = {
    id, firstName, lastName, email, handle, platform, audienceSize, notes,
    code, commissionPct, discountPct,
    status: "active", // auto-approve; admin can disable via dashboard
    createdAt: now,
  };

  // Write three indexes so we can look up by id, by code, by email.
  await env.STRATUS_DATA.put(`affiliate:${id}`, JSON.stringify(record));
  await env.STRATUS_DATA.put(`affiliate-email:${email}`, id);
  await env.STRATUS_DATA.put(`promo:${code}`, JSON.stringify({
    type: "percent",
    value: discountPct,
    label: `${discountPct}% OFF`,
    affiliateId: id,
    affiliateCommission: commissionPct,
    status: "active",
    createdAt: now,
  }));

  // Notify admin via Formspree (best-effort, don't fail the signup if this fails).
  if (env.FORMSPREE_NOTIFY_URL) {
    try {
      await fetch(env.FORMSPREE_NOTIFY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({
          subject: `New affiliate: ${firstName} ${lastName} (${platform}, ${audienceSize})`,
          name: `${firstName} ${lastName}`,
          email, handle, platform, audienceSize, notes,
          assignedCode: code,
          commissionPct, discountPct,
        }),
      });
    } catch (e) { /* swallow */ }
  }

  return json({ ok: true, code, commissionPct, discountPct, message: "Application received — your code is active." });
}
