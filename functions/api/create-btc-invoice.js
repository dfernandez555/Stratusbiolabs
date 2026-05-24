// Cloudflare Pages Function — create a BTC invoice via NOWPayments.
//
// POST /api/create-btc-invoice
// Body: { orderId }
// Returns: { ok, paymentId, payAddress, payAmount, payCurrency, expiresAt }
//
// Used by the "Card via BTC Buddies" checkout flow. We create a real BTC
// invoice with NOWPayments which gives us:
//   - A unique BTC address per order (no commingling)
//   - A locked BTC amount for the rate window (~20-60 minutes)
//   - A payment_id we can match against incoming IPN webhooks
//   - Confirmation tracking handled entirely by NOWPayments
//
// The customer then sends fiat -> BTC Buddies -> our NOWPayments address.
// When NOWPayments confirms the BTC on-chain, their IPN webhook hits
// /api/nowpayments-webhook which auto-marks the order paid + dispatches
// to Rapid.
//
// Env vars required:
//   NOWPAYMENTS_API_KEY  (secret) — server-side only, never exposed to browser
//
// Order pre-condition: must have been logged via /api/log-order first so we
// know the total + can update its NOWPayments invoice ID on the record.

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

const NP_API = "https://api.nowpayments.io/v1";

export async function onRequestPost({ request, env }) {
  if (!env.NOWPAYMENTS_API_KEY) {
    return json({ ok: false, error: "Payment provider not configured (NOWPAYMENTS_API_KEY)" }, 503);
  }
  if (!env.STRATUS_DATA) {
    return json({ ok: false, error: "Storage not configured" }, 503);
  }

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
  const orderId = String(body?.orderId || "").trim();
  if (!orderId) return json({ ok: false, error: "Missing orderId" }, 400);

  // Look up the order so we can pull the authoritative total + customer email.
  // The browser can't be trusted to send these in this endpoint — they came
  // from the cart and might have been tampered with.
  const raw = await env.STRATUS_DATA.get(`order:${orderId}`);
  if (!raw) return json({ ok: false, error: "Order not found. Place the order first." }, 404);
  const order = JSON.parse(raw);

  if (order.paymentStatus === "paid") {
    return json({ ok: false, error: "Order is already paid" }, 409);
  }

  const totalUsd = Number(order.total) || 0;
  if (totalUsd <= 0) {
    return json({ ok: false, error: "Order total must be positive" }, 400);
  }

  // Create the BTC payment via NOWPayments.
  // /v1/payment — creates a single-coin payment with a fixed address (vs
  // /v1/invoice which gives a hosted page where customer picks coin).
  // We want the raw BTC address so the customer can hand it to BTC Buddies.
  const npRes = await fetch(`${NP_API}/payment`, {
    method: "POST",
    headers: {
      "x-api-key": env.NOWPAYMENTS_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      price_amount: totalUsd,
      price_currency: "usd",
      pay_currency: "btc",
      order_id: orderId,
      order_description: `Stratus Biolabs order ${orderId}`,
      ipn_callback_url: new URL("/api/nowpayments-webhook", request.url).toString(),
    }),
  });

  const npData = await npRes.json().catch(() => ({}));
  if (!npRes.ok || !npData.pay_address) {
    const msg = npData.message || npData.error || `NOWPayments HTTP ${npRes.status}`;
    return json({ ok: false, error: `Could not create BTC invoice: ${msg}` }, 502);
  }

  // Record the NOWPayments details on the order so the webhook can match
  // incoming IPNs back to this order, and the customer can re-load the
  // success page later and still see the same address.
  order.nowpaymentsPaymentId = String(npData.payment_id);
  order.nowpaymentsPayAddress = String(npData.pay_address);
  order.nowpaymentsPayAmount = Number(npData.pay_amount) || 0;   // BTC amount due
  order.nowpaymentsPayCurrency = "BTC";
  order.nowpaymentsExpiresAt = npData.expiration_estimate_date || null;
  await env.STRATUS_DATA.put(`order:${orderId}`, JSON.stringify(order));

  // Secondary index so the webhook can look up an order by NOWPayments
  // payment_id without scanning all keys.
  await env.STRATUS_DATA.put(`np-payment:${npData.payment_id}`, orderId);

  return json({
    ok: true,
    paymentId: order.nowpaymentsPaymentId,
    payAddress: order.nowpaymentsPayAddress,
    payAmount: order.nowpaymentsPayAmount,
    payCurrency: "BTC",
    priceAmountUsd: totalUsd,
    expiresAt: order.nowpaymentsExpiresAt,
  });
}
