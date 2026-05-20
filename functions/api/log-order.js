// Cloudflare Pages Function — log a completed order.
//
// POST /api/log-order
// Body: { orderId, items, subtotal, shipping, discount, total, promoCode?,
//         customerEmail, paymentMethod,
//         shipping: { firstName, lastName, address, address2, city, state, zip, country, phone? } }
//
// Writes the order to KV so the admin dashboard can aggregate revenue,
// affiliate commissions owed, and so /api/place-order has the full data
// needed to dispatch to Rapid Fulfillment.

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
  const shippingCost = Number(body?.shipping) || 0;
  const discount = Number(body?.discount) || 0;
  const total    = Number(body?.total)    || 0;
  const commissionOwed = affiliateId ? Math.round(subtotal * commissionPct) / 100 : 0;

  // Capture full shipping address — needed by /api/place-order to dispatch
  // to Rapid. Defensive: missing pieces fall through; dispatcher will reject.
  const shipObj = body?.shippingAddress || {};
  const shippingAddress = {
    firstName: clean(shipObj.firstName, 50),
    lastName:  clean(shipObj.lastName, 50),
    address:   clean(shipObj.address, 100),
    address2:  clean(shipObj.address2, 50),
    city:      clean(shipObj.city, 50),
    state:     clean(shipObj.state, 40),
    zip:       clean(shipObj.zip, 20),
    country:   clean(shipObj.country, 60),
    phone:     clean(shipObj.phone, 30),
    institution: clean(shipObj.institution, 100),
    notes:     clean(shipObj.notes, 400),
  };

  const now = new Date().toISOString();
  const record = {
    orderId, customerEmail, items,
    subtotal, shipping: shippingCost, discount, total,
    promoCode: promoCode || null,
    affiliateId, commissionPct, commissionOwed,
    paymentMethod: paymentMethod || "unknown",
    shippingAddress,
    status: "logged",
    rapidStatus: "pending",  // pending | dispatched | failed | cancelled
    rapidDispatchedAt: null,
    rapidError: null,
    createdAt: now,
  };

  await env.STRATUS_DATA.put(`order:${orderId}`, JSON.stringify(record));
  // Secondary index by date (YYYY-MM) for fast monthly aggregation.
  const month = now.slice(0, 7); // 2026-05
  await env.STRATUS_DATA.put(`order-month:${month}:${orderId}`, "1");

  return json({ ok: true, orderId });
}
