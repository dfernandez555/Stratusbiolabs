// Cloudflare Pages Function — admin stats dashboard backend.
//
// GET /api/admin/stats?month=YYYY-MM (optional, defaults to current month)
// Header: X-Admin-Password: <password>  OR  ?password=<password>
//
// Returns aggregated revenue, affiliate breakdown, and recent orders.
//
// Admin password is stored as a Cloudflare Pages env var: ADMIN_PASSWORD.

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function unauth() {
  return json({ ok: false, error: "Unauthorized" }, 401);
}

function isAuthed(request, env) {
  if (!env.ADMIN_PASSWORD) return false; // password not configured = locked down
  const hdr = request.headers.get("X-Admin-Password") || "";
  const url = new URL(request.url);
  const qp  = url.searchParams.get("password") || "";
  return (hdr === env.ADMIN_PASSWORD) || (qp === env.ADMIN_PASSWORD);
}

export async function onRequestGet({ request, env }) {
  if (!isAuthed(request, env)) return unauth();
  if (!env.STRATUS_DATA) return json({ ok: false, error: "Storage not configured" }, 503);

  const url = new URL(request.url);
  const month = url.searchParams.get("month") || new Date().toISOString().slice(0, 7);

  // List order IDs for the requested month.
  const idx = await env.STRATUS_DATA.list({ prefix: `order-month:${month}:`, limit: 1000 });
  const orderIds = idx.keys.map(k => k.name.split(":").pop());

  // Fetch order records in parallel.
  const orderRecs = await Promise.all(
    orderIds.map(id => env.STRATUS_DATA.get(`order:${id}`).then(s => s ? JSON.parse(s) : null))
  );
  const orders = orderRecs.filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  // Aggregate.
  let totalRevenue = 0, orderCount = orders.length;
  const byAffiliate = {}; // affiliateId -> { affiliateId, code, revenue, orders, commissionOwed }

  for (const o of orders) {
    totalRevenue += o.total || 0;
    if (o.affiliateId) {
      const key = o.affiliateId;
      if (!byAffiliate[key]) byAffiliate[key] = { affiliateId: key, code: o.promoCode, revenue: 0, orders: 0, commissionOwed: 0 };
      byAffiliate[key].revenue += o.subtotal || 0;
      byAffiliate[key].orders += 1;
      byAffiliate[key].commissionOwed += o.commissionOwed || 0;
    }
  }

  // Hydrate affiliate names from affiliate records.
  for (const key of Object.keys(byAffiliate)) {
    const aff = await env.STRATUS_DATA.get(`affiliate:${key}`);
    if (aff) {
      try {
        const a = JSON.parse(aff);
        byAffiliate[key].name = `${a.firstName} ${a.lastName}`;
        byAffiliate[key].email = a.email;
        byAffiliate[key].platform = a.platform;
      } catch { /* ignore */ }
    }
  }

  // List of active affiliates (for the dashboard's "applicants" list)
  const affIdx = await env.STRATUS_DATA.list({ prefix: "affiliate:", limit: 1000 });
  const affRecs = await Promise.all(
    affIdx.keys
      .filter(k => !k.name.startsWith("affiliate-email:"))
      .map(k => env.STRATUS_DATA.get(k.name).then(s => s ? JSON.parse(s) : null))
  );
  const affiliates = affRecs.filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return json({
    ok: true,
    month,
    summary: {
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      orderCount,
      affiliateCount: affiliates.filter(a => a.status === "active").length,
      pendingPayoutTotal: Math.round(Object.values(byAffiliate).reduce((s, x) => s + x.commissionOwed, 0) * 100) / 100,
    },
    affiliatesByRevenue: Object.values(byAffiliate)
      .sort((a, b) => b.revenue - a.revenue)
      .map(x => ({ ...x, revenue: Math.round(x.revenue * 100) / 100, commissionOwed: Math.round(x.commissionOwed * 100) / 100 })),
    affiliates: affiliates.map(a => ({
      id: a.id, name: `${a.firstName} ${a.lastName}`, email: a.email,
      code: a.code, platform: a.platform, audienceSize: a.audienceSize,
      status: a.status, createdAt: a.createdAt,
    })),
    recentOrders: orders.slice(0, 100).map(o => ({
      orderId: o.orderId, total: o.total, promoCode: o.promoCode,
      affiliateId: o.affiliateId, commissionOwed: o.commissionOwed,
      paymentMethod: o.paymentMethod, createdAt: o.createdAt,
      customerEmail: o.customerEmail,
      paymentStatus: o.paymentStatus || (o.paymentMethod === "invoice" ? "awaiting_payment" : "paid"),
      paymentReceivedAt: o.paymentReceivedAt || null,
      paymentReference: o.paymentReference || null,
      rapidStatus: o.rapidStatus || "pending",
      rapidError: o.rapidError || null,
      rapidDispatchedAt: o.rapidDispatchedAt || null,
    })),
  });
}

// POST /api/admin/stats — toggle an affiliate's status (active/disabled)
// Body: { affiliateId, status: 'active' | 'disabled' }
export async function onRequestPost({ request, env }) {
  if (!isAuthed(request, env)) return unauth();
  if (!env.STRATUS_DATA) return json({ ok: false, error: "Storage not configured" }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
  const affiliateId = String(body?.affiliateId || "");
  const status      = String(body?.status || "");
  if (!affiliateId || !["active", "disabled"].includes(status)) {
    return json({ ok: false, error: "Invalid affiliateId or status" }, 400);
  }
  const raw = await env.STRATUS_DATA.get(`affiliate:${affiliateId}`);
  if (!raw) return json({ ok: false, error: "Affiliate not found" }, 404);
  const a = JSON.parse(raw);
  a.status = status;
  await env.STRATUS_DATA.put(`affiliate:${affiliateId}`, JSON.stringify(a));
  // Also flip the associated promo code's status so disabled affiliates can't accept new orders.
  if (a.code) {
    const pRaw = await env.STRATUS_DATA.get(`promo:${a.code}`);
    if (pRaw) {
      const p = JSON.parse(pRaw);
      p.status = status === "active" ? "active" : "disabled";
      await env.STRATUS_DATA.put(`promo:${a.code}`, JSON.stringify(p));
    }
  }
  return json({ ok: true, affiliateId, status });
}
