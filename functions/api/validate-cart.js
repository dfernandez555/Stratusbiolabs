// Cloudflare Pages Function — server-side cart validation.
//
// Endpoint:  POST /api/validate-cart
// Request:   { items: [{sku, sizeKey, qty}], promoCode?: string }
// Response:  { ok, lineItems, subtotal, shipping, discount, total, promoApplied }
//        or  { ok: false, error }
//
// All pricing logic lives in functions/_lib/pricing.js so that /api/log-order
// can apply the exact same rules server-side without trusting browser totals.

import { computeCart } from "../_lib/pricing.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "Invalid JSON" }, 400); }

  const result = await computeCart({ items: body?.items, promoCode: body?.promoCode }, env);
  if (!result.ok) return json({ ok: false, error: result.error }, 400);

  // Don't leak promoRaw to the browser — that's only used by log-order to
  // capture affiliateCommission etc. on the order record.
  const { ok, lineItems, subtotal, shipping, discount, total, promoApplied } = result;
  return json({ ok, lineItems, subtotal, shipping, discount, total, promoApplied });
}
