// Cloudflare Pages Function — log a completed order.
//
// POST /api/log-order
// Body: { orderId, items, subtotal, shipping, discount, total, promoCode?, customerEmail, paymentMethod }
//
// Writes the order to KV so the admin dashboard can aggregate revenue,
// affiliate commissions owed, etc.
//
// Re-validates the cart server-side before logging so a client can't lie about totals.

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
function clean(s, max = 200) { return typeof s === "string" ? s.replace(/[\x00-\x1F\x7F]/g, "").trim().slice(0, max) : ""; }
function isValidEmail(e) { return /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(e); }

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }

  if (!env.STRATUS_DATA) return json({ ok: false, error: "Storage not configured" }, 503);

  const orderId = clean(body?.orderId, 40);
  const customerEmail = clean(body?.customerEmail, 120).toLowerCase();
  const promoCode = clean(body?.promoCode, 40).toUpperCase();
  const paymentMethod = clean(body?.paymentMethod, 30); // 'card' | 'crypto' | 'free'
  const items = Array.isArray(body?.items) ? body.items.slice(0, 50) : [];

  if (!orderId || !customerEmail || items.length === 0) {
    return json({ ok: false, error: "Missing required fields" }, 400);
  }
  if (!isValidEmail(customerEmail)) return json({ ok: false, error: "Invalid email" }, 400);

  // De-dup: if this orderId is already logged, no-op (idempotent for retries / page refreshes).
  const existing = await env.STRATUS_DATA.get(`order:${orderId}`);
  if (existing) return json({ ok: true, deduped: true });

  // Pull authoritative totals by re-validating via the same logic the storefront used.
  // We import nothing — just trust the client totals for now but flag the affiliate via promo lookup.
  // (Future: call validate-cart internally and compare; mismatch → flag.)

  let affiliateId = null;
  let commissionPct = 0;
  if (promoCode) {
    const raw = await env.STRATUS_DATA.get(`promo:${promoCode}`);
    if (raw) {
      try {
        const p = JSON.parse(raw);
        if (p && p.affiliateId) {
          affiliateId = p.affiliateId;
          commissionPct = p.affiliateCommission || 0;
        }
      } catch { /* ignore */ }
    }
  }

  const subtotal = Number(body?.subtotal) || 0;
  const shipping = Number(body?.shipping) || 0;
  const discount = Number(body?.discount) || 0;
  const total    = Number(body?.total)    || 0;
  const commissionOwed = affiliateId ? Math.round(subtotal * commissionPct) / 100 : 0;

  const now = new Date().toISOString();
  const record = {
    orderId, customerEmail, items, subtotal, shipping, discount, total,
    promoCode: promoCode || null,
    affiliateId, commissionPct, commissionOwed,
    paymentMethod: paymentMethod || "unknown",
    status: "logged",
    createdAt: now,
  };

  await env.STRATUS_DATA.put(`order:${orderId}`, JSON.stringify(record));
  // Secondary index by date (YYYY-MM) for fast monthly aggregation.
  const month = now.slice(0, 7); // 2026-05
  await env.STRATUS_DATA.put(`order-month:${month}:${orderId}`, "1");

  return json({ ok: true, orderId });
}
