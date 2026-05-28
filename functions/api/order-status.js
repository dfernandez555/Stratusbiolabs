// Cloudflare Pages Function — public order status lookup.
//
// GET /api/order-status?id=SB-XXXXXX&t=TOKEN
//
// Used by the customer-facing /track page. Returns a SANITIZED view of the
// order — no admin fields (commission, internal notes, raw Rapid errors,
// etc.), only what the customer cares about: order summary + payment status
// + dispatch status + tracking number if available.
//
// Auth is by per-order statusToken (generated in log-order.js at order
// creation time). This makes order IDs guessable but order data only
// retrievable if you have the link we emailed the customer.

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      // Customer-facing endpoint — cache for 15s at the edge so polling
      // doesn't hammer KV.
      "Cache-Control": "public, max-age=15",
    },
  });
}

export async function onRequestGet({ request, env }) {
  if (!env.STRATUS_DATA) return json({ ok: false, error: "Storage not configured" }, 503);

  const url = new URL(request.url);
  const orderId = String(url.searchParams.get("id") || "").trim().toUpperCase();
  const token   = String(url.searchParams.get("t")  || "").trim();

  if (!orderId || !token) {
    return json({ ok: false, error: "Missing id or t parameter" }, 400);
  }

  const raw = await env.STRATUS_DATA.get(`order:${orderId}`);
  if (!raw) return json({ ok: false, error: "Order not found" }, 404);

  let order;
  try { order = JSON.parse(raw); }
  catch { return json({ ok: false, error: "Order record corrupted" }, 500); }

  // Constant-time-ish token comparison. Don't reveal whether the order
  // existed but had a bad token — same 404 for both cases.
  if (!order.statusToken || order.statusToken !== token) {
    return json({ ok: false, error: "Order not found" }, 404);
  }

  // Sanitize: only the fields the customer should see.
  const ps = order.paymentStatus || (order.paymentMethod === "invoice" ? "awaiting_payment" : "paid");
  const rs = order.rapidStatus || "pending";
  const isCancelled = order.status === "cancelled" || ps === "cancelled";

  // Friendly stage progression used by the /track page to light up the
  // checkmarks. Order: received → payment_confirmed → in_fulfillment → shipped.
  const stages = {
    received:          { done: true,                                                          at: order.createdAt },
    payment_confirmed: { done: ps === "paid",                                                 at: order.paymentReceivedAt || null },
    in_fulfillment:    { done: rs === "dispatched" || rs === "dispatched_then_cancelled",     at: order.rapidDispatchedAt || null },
    shipped:           { done: !!order.shippedAt,                                             at: order.shippedAt || null },
  };

  return json({
    ok: true,
    order: {
      orderId: order.orderId,
      total: order.total,
      paymentMethod: order.paymentMethod,
      createdAt: order.createdAt,
      items: (order.items || []).map(it => ({
        name: it.name,
        sizeKey: it.sizeKey,
        qty: it.qty,
      })),
      shippingTo: {
        firstName: order.shippingAddress?.firstName || null,
        city:      order.shippingAddress?.city      || null,
        state:     order.shippingAddress?.state     || null,
      },
      paymentStatus: ps,
      isCancelled,
      stages,
      trackingNumber: order.trackingNumber || null,
    },
  });
}
