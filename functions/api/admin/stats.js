// Cloudflare Pages Function — admin stats dashboard backend.
//
// GET /api/admin/stats
//   ?from=YYYY-MM-DD   (inclusive, defaults to 30 days ago)
//   ?to=YYYY-MM-DD     (inclusive, defaults to today)
//   ?month=YYYY-MM     (back-compat — covers the whole month)
// Header: X-Admin-Password: <password>
//
// Returns aggregated revenue, affiliate breakdown, and recent orders for the
// selected date range. Internally we fetch by month-index (the same KV layout
// the previous /admin used) and then filter by exact createdAt date so a
// rolling range that spans month boundaries still works.
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
  // Header-only auth. We deliberately do NOT accept ?password=... in the query
  // string because it would leak into browser history, server access logs,
  // and the Referer header on any outbound link from an admin session.
  const hdr = request.headers.get("X-Admin-Password") || "";
  return hdr === env.ADMIN_PASSWORD;
}

// "2026-05-28" -> Date at start-of-day UTC. Returns null for invalid input.
function parseDateStartUTC(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || "")) return null;
  const d = new Date(s + "T00:00:00.000Z");
  return isNaN(d.getTime()) ? null : d;
}
function parseDateEndUTC(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || "")) return null;
  // End-of-day inclusive: 23:59:59.999.
  const d = new Date(s + "T23:59:59.999Z");
  return isNaN(d.getTime()) ? null : d;
}

// Enumerate all "YYYY-MM" buckets between fromDate and toDate (inclusive),
// so we can list each one's KV index. Cap at 24 months to keep a single
// stats call bounded.
function monthsBetween(fromDate, toDate) {
  const months = [];
  const cur = new Date(Date.UTC(fromDate.getUTCFullYear(), fromDate.getUTCMonth(), 1));
  const end = new Date(Date.UTC(toDate.getUTCFullYear(), toDate.getUTCMonth(), 1));
  let guard = 0;
  while (cur.getTime() <= end.getTime() && guard < 24) {
    months.push(cur.toISOString().slice(0, 7));
    cur.setUTCMonth(cur.getUTCMonth() + 1);
    guard++;
  }
  return months;
}

export async function onRequestGet({ request, env }) {
  if (!isAuthed(request, env)) return unauth();
  if (!env.STRATUS_DATA) return json({ ok: false, error: "Storage not configured" }, 503);

  const url = new URL(request.url);
  const monthParam = url.searchParams.get("month");
  let fromStr = url.searchParams.get("from");
  let toStr = url.searchParams.get("to");

  // Back-compat: ?month=YYYY-MM covers the full month.
  if (!fromStr && !toStr && monthParam && /^\d{4}-\d{2}$/.test(monthParam)) {
    fromStr = monthParam + "-01";
    // Last day of month — let Date math sort it out
    const [yy, mm] = monthParam.split("-").map(Number);
    const lastDay = new Date(Date.UTC(yy, mm, 0)).getUTCDate(); // mm=1-indexed input, day 0 = last day of prev month
    toStr = `${monthParam}-${String(lastDay).padStart(2, "0")}`;
  }

  // Default range: last 30 days through today (rolling).
  if (!fromStr || !toStr) {
    const now = new Date();
    const from = new Date(now);
    from.setUTCDate(from.getUTCDate() - 29); // inclusive of today = 30 days
    if (!fromStr) fromStr = from.toISOString().slice(0, 10);
    if (!toStr)   toStr   = now.toISOString().slice(0, 10);
  }

  const fromDate = parseDateStartUTC(fromStr);
  const toDate   = parseDateEndUTC(toStr);
  if (!fromDate || !toDate || fromDate > toDate) {
    return json({ ok: false, error: "Invalid date range. Use ?from=YYYY-MM-DD&to=YYYY-MM-DD." }, 400);
  }

  // Walk every month bucket the range touches.
  const months = monthsBetween(fromDate, toDate);

  // List + dedupe order IDs across all touched months.
  const seenIds = new Set();
  for (const m of months) {
    const idx = await env.STRATUS_DATA.list({ prefix: `order-month:${m}:`, limit: 1000 });
    for (const k of idx.keys) {
      const id = k.name.split(":").pop();
      if (id) seenIds.add(id);
    }
  }
  const orderIds = Array.from(seenIds);

  // Fetch order records in parallel.
  const orderRecs = await Promise.all(
    orderIds.map(id => env.STRATUS_DATA.get(`order:${id}`).then(s => s ? JSON.parse(s) : null))
  );

  // Filter to exact date range (KV month-index is coarse; we narrow to the day).
  const fromMs = fromDate.getTime();
  const toMs   = toDate.getTime();
  const orders = orderRecs
    .filter(Boolean)
    .filter(o => {
      const t = Date.parse(o.createdAt || "");
      return !isNaN(t) && t >= fromMs && t <= toMs;
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  // Aggregate. Cancelled orders are listed in recentOrders so admin can see
  // them, but they don't count toward revenue, order count, or affiliate
  // commission payouts.
  const liveOrders = orders.filter(o => o.status !== "cancelled" && o.paymentStatus !== "cancelled");
  let totalRevenue = 0, orderCount = liveOrders.length;
  const byAffiliate = {}; // affiliateId -> { affiliateId, code, revenue, orders, commissionOwed }

  for (const o of liveOrders) {
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
    from: fromStr,
    to: toStr,
    // Keep "month" populated so existing UI code that reads it doesn't break.
    month: fromStr.slice(0, 7) === toStr.slice(0, 7) ? fromStr.slice(0, 7) : `${fromStr} → ${toStr}`,
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
      status: o.status || "active",  // 'active' | 'cancelled'
      paymentStatus: o.paymentStatus || (o.paymentMethod === "invoice" ? "awaiting_payment" : "paid"),
      paymentReceivedAt: o.paymentReceivedAt || null,
      paymentChannel: o.paymentChannel || null,    // 'Cash App' | 'Zelle' | 'Other'
      paymentReference: o.paymentReference || null,
      rapidStatus: o.rapidStatus || "pending",
      rapidError: o.rapidError || null,
      rapidDispatchedAt: o.rapidDispatchedAt || null,
      cancelledAt: o.cancelledAt || null,
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
