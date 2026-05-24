// Cloudflare Pages Function — NOWPayments IPN (Instant Payment Notification).
//
// POST /api/nowpayments-webhook
// Headers: x-nowpayments-sig: <HMAC-SHA512 of sorted JSON body using IPN_SECRET>
// Body:    NOWPayments payment payload (payment_id, payment_status, etc.)
//
// Flow when this fires:
//   1. Validate HMAC signature (reject anything we can't verify — webhook URL
//      is public so anyone could POST to it)
//   2. Match payment_id back to our orderId via the np-payment:* index
//   3. If status is 'finished' or 'confirmed' (paid in full):
//        - mark order paymentStatus='paid'
//        - mark order paymentChannel='Card (BTC Buddies)' (or 'NOWPayments Direct')
//        - record payment reference (txid)
//        - reset rapidStatus to 'pending'
//        - call /api/place-order to trigger Rapid dispatch
//   4. Other statuses (waiting, confirming, partially_paid, failed, expired)
//      are recorded but don't trigger dispatch.
//
// NOWPayments status reference:
//   waiting          — invoice created, no payment seen
//   confirming       — BTC arrived, awaiting confirmations
//   confirmed        — has confirmations, not yet finalized
//   sending          — NOWPayments converting/forwarding
//   partially_paid   — customer underpaid
//   finished         — fully paid + settled
//   failed           — something broke
//   refunded         — funds returned to sender
//   expired          — rate window passed before payment arrived
//
// Env vars:
//   NOWPAYMENTS_IPN_SECRET (secret) — copy from NOWPayments dashboard → Profile → IPN
//
// Until that secret is set we accept webhooks without sig validation BUT only
// log status changes; we never auto-mark paid. This lets us see traffic during
// initial setup without trusting unauthenticated payloads.

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

// NOWPayments signs the IPN with HMAC-SHA512 of a JSON body where keys are
// recursively sorted alphabetically (their PHP reference uses ksort + json_encode).
// We reproduce that and compare against the x-nowpayments-sig header.
function sortKeysDeep(obj) {
  if (Array.isArray(obj)) return obj.map(sortKeysDeep);
  if (obj && typeof obj === "object") {
    return Object.keys(obj).sort().reduce((acc, k) => {
      acc[k] = sortKeysDeep(obj[k]);
      return acc;
    }, {});
  }
  return obj;
}

async function hmacSha512Hex(key, msg) {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw", enc.encode(key),
    { name: "HMAC", hash: "SHA-512" },
    false, ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(msg));
  return Array.from(new Uint8Array(sigBuf))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

export async function onRequestPost({ request, env }) {
  if (!env.STRATUS_DATA) return json({ ok: false, error: "Storage not configured" }, 503);

  // Buffer the raw body so we can verify the signature against the exact bytes
  // we received before parsing it.
  const rawBody = await request.text();
  let payload;
  try { payload = JSON.parse(rawBody); }
  catch { return json({ ok: false, error: "Invalid JSON" }, 400); }

  // Verify signature when secret is configured. Without it we still log the
  // event for diagnostics but refuse to perform any state-changing action.
  let sigVerified = false;
  if (env.NOWPAYMENTS_IPN_SECRET) {
    const incomingSig = request.headers.get("x-nowpayments-sig") || "";
    const sortedJson = JSON.stringify(sortKeysDeep(payload));
    const expected = await hmacSha512Hex(env.NOWPAYMENTS_IPN_SECRET, sortedJson);
    sigVerified = timingSafeEqual(expected, incomingSig);
    if (!sigVerified) {
      // Log + reject. We want to know if someone's probing us.
      console.warn("IPN signature mismatch", {
        haveSig: !!incomingSig,
        paymentId: payload.payment_id,
      });
      return json({ ok: false, error: "Signature verification failed" }, 401);
    }
  }

  const paymentId = String(payload.payment_id || "");
  if (!paymentId) return json({ ok: false, error: "Missing payment_id" }, 400);

  // Resolve payment_id -> orderId via our secondary index.
  const orderId = await env.STRATUS_DATA.get(`np-payment:${paymentId}`);
  if (!orderId) return json({ ok: false, error: "No matching order for payment_id" }, 404);

  const raw = await env.STRATUS_DATA.get(`order:${orderId}`);
  if (!raw) return json({ ok: false, error: "Order not found" }, 404);
  const order = JSON.parse(raw);

  const status = String(payload.payment_status || "").toLowerCase();
  const now = new Date().toISOString();

  // Always record the latest IPN data for debugging / audit, even when we
  // don't change order state.
  order.nowpaymentsLastIpn = {
    receivedAt: now,
    status,
    actuallyPaidUsd: Number(payload.actually_paid_at_fiat) || Number(payload.actually_paid) || null,
    txid: payload.payin_hash || payload.outcome_hash || null,
    sigVerified,
  };

  // Only flip to paid when NOWPayments says the payment is fully settled
  // AND we verified the signature. Don't trust 'confirmed' on its own —
  // 'finished' is the terminal "money is yours" state.
  const isPaid = sigVerified && (status === "finished");

  if (isPaid && order.paymentStatus !== "paid") {
    order.paymentStatus = "paid";
    order.paymentReceivedAt = now;
    order.paymentChannel = order.paymentMethod === "crypto" ? "NOWPayments (crypto)" : "Card (BTC Buddies)";
    order.paymentReference = payload.payin_hash || payload.outcome_hash || `np-${paymentId}`;
    order.rapidStatus = "pending";
    order.rapidError = null;

    await env.STRATUS_DATA.put(`order:${orderId}`, JSON.stringify(order));

    // Trigger Rapid dispatch in the background — same pattern as mark-paid.js.
    try {
      const dispatchUrl = new URL("/api/place-order", request.url).toString();
      const res = await fetch(dispatchUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId }),
      });
      // We don't surface dispatch result to NOWPayments — the IPN is about
      // the BTC payment, not Rapid. Admin will see Rapid status in /admin.
      await res.json().catch(() => null);
    } catch (e) {
      // Best-effort. The order is paid; admin can retry dispatch.
    }
    return json({ ok: true, status: "paid_and_dispatched", orderId });
  }

  // For non-terminal statuses we just persist the IPN data so admin can see
  // the live status in the order details modal.
  await env.STRATUS_DATA.put(`order:${orderId}`, JSON.stringify(order));
  return json({ ok: true, status, orderId, sigVerified });
}

// NOWPayments sometimes pre-flights with GET. Respond OK.
export async function onRequestGet() {
  return json({ ok: true, hint: "POST IPN payloads here" });
}
