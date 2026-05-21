// Cloudflare Pages Function — server-side cart validation.
//
// Endpoint:  POST /api/validate-cart
// Request:   { items: [{sku, sizeKey, qty}], promoCode?: string }
// Response:  { ok, lineItems, subtotal, shipping, discount, total, promoApplied }
//        or  { ok: false, error }
//
// Promo lookup: tries Cloudflare KV first (for affiliate codes added via signup),
// then falls back to the global hardcoded promo table.

// ── Single source of truth for what we sell + at what price ─────────────────
// Must match catalog.html. When adding/changing SKUs, update both places.
// Per the Chaos & Control Master Agreement (Exhibit A, signed 2026-05-20),
// only the 10 approved SKUs below may be sold. Listing format mandated by
// the agreement: SBL-<sku> -- <product name> -- <mg strength>.
// Each entry's single size key matches the product's only sold size.
const SKU_TABLE = {
  "SBL-RT10":  { name: "G3-R",                 sizes: { "10mg":  100 } },
  "SBL-TSM10": { name: "Tesamorelin",          sizes: { "10mg":  110 } },
  "SBL-IG1":   { name: "IGF1-LR3",             sizes: { "1mg":    70 } },
  "SBL-NJ500": { name: "NAD+",                 sizes: { "500mg":  75 } },
  "SBL-CU50":  { name: "GHK-CU",               sizes: { "50mg":   65 } },
  "SBL-BBG70": { name: "GLOW",                 sizes: { "70mg":  120 } },
  "SBL-KBT80": { name: "KLOW",                 sizes: { "80mg":  140 } },
  "SBL-XA30":  { name: "Semax",                sizes: { "30mg":   85 } },
  "SBL-WA3":   { name: "Bacteriostatic Water", sizes: { "3mL":     8 } },
  "SBL-WA10":  { name: "Bacteriostatic Water", sizes: { "10mL":   15 } },
};

// ── Global / non-affiliate promos (never exposed to the browser) ────────────
const GLOBAL_PROMOS = {
  "INTERNETMONEYBITCH": { type: "percent", value: 20, label: "20% OFF" },
};

const FREE_SHIPPING_THRESHOLD = 150;
const SHIPPING_COST = 9.99;
const MAX_QTY_PER_ITEM = 99;
const MAX_LINE_ITEMS = 50;

function round2(n) { return Math.round(n * 100) / 100; }
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

async function lookupPromo(code, env) {
  // 1) KV-backed affiliate codes (preferred — new codes need no redeploy)
  if (env && env.STRATUS_DATA) {
    const raw = await env.STRATUS_DATA.get(`promo:${code}`);
    if (raw) {
      try {
        const p = JSON.parse(raw);
        if (p && p.status !== "disabled") return p;
      } catch { /* ignore parse errors, fall through */ }
    }
  }
  // 2) Global hardcoded promos
  return GLOBAL_PROMOS[code] || null;
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "Invalid JSON" }, 400); }

  const items = Array.isArray(body?.items) ? body.items : null;
  if (!items || items.length === 0) return json({ ok: false, error: "Cart is empty" }, 400);
  if (items.length > MAX_LINE_ITEMS)  return json({ ok: false, error: "Too many line items" }, 400);

  const lineItems = [];
  let subtotal = 0;

  for (const raw of items) {
    const sku = String(raw?.sku || "");
    const sizeKey = String(raw?.sizeKey || "");
    const qty = Math.max(1, Math.min(MAX_QTY_PER_ITEM, parseInt(raw?.qty) || 1));

    const product = SKU_TABLE[sku];
    if (!product) return json({ ok: false, error: `Unknown product: ${sku}` }, 400);
    const unitPrice = product.sizes[sizeKey];
    if (unitPrice == null) return json({ ok: false, error: `Unknown size '${sizeKey}' for ${sku}` }, 400);
    const lineTotal = round2(unitPrice * qty);
    subtotal += lineTotal;
    lineItems.push({ sku, sizeKey, name: product.name, qty, unitPrice, lineTotal });
  }
  subtotal = round2(subtotal);

  const shipping = subtotal >= FREE_SHIPPING_THRESHOLD ? 0 : SHIPPING_COST;

  let discount = 0;
  let promoApplied = null;
  const rawPromo = body?.promoCode;
  if (rawPromo) {
    const code = String(rawPromo).toUpperCase().replace(/[^A-Z0-9]/g, "");
    const promo = await lookupPromo(code, env);
    if (!promo) return json({ ok: false, error: "Invalid promo code" }, 400);

    if (promo.type === "percent") {
      discount = round2(((subtotal + shipping) * promo.value) / 100);
    } else if (promo.type === "shipping") {
      discount = shipping;
    }
    promoApplied = {
      code, label: promo.label, discountPct: promo.value,
      affiliateId: promo.affiliateId || null,
    };
  }

  const total = round2(Math.max(0, subtotal + shipping - discount));

  return json({ ok: true, lineItems, subtotal, shipping, discount, total, promoApplied });
}
