// Cloudflare Pages Function — sync order status from Rapid.
//
// POST /api/admin/sync-rapid
// Body: { orderId }   — sync a single order
//   OR: { all: true } — sync every non-finalized order in KV (slower; used
//        by the "Refresh all from Rapid" button on the admin dashboard)
//
// For each order we hit Rapid's `orders_get` SOAP method, normalize the
// status, and update our KV record if it differs. Specifically:
//   - Rapid reports cancelled  → flip our rapidStatus to cancelled +
//     status to cancelled. Surfaces in /admin so the user knows not to
//     expect a shipment.
//   - Rapid reports shipped    → record tracking number + shippedAt
//     timestamp; rapidStatus stays "dispatched".
//
// Authoritative direction is Rapid → us (so if ops cancels in their CRM,
// our admin reflects it). We don't push status changes the other way here
// — that's what /api/admin/order action=cancel does.

import { rapidGetOrderStatus, orderIdToRapidNumeric } from "../../_lib/rapid.js";

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

// Reconcile an existing KV order record against fresh Rapid status data.
// Returns { changed: bool, updates: {...}, summary: "..." }
function reconcile(order, rapidStatus) {
  const updates = {};
  let changed = false;

  // Cancelled on Rapid side → mirror locally
  if (rapidStatus.status === "cancelled" && order.status !== "cancelled") {
    updates.status = "cancelled";
    updates.rapidStatus = "cancelled";
    updates.cancelledAt = order.cancelledAt || new Date().toISOString();
    updates.cancelReason = order.cancelReason || `Cancelled in Rapid CRM (raw status: ${rapidStatus.rawStatus || "—"})`;
    updates.cancelSyncedFrom = "rapid";
    changed = true;
  }

  // Shipped on Rapid side → record tracking and shippedAt
  if (rapidStatus.status === "shipped") {
    if (rapidStatus.shippedAt && !order.shippedAt) {
      updates.shippedAt = rapidStatus.shippedAt;
      changed = true;
    }
    if (rapidStatus.trackingNumber && order.trackingNumber !== rapidStatus.trackingNumber) {
      updates.trackingNumber = rapidStatus.trackingNumber;
      changed = true;
    }
  }

  // Always stamp the last-sync timestamp
  updates.rapidLastSyncedAt = new Date().toISOString();
  if (rapidStatus.rawStatus) updates.rapidRawStatus = rapidStatus.rawStatus;

  return { changed, updates };
}

async function syncOne(env, orderId) {
  const raw = await env.STRATUS_DATA.get(`order:${orderId}`);
  if (!raw) return { ok: false, error: "Order not found", orderId };
  const order = JSON.parse(raw);

  const numericId = orderIdToRapidNumeric(orderId);
  if (!numericId) return { ok: false, error: "Order ID has no numeric component", orderId };

  const rapidStatus = await rapidGetOrderStatus(env, numericId);
  if (!rapidStatus.ok) {
    return { ok: false, error: rapidStatus.error, orderId };
  }

  const { changed, updates } = reconcile(order, rapidStatus);
  if (changed) {
    const merged = { ...order, ...updates };
    await env.STRATUS_DATA.put(`order:${orderId}`, JSON.stringify(merged));
  } else if (updates.rapidLastSyncedAt) {
    // Still update the sync timestamp even if nothing changed.
    await env.STRATUS_DATA.put(`order:${orderId}`, JSON.stringify({ ...order, ...updates }));
  }

  return {
    ok: true,
    orderId,
    changed,
    rapidStatus: rapidStatus.status,
    rawStatus: rapidStatus.rawStatus,
    updates: changed ? updates : null,
  };
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
  if (!isAuthed(request, env, body?.adminPassword)) return unauth();
  if (!env.STRATUS_DATA) return json({ ok: false, error: "Storage not configured" }, 503);

  // Single-order sync
  if (body?.orderId) {
    const result = await syncOne(env, clean(body.orderId, 40));
    return json(result);
  }

  // Bulk sync (admin button "Refresh all from Rapid")
  if (body?.all === true) {
    // List all orders. We could filter to non-final, but a small N (<1000)
    // is cheap enough to iterate. Limit explicitly to avoid runaway runs.
    const idx = await env.STRATUS_DATA.list({ prefix: "order:", limit: 200 });
    const orderIds = idx.keys.map(k => k.name.substring("order:".length));

    const results = [];
    let changed = 0;
    let failed = 0;
    // Sequential — concurrent SOAP login flood would hammer Rapid.
    for (const id of orderIds) {
      const r = await syncOne(env, id);
      results.push(r);
      if (r.ok && r.changed) changed += 1;
      if (!r.ok) failed += 1;
    }
    return json({
      ok: true,
      checked: results.length,
      changed,
      failed,
      results,
    });
  }

  return json({ ok: false, error: "Provide either orderId or all:true" }, 400);
}
