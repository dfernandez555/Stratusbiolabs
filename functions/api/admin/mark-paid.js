// Cloudflare Pages Function — admin marks an invoice order as paid.
//
// POST /api/admin/mark-paid
// Header: X-Admin-Password: <password>   (or password in body for legacy callers)
// Body: { orderId, paymentChannel, paymentReference, note? }
//   paymentChannel ∈ { 'Cash App', 'Zelle', 'Other' }  (UI-validated, server re-checks)
//   paymentReference = sender name / txn id / free-form (depends on channel)
//
// Flow:
//   1. Verify admin password
//   2. Load order from KV
//   3. Refuse if order isn't an invoice or is already paid (idempotent if already paid)
//   4. Flip paymentStatus -> 'paid', stamp paymentReceivedAt + paymentChannel + paymentReference
//   5. Reset rapidStatus to 'pending' so /api/place-order can now dispatch it
//   6. Best-effort: call /api/place-order internally so dispatch happens immediately
//      (admin can also retry manually from the dashboard if this fails)
//
// We keep the dispatch call separate from the KV write so even if Rapid is
// down the order is still marked paid — the admin can retry dispatch later.

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
function unauth() { return json({ ok: false, error: "Unauthorized" }, 401); }
function clean(s, max = 200) { return typeof s === "string" ? s.replace(/[\x00-\x1F\x7F]/g, "").trim().slice(0, max) : ""; }

function isAuthed(request, env, bodyPwd) {
  if (!env.ADMIN_PASSWORD) return false;
  const hdr = request.headers.get("X-Admin-Password") || "";
  return (hdr === env.ADMIN_PASSWORD) || (bodyPwd === env.ADMIN_PASSWORD);
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }

  if (!isAuthed(request, env, body?.adminPassword)) return unauth();
  if (!env.STRATUS_DATA) return json({ ok: false, error: "Storage not configured" }, 503);

  const ALLOWED_CHANNELS = ["Cash App", "Zelle", "Other"];

  const orderId = clean(body?.orderId, 40);
  const paymentChannel = clean(body?.paymentChannel, 30);
  const paymentReference = clean(body?.paymentReference, 100);
  const note = clean(body?.note, 300);
  if (!orderId) return json({ ok: false, error: "Missing orderId" }, 400);
  if (!ALLOWED_CHANNELS.includes(paymentChannel)) {
    return json({ ok: false, error: `Invalid payment method. Must be one of: ${ALLOWED_CHANNELS.join(", ")}` }, 400);
  }
  if (!paymentReference) return json({ ok: false, error: "Payment reference is required (Cash App sender name, Zelle txn id, etc.)" }, 400);

  const raw = await env.STRATUS_DATA.get(`order:${orderId}`);
  if (!raw) return json({ ok: false, error: "Order not found" }, 404);
  const order = JSON.parse(raw);

  if (order.paymentStatus === "paid") {
    return json({ ok: true, alreadyPaid: true, order: { orderId, paymentStatus: "paid", paymentReceivedAt: order.paymentReceivedAt } });
  }

  // Refuse on anything other than invoice-style awaiting_payment to keep semantics clean.
  if (order.paymentStatus !== "awaiting_payment") {
    return json({ ok: false, error: `Order is in state '${order.paymentStatus || "unknown"}'. Only awaiting_payment orders can be marked paid.` }, 409);
  }

  const now = new Date().toISOString();
  order.paymentStatus     = "paid";
  order.paymentReceivedAt = now;
  order.paymentChannel    = paymentChannel;    // 'Cash App' | 'Zelle' | 'Other'
  order.paymentReference  = paymentReference;
  if (note) order.paymentNote = note;
  // Free dispatch from the block. We don't pre-set "dispatched" — the actual SOAP call decides.
  if (order.rapidStatus === "blocked_pending_payment") {
    order.rapidStatus = "pending";
    order.rapidError = null;
  }
  await env.STRATUS_DATA.put(`order:${orderId}`, JSON.stringify(order));

  // Best-effort: kick off dispatch. We do this server-side (rather than making
  // the admin browser do it) so the admin sees fresh dispatch status next refresh.
  // Any failure is non-fatal — the KV write above already committed.
  let dispatchResult = null;
  try {
    // We can't easily fetch our own host from inside Pages Functions without
    // hardcoding the URL, so call the dispatcher logic via fetch on a relative
    // URL. Pages Functions support same-origin fetch.
    const dispatchUrl = new URL("/api/place-order", request.url);
    const dispatchRes = await fetch(dispatchUrl.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Pass admin password so place-order knows this is a privileged call.
        // (place-order doesn't strictly require it, but keeps semantics consistent.)
      },
      body: JSON.stringify({ orderId, adminPassword: env.ADMIN_PASSWORD }),
    });
    dispatchResult = await dispatchRes.json().catch(() => ({ ok: false, error: "Bad dispatch response" }));
  } catch (e) {
    dispatchResult = { ok: false, error: String(e.message || e).slice(0, 200) };
  }

  return json({
    ok: true,
    orderId,
    paymentStatus: "paid",
    paymentReceivedAt: now,
    paymentReference,
    dispatch: dispatchResult,
  });
}
