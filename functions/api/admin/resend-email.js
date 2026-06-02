// Cloudflare Pages Function — admin resends an order's customer-facing email.
//
// POST /api/admin/resend-email
// Body: { orderId }
//
// Useful when:
//   - An order was placed before we shipped the customer-email codepath (e.g.
//     Martin's SB-582950 — Invoice orders pre-fix didn't email customers)
//   - The original email bounced / went to spam and the customer never saw it
//   - Admin wants to forward a copy of payment instructions to a different
//     address than the customer originally entered
//
// Picks the right email template based on the order's paymentMethod:
//   cashapp / zelle  -> sendInvoiceOrderEmail
//   btcbuddies       -> sendBtcBuddiesOrderEmail (needs BTC address — pulls
//                       from nowpaymentsPayAddress / nowpaymentsPayAmount
//                       on the order record)
//
// Auth: admin password required (header).

import {
  sendInvoiceOrderEmail,
  sendBtcBuddiesOrderEmail,
  sendPaymentConfirmedEmail,
} from "../../_lib/resend.js";

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

  const orderId = clean(body?.orderId, 40);
  const which   = clean(body?.which, 30) || "order";   // 'order' | 'payment_confirmed'
  if (!orderId) return json({ ok: false, error: "Missing orderId" }, 400);

  const raw = await env.STRATUS_DATA.get(`order:${orderId}`);
  if (!raw) return json({ ok: false, error: "Order not found" }, 404);
  const order = JSON.parse(raw);

  let result;
  if (which === "payment_confirmed") {
    result = await sendPaymentConfirmedEmail(env, { order });
  } else {
    const method = String(order.paymentMethod || "").toLowerCase();
    if (method === "cashapp" || method === "zelle") {
      result = await sendInvoiceOrderEmail(env, { order });
    } else if (method === "btcbuddies") {
      if (!order.nowpaymentsPayAddress || !order.nowpaymentsPayAmount) {
        return json({ ok: false, error: "BTC Buddies order has no recorded BTC address — cannot resend payment instructions" }, 409);
      }
      result = await sendBtcBuddiesOrderEmail(env, {
        order,
        payAddress: order.nowpaymentsPayAddress,
        payAmount: order.nowpaymentsPayAmount,
      });
    } else {
      return json({ ok: false, error: `No customer email template for paymentMethod='${method}'` }, 400);
    }
  }

  if (!result || !result.ok) {
    return json({ ok: false, error: (result && result.error) || "Email send failed" }, 502);
  }

  // Stamp on the order so admin sees the resend in /admin.
  order.lastResendAt = new Date().toISOString();
  order.lastResendId = result.id;
  await env.STRATUS_DATA.put(`order:${orderId}`, JSON.stringify(order));

  return json({ ok: true, orderId, emailId: result.id, which });
}
