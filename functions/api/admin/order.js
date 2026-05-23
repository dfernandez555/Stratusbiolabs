// Cloudflare Pages Function — admin order detail + state actions.
//
// GET  /api/admin/order?orderId=SB-123456
//      Returns the full order record from KV. Used by the admin "Order Details" modal.
//
// POST /api/admin/order
//      Body: { orderId, action, reason? }
//      action ∈ { 'unmark_paid', 'cancel' }
//
//      'unmark_paid' — flips paymentStatus back to 'awaiting_payment' and re-blocks
//                      Rapid dispatch. Only valid if the order isn't yet dispatched
//                      (we don't want to silently revert a shipment).
//
//      'cancel'      — sets status='cancelled', paymentStatus='cancelled',
//                      rapidStatus='cancelled'. If the order was already dispatched
//                      to Rapid, the caller is warned client-side that they must
//                      also cancel manually in the Rapid CRM. We don't attempt
//                      auto-cancel via SOAP because Rapid's cancellation flow has
//                      side effects (refunds, restocking) that should be a human
//                      decision.
//
// Both actions stamp an audit trail (cancelledAt, unmarkedPaidAt) so we can
// reconstruct order history later if needed.

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

// ── GET: fetch full order detail ────────────────────────────────────
export async function onRequestGet({ request, env }) {
  if (!isAuthed(request, env, null)) return unauth();
  if (!env.STRATUS_DATA) return json({ ok: false, error: "Storage not configured" }, 503);

  const url = new URL(request.url);
  const orderId = clean(url.searchParams.get("orderId"), 40);
  if (!orderId) return json({ ok: false, error: "Missing orderId" }, 400);

  const raw = await env.STRATUS_DATA.get(`order:${orderId}`);
  if (!raw) return json({ ok: false, error: "Order not found" }, 404);

  let order;
  try { order = JSON.parse(raw); }
  catch { return json({ ok: false, error: "Order record corrupted" }, 500); }

  return json({ ok: true, order });
}

// ── POST: state actions ─────────────────────────────────────────────
export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }

  if (!isAuthed(request, env, body?.adminPassword)) return unauth();
  if (!env.STRATUS_DATA) return json({ ok: false, error: "Storage not configured" }, 503);

  const orderId = clean(body?.orderId, 40);
  const action = clean(body?.action, 30);
  const reason = clean(body?.reason, 400);

  if (!orderId) return json({ ok: false, error: "Missing orderId" }, 400);
  if (!["unmark_paid", "cancel"].includes(action)) {
    return json({ ok: false, error: "Invalid action. Must be 'unmark_paid' or 'cancel'." }, 400);
  }

  const raw = await env.STRATUS_DATA.get(`order:${orderId}`);
  if (!raw) return json({ ok: false, error: "Order not found" }, 404);
  const order = JSON.parse(raw);

  const now = new Date().toISOString();

  if (action === "unmark_paid") {
    if (order.paymentStatus !== "paid") {
      return json({ ok: false, error: `Cannot un-mark paid: order is in state '${order.paymentStatus || "unknown"}'.` }, 409);
    }
    if (order.rapidStatus === "dispatched") {
      return json({
        ok: false,
        error: "Order has already been dispatched to Rapid. Un-mark paid is no longer safe — use Cancel Order instead (and also cancel manually in the Rapid CRM).",
      }, 409);
    }
    // Push it back into awaiting_payment state
    order.paymentStatus = "awaiting_payment";
    order.rapidStatus = "blocked_pending_payment";
    order.rapidError = null;
    order.unmarkedPaidAt = now;
    order.previousPaymentChannel = order.paymentChannel || null;
    order.previousPaymentReference = order.paymentReference || null;
    // Keep audit trail but clear the active reference/channel so they get re-entered next time
    order.paymentChannel = null;
    order.paymentReference = null;
    order.paymentReceivedAt = null;

    await env.STRATUS_DATA.put(`order:${orderId}`, JSON.stringify(order));
    return json({ ok: true, orderId, action: "unmark_paid", newPaymentStatus: "awaiting_payment" });
  }

  if (action === "cancel") {
    // Cancellation is allowed from any state — admin's call.
    const wasDispatched = order.rapidStatus === "dispatched";
    order.status = "cancelled";
    order.paymentStatus = "cancelled";
    order.rapidStatus = wasDispatched ? "dispatched_then_cancelled" : "cancelled";
    order.cancelledAt = now;
    if (reason) order.cancelReason = reason;

    await env.STRATUS_DATA.put(`order:${orderId}`, JSON.stringify(order));
    return json({
      ok: true,
      orderId,
      action: "cancel",
      wasDispatched,
      warning: wasDispatched
        ? "Order was already dispatched to Rapid — you must cancel manually in the Rapid CRM as well."
        : null,
    });
  }
}
