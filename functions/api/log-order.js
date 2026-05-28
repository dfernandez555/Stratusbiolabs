// Cloudflare Pages Function — log a completed order.
//
// POST /api/log-order
// Body: { orderId, items, promoCode?, customerEmail, paymentMethod,
//         shippingAddress: { firstName, lastName, address, ..., researchField } }
//
// IMPORTANT: server re-computes subtotal/shipping/discount/total from
// authoritative SKU table (functions/_lib/pricing.js). Browser-supplied
// totals are IGNORED. This closes BUG-019 — without this, a tampered
// browser could submit a $0 cart for $1000 of products and we'd log $0.

import { computeCart } from "../_lib/pricing.js";
import { sendAdminOrderNotificationEmail } from "../_lib/resend.js";

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
  const paymentMethod = clean(body?.paymentMethod, 30); // 'cashapp' | 'zelle' | 'btcbuddies' | 'crypto' | 'free'

  if (!orderId || !customerEmail) {
    return json({ ok: false, error: "Missing required fields" }, 400);
  }
  if (!isValidEmail(customerEmail)) return json({ ok: false, error: "Invalid email" }, 400);

  // De-dup: if this orderId is already logged, no-op (idempotent for retries / page refreshes).
  const existing = await env.STRATUS_DATA.get(`order:${orderId}`);
  if (existing) return json({ ok: true, deduped: true });

  // AUTHORITATIVE pricing. We pass only items (sku + sizeKey + qty) and the
  // promo code through the shared computeCart pipeline so the SAME logic
  // that powers /api/validate-cart determines the money. Whatever totals
  // the browser sent are discarded.
  const items = Array.isArray(body?.items) ? body.items.slice(0, 50) : [];
  if (items.length === 0) {
    return json({ ok: false, error: "Cart is empty" }, 400);
  }
  const priced = await computeCart({ items, promoCode: promoCode || null }, env);
  if (!priced.ok) {
    return json({ ok: false, error: priced.error }, 400);
  }
  const subtotal     = priced.subtotal;
  const shippingCost = priced.shipping;
  const discount     = priced.discount;
  const total        = priced.total;

  // Affiliate attribution comes from the validated promo record (if any).
  // commissionPct is bounded to a sane 0-100 range to prevent a misconfigured
  // promo from creating a giant commission liability.
  let affiliateId = null;
  let commissionPct = 0;
  if (priced.promoRaw && priced.promoRaw.affiliateId) {
    affiliateId  = priced.promoRaw.affiliateId;
    const rawPct = Number(priced.promoRaw.affiliateCommission) || 0;
    commissionPct = Math.max(0, Math.min(100, rawPct));
  }
  const commissionOwed = affiliateId
    ? Math.round((subtotal * commissionPct)) / 100
    : 0;

  // Capture full shipping address — needed by /api/place-order to dispatch
  // to Rapid. Defensive: missing pieces fall through; dispatcher will reject.
  // researchField is required by Ally Pay compliance and re-validated here so
  // a tampered browser can't bypass the dropdown.
  const ALLOWED_RESEARCH_FIELDS = new Set([
    "Pharmacology", "Molecular Biology", "Medicinal Chemistry",
    "Biochemistry", "Endocrinology", "Pharmaceutical Research", "Other",
  ]);
  const shipObj = body?.shippingAddress || {};
  const researchField = clean(shipObj.researchField, 60);
  if (!ALLOWED_RESEARCH_FIELDS.has(researchField)) {
    return json({ ok: false, error: "Valid research field selection required" }, 400);
  }
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
    institution:   clean(shipObj.institution, 100),
    researchField,
    notes:     clean(shipObj.notes, 400),
  };

  const now = new Date().toISOString();

  // Cash App, Zelle, and BTC Buddies orders all start in 'awaiting_payment'
  // and only flip to 'paid' after confirmation:
  //   - Cash App / Zelle: admin manually marks paid in /admin
  //   - BTC Buddies: NOWPayments IPN webhook auto-marks paid when BTC arrives
  // Crypto / free orders are already paid by the time they hit this endpoint.
  // 'invoice' kept for back-compat with any in-flight orders from the prior
  // single-option flow.
  const MANUAL_METHODS = new Set(["cashapp", "zelle", "invoice", "btcbuddies"]);
  const isManual = MANUAL_METHODS.has(paymentMethod);
  const paymentStatus = isManual ? "awaiting_payment" : "paid";
  const rapidStatus   = isManual ? "blocked_pending_payment" : "pending";

  // Store the SERVER-validated line items on the record (with authoritative
  // names + unit prices from SKU_TABLE), not whatever the browser sent. The
  // shape matches what place-order.js + the admin order-details modal
  // already expect: { sku, sizeKey, name, qty, price }.
  const serverItems = priced.lineItems.map(li => ({
    sku:      li.sku,
    sizeKey:  li.sizeKey,
    name:     li.name,
    qty:      li.qty,
    price:    li.unitPrice,
  }));

  const record = {
    orderId, customerEmail,
    items: serverItems,
    subtotal, shipping: shippingCost, discount, total,
    promoCode: promoCode || null,
    affiliateId, commissionPct, commissionOwed,
    paymentMethod: paymentMethod || "unknown",
    shippingAddress,
    status: "logged",
    paymentStatus,           // awaiting_payment | paid | refunded
    paymentReceivedAt: isManual ? null : now,
    paymentReference: null,  // set by /api/admin/mark-paid (Cash App handle, Zelle txn, etc.)
    rapidStatus,             // pending | dispatched | failed | cancelled | blocked_pending_payment
    rapidDispatchedAt: null,
    rapidError: null,
    createdAt: now,
  };

  await env.STRATUS_DATA.put(`order:${orderId}`, JSON.stringify(record));
  // Secondary index by date (YYYY-MM) for fast monthly aggregation.
  const month = now.slice(0, 7); // 2026-05
  await env.STRATUS_DATA.put(`order-month:${month}:${orderId}`, "1");

  // Fire-and-forget admin notification — every new order. We don't block the
  // response on Resend, and we don't fail the order if Resend is down.
  try {
    await sendAdminOrderNotificationEmail(env, { order: record });
  } catch (e) {
    // Best effort; admin can still see the order in /admin even if the
    // notification email failed.
  }

  return json({ ok: true, orderId });
}
