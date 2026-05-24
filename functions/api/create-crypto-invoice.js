// Cloudflare Pages Function — proxy creating multi-coin crypto invoices.
//
// POST /api/create-crypto-invoice
// Body: { orderId, payCurrency }
//   payCurrency: 'btc' | 'eth' | 'usdc' | 'usdt' | 'sol' | 'ltc' | 'xrp' | 'doge'
// Returns: { ok, invoiceUrl }
//
// Used by the existing "Cryptocurrency (100+ coins)" payment option on
// checkout. We keep the customer-pays-on-NOWPayments-hosted-page UX (so they
// get the nice QR code, address, and countdown timer NOWPayments provides),
// but route the API call through our server so the API key never ships to
// the browser.
//
// The BTC Buddies flow uses /api/create-btc-invoice instead because it needs
// the raw pay_address (not the hosted invoice URL) to pass to BTC Buddies.
//
// Env vars: NOWPAYMENTS_API_KEY (secret, server-only).

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

const NP_API = "https://api.nowpayments.io/v1";
const ALLOWED_COINS = new Set(["btc", "eth", "usdc", "usdt", "sol", "ltc", "xrp", "doge"]);

export async function onRequestPost({ request, env }) {
  if (!env.NOWPAYMENTS_API_KEY) {
    return json({ ok: false, error: "Payment provider not configured" }, 503);
  }
  if (!env.STRATUS_DATA) {
    return json({ ok: false, error: "Storage not configured" }, 503);
  }

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }

  const orderId = String(body?.orderId || "").trim();
  const payCurrency = String(body?.payCurrency || "").toLowerCase().trim();
  if (!orderId) return json({ ok: false, error: "Missing orderId" }, 400);
  if (!ALLOWED_COINS.has(payCurrency)) {
    return json({ ok: false, error: `Unsupported coin: ${payCurrency}` }, 400);
  }

  // Look up the order so we use authoritative server-side total + email, not
  // values from the browser (which could be tampered with).
  const raw = await env.STRATUS_DATA.get(`order:${orderId}`);
  if (!raw) return json({ ok: false, error: "Order not found. Place the order first." }, 404);
  const order = JSON.parse(raw);

  if (order.paymentStatus === "paid") {
    return json({ ok: false, error: "Order is already paid" }, 409);
  }

  const totalUsd = Number(order.total) || 0;
  if (totalUsd <= 0) return json({ ok: false, error: "Order total must be positive" }, 400);

  const origin = new URL(request.url).origin;

  const npRes = await fetch(`${NP_API}/invoice`, {
    method: "POST",
    headers: {
      "x-api-key": env.NOWPAYMENTS_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      price_amount: totalUsd,
      price_currency: "usd",
      pay_currency: payCurrency,
      order_id: orderId,
      order_description: `Stratus Biolabs order ${orderId}`,
      ipn_callback_url: `${origin}/api/nowpayments-webhook`,
      success_url: `${origin}/checkout.html?success=true`,
      cancel_url: `${origin}/checkout.html`,
    }),
  });

  const data = await npRes.json().catch(() => ({}));
  if (!npRes.ok || !data.invoice_url) {
    const msg = data.message || data.error || `NOWPayments HTTP ${npRes.status}`;
    return json({ ok: false, error: `Could not create invoice: ${msg}` }, 502);
  }

  // Record the invoice on the order so the IPN webhook can match incoming
  // payments back to it (NOWPayments includes our orderId in the IPN payload
  // but also tags the invoice with a payment_id once payment starts).
  order.nowpaymentsInvoiceUrl = data.invoice_url;
  order.nowpaymentsInvoiceId = String(data.id || data.invoice_id || "");
  order.nowpaymentsPayCurrency = payCurrency.toUpperCase();
  await env.STRATUS_DATA.put(`order:${orderId}`, JSON.stringify(order));

  return json({ ok: true, invoiceUrl: data.invoice_url, invoiceId: order.nowpaymentsInvoiceId });
}
