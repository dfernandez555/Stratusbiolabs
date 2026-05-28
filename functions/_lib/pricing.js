// Shared pricing + cart-computation logic.
//
// Single source of truth used by both /api/validate-cart (browser-driven
// preview) and /api/log-order (authoritative server-side recompute at order
// placement time). Having them share the same code closes BUG-019 — the bug
// where a tampered browser could submit a $0 order for $1000 of products
// because log-order trusted the browser-supplied totals.
//
// Per the Chaos & Control Master Agreement (Exhibit A, signed 2026-05-20),
// only the 10 approved SKUs may be sold. Listing format mandated by the
// agreement: SBL-<sku> -- <product name> -- <mg strength>.

// `sizes`           — retail price (what customers normally pay)
// `wholesaleSizes`  — C&C wholesale cost per unit (Exhibit A, 0-499 volume tier).
//                     Used by the `at_cost` promo type (family/staff pricing)
//                     and by the masteradmin accounting view to compute margin.
//                     Update both when contract terms change.
export const SKU_TABLE = {
  "SBL-RT10":  { name: "G3-R",                 sizes: { "10mg":  100 }, wholesaleSizes: { "10mg":  30 } },
  "SBL-TSM10": { name: "Tesamorelin",          sizes: { "10mg":  110 }, wholesaleSizes: { "10mg":  29 } },
  "SBL-IG1":   { name: "IGF1-LR3",             sizes: { "1mg":    70 }, wholesaleSizes: { "1mg":   30 } },
  "SBL-NJ500": { name: "NAD+",                 sizes: { "500mg":  75 }, wholesaleSizes: { "500mg": 26 } },
  "SBL-CU50":  { name: "GHK-CU",               sizes: { "50mg":   65 }, wholesaleSizes: { "50mg":  11 } },
  "SBL-BBG70": { name: "GLOW",                 sizes: { "70mg":  120 }, wholesaleSizes: { "70mg":  35 } },
  "SBL-KBT80": { name: "KLOW",                 sizes: { "80mg":  140 }, wholesaleSizes: { "80mg":  42 } },
  "SBL-XA30":  { name: "Semax",                sizes: { "30mg":   85 }, wholesaleSizes: { "30mg":  26 } },
  "SBL-WA3":   { name: "Bacteriostatic Water", sizes: { "3mL":     8 }, wholesaleSizes: { "3mL":    5 } },
  "SBL-WA10":  { name: "Bacteriostatic Water", sizes: { "10mL":   15 }, wholesaleSizes: { "10mL":  10 } },
};

// Promos now live in KV under `promo:<CODE>`. Kept as an empty fallback bucket
// so a code can survive KV being unreachable if absolutely needed.
const GLOBAL_PROMOS = {};

export const FREE_SHIPPING_THRESHOLD = 150;
export const SHIPPING_COST = 9.99;
export const MAX_QTY_PER_ITEM = 99;
export const MAX_LINE_ITEMS = 50;
// Floor for set_total promo codes — admin can never accidentally configure
// a promo that brings the total to $0. Closes BUG-004.
const MIN_SET_TOTAL = 0.01;

function round2(n) { return Math.round(n * 100) / 100; }

export async function lookupPromo(code, env) {
  if (env && env.STRATUS_DATA) {
    const raw = await env.STRATUS_DATA.get(`promo:${code}`);
    if (raw) {
      try {
        const p = JSON.parse(raw);
        if (p && p.status !== "disabled") return p;
      } catch { /* ignore parse errors, fall through */ }
    }
  }
  return GLOBAL_PROMOS[code] || null;
}

/**
 * Authoritatively compute cart totals from raw item/promoCode input.
 * Returns { ok: true, lineItems, subtotal, shipping, discount, total,
 *           promoApplied, promoRaw } on success or { ok: false, error } on
 * failure. Callers should ALWAYS use the returned totals — never trust
 * browser-supplied numbers for anything money-related.
 */
export async function computeCart({ items, promoCode }, env) {
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, error: "Cart is empty" };
  }
  if (items.length > MAX_LINE_ITEMS) {
    return { ok: false, error: "Too many line items" };
  }

  const lineItems = [];
  let subtotal = 0;

  for (const raw of items) {
    const sku = String(raw?.sku || "");
    const sizeKey = String(raw?.sizeKey || "");
    const qty = Math.max(1, Math.min(MAX_QTY_PER_ITEM, parseInt(raw?.qty) || 1));

    const product = SKU_TABLE[sku];
    if (!product) return { ok: false, error: `Unknown product: ${sku}` };
    const unitPrice = product.sizes[sizeKey];
    if (unitPrice == null) return { ok: false, error: `Unknown size '${sizeKey}' for ${sku}` };
    const lineTotal = round2(unitPrice * qty);
    subtotal += lineTotal;
    lineItems.push({ sku, sizeKey, name: product.name, qty, unitPrice, lineTotal });
  }
  subtotal = round2(subtotal);

  const shipping = subtotal >= FREE_SHIPPING_THRESHOLD ? 0 : SHIPPING_COST;

  let discount = 0;
  let promoApplied = null;
  let promoRaw = null;

  const rawPromo = promoCode;
  if (rawPromo) {
    const code = String(rawPromo).toUpperCase().replace(/[^A-Z0-9]/g, "");
    const promo = await lookupPromo(code, env);
    if (!promo) return { ok: false, error: "Invalid promo code" };
    promoRaw = promo;

    if (promo.type === "percent") {
      const pct = Number(promo.value) || 0;
      // Bound pct so a misconfigured promo (e.g. value:1000) can't blow up the discount.
      const safePct = Math.max(0, Math.min(100, pct));
      discount = round2(((subtotal + shipping) * safePct) / 100);
    } else if (promo.type === "shipping") {
      discount = shipping;
    } else if (promo.type === "set_total") {
      // Reduce the cart total to a specific dollar amount (used for admin
      // test codes — e.g. TESTDRIVE pushes a real order through at $1 so the
      // full payment + dispatch chain can be exercised end-to-end). Clamped
      // to non-negative AND to a minimum floor (BUG-004 — prevents an
      // accidental targetTotal:0 from making any cart free).
      const target = Math.max(MIN_SET_TOTAL, Number(promo.targetTotal) || 0);
      discount = round2(Math.max(0, (subtotal + shipping) - target));
    } else if (promo.type === "at_cost") {
      // Family/staff pricing — items priced at C&C wholesale instead of
      // retail. Shipping rules are UNCHANGED: free shipping kicks in if the
      // RETAIL subtotal would have qualified (so the holder still benefits
      // from the $150 free-shipping threshold rather than getting punished
      // for paying less per item). Final total = wholesale subtotal + shipping.
      let wholesaleSubtotal = 0;
      let anyMissingCost = false;
      for (const li of lineItems) {
        const sku = SKU_TABLE[li.sku];
        const w = sku && sku.wholesaleSizes && sku.wholesaleSizes[li.sizeKey];
        if (typeof w !== "number") {
          anyMissingCost = true;
          // Defensive: if we can't price this item at cost, charge retail for
          // it (no discount on the unknown-cost item). Safer than free.
          wholesaleSubtotal += round2(li.unitPrice * li.qty);
          continue;
        }
        wholesaleSubtotal += round2(w * li.qty);
      }
      wholesaleSubtotal = round2(wholesaleSubtotal);
      // discount = how much we reduce the retail subtotal to get to the
      // wholesale subtotal. Shipping passes through unchanged.
      discount = round2(Math.max(0, subtotal - wholesaleSubtotal));
      // If any SKU is missing wholesale data, the function above falls back
      // to retail for that line (no free items). Surface via console for
      // admin visibility — should never happen if SKU_TABLE is in sync.
      if (anyMissingCost) {
        console.warn("at_cost promo applied but one or more SKUs lack wholesale cost", { items: lineItems.map(li => li.sku) });
      }
    }
    // Defensive: discount can never be negative (BUG-008).
    if (discount < 0) discount = 0;
    // Defensive: discount can never exceed (subtotal + shipping).
    if (discount > subtotal + shipping) discount = subtotal + shipping;

    promoApplied = {
      code,
      label: promo.label,
      discountPct: promo.value,
      affiliateId: promo.affiliateId || null,
    };
  }

  const total = round2(Math.max(0, subtotal + shipping - discount));

  return {
    ok: true,
    lineItems, subtotal, shipping, discount, total,
    promoApplied,
    promoRaw,  // Full promo record (for log-order to capture affiliateCommission etc.)
  };
}
