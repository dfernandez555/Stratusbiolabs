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

import { SKU_TABLE, SHIPPING_COST } from "../../_lib/pricing.js";

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

// Parse either:
//   - "2026-05-28"                  (calendar date — treated as UTC start/end)
//   - "2026-05-28T07:00:00.000Z"    (full ISO — used when the admin UI sends
//                                    local-day boundaries already converted
//                                    to UTC, so the filter respects the
//                                    admin's local timezone — Martin's
//                                    7:19 PM PT order didn't show up under
//                                    a "to=2026-06-03" UTC-end-of-day filter)
// Returns Date or null for invalid input.
function parseDateStartUTC(s) {
  s = String(s || "");
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(s + "T00:00:00.000Z");
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}
function parseDateEndUTC(s) {
  s = String(s || "");
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(s + "T23:59:59.999Z");
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
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

  // P&L counters. We compute COGS (cost of goods sold) at the SKU+size level
  // using wholesaleSizes from pricing.js, which is our authoritative cost
  // source. Shipping income (what customers paid us for shipping) is tracked
  // separately so we can later subtract the actual carrier cost when we
  // start logging it.
  let totalShippingIncome = 0;
  let totalDiscount = 0;
  let totalCommissionsOwed = 0;
  let totalCogs = 0;
  let unitsSold = 0;

  // Per-SKU aggregation: SKU -> { sku, name, units, revenue, cogs, grossProfit, marginPct }
  const bySku = {};

  for (const o of liveOrders) {
    totalRevenue += o.total || 0;
    totalShippingIncome += Number(o.shipping) || 0;
    totalDiscount += Number(o.discount) || 0;
    totalCommissionsOwed += Number(o.commissionOwed) || 0;

    if (o.affiliateId) {
      const key = o.affiliateId;
      if (!byAffiliate[key]) byAffiliate[key] = { affiliateId: key, code: o.promoCode, revenue: 0, orders: 0, commissionOwed: 0 };
      byAffiliate[key].revenue += o.subtotal || 0;
      byAffiliate[key].orders += 1;
      byAffiliate[key].commissionOwed += o.commissionOwed || 0;
    }

    // Walk line items for per-SKU revenue + COGS.
    const items = Array.isArray(o.items) ? o.items : [];
    for (const it of items) {
      const sku  = String(it.sku || "");
      const size = String(it.sizeKey || "");
      const qty  = Math.max(0, parseInt(it.qty) || 0);
      const unitPrice = Number(it.price) || 0;
      if (!sku || qty === 0) continue;

      const skuMeta = SKU_TABLE[sku] || {};
      const skuName = skuMeta.name || sku;
      const wholesale = skuMeta.wholesaleSizes && skuMeta.wholesaleSizes[size];
      const unitCost = typeof wholesale === "number" ? wholesale : 0;

      const lineRevenue = unitPrice * qty;
      const lineCogs    = unitCost  * qty;

      if (!bySku[sku]) {
        bySku[sku] = {
          sku,
          name: skuName,
          units: 0,
          revenue: 0,
          cogs: 0,
          grossProfit: 0,
          marginPct: 0,
          missingCost: false,
        };
      }
      bySku[sku].units   += qty;
      bySku[sku].revenue += lineRevenue;
      bySku[sku].cogs    += lineCogs;
      if (typeof wholesale !== "number") bySku[sku].missingCost = true;

      totalCogs  += lineCogs;
      unitsSold  += qty;
    }
  }

  // Finalize per-SKU computed columns.
  for (const k of Object.keys(bySku)) {
    const row = bySku[k];
    row.grossProfit = row.revenue - row.cogs;
    row.marginPct = row.revenue > 0 ? (row.grossProfit / row.revenue) * 100 : 0;
    row.revenue     = Math.round(row.revenue * 100) / 100;
    row.cogs        = Math.round(row.cogs * 100) / 100;
    row.grossProfit = Math.round(row.grossProfit * 100) / 100;
    row.marginPct   = Math.round(row.marginPct * 10) / 10;
  }
  const salesBySku = Object.values(bySku).sort((a, b) => b.revenue - a.revenue);

  // P&L summary. "Net" is gross profit minus accrued affiliate commissions —
  // it does NOT include operating expenses (software, rent, salaries) since
  // those live in Wave/QuickBooks, not in our KV.
  const grossProfit = totalRevenue - totalCogs;
  const grossMarginPct = totalRevenue > 0 ? (grossProfit / totalRevenue) * 100 : 0;
  const netBeforeOpex = grossProfit - totalCommissionsOwed;

  const profitSummary = {
    revenue:           Math.round(totalRevenue * 100) / 100,
    cogs:              Math.round(totalCogs * 100) / 100,
    grossProfit:       Math.round(grossProfit * 100) / 100,
    grossMarginPct:    Math.round(grossMarginPct * 10) / 10,
    shippingIncome:    Math.round(totalShippingIncome * 100) / 100,
    discount:          Math.round(totalDiscount * 100) / 100,
    affiliateCommissions: Math.round(totalCommissionsOwed * 100) / 100,
    netBeforeOpex:     Math.round(netBeforeOpex * 100) / 100,
    unitsSold,
  };

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
    profitSummary,
    salesBySku,
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
