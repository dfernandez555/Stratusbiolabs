// Cloudflare Pages Function — dispatch a paid order to Rapid Fulfillment.
//
// POST /api/place-order
// Body: { orderId }                          -- customer-side, auto-dispatch on payment success
// Or:   { orderId, adminPassword }           -- admin retry from /admin dashboard
//
// Flow:
//   1. Look up the order in KV by orderId (must have been logged via /api/log-order)
//   2. If already dispatched, return ok (idempotent)
//   3. SOAP login() to Rapid -> sessionId
//   4. SOAP orders_new() with the order payload
//   5. SOAP logout()
//   6. Update KV record with rapidStatus=dispatched + rapidOrderId + timestamp
//
// Env vars required:
//   RAPID_API_USERNAME       (secret)
//   RAPID_API_PASSWORD       (secret)
//   RAPID_API_HOST           default: stratusbiolabs.test.rapidfulfillmentcrm.com
//                            production: stratusbiolabs.rapidfulfillmentcrm.com
//   RAPID_ORDER_PREFIX       int, default: 115. Confirmed with account manager.
//   RAPID_SHIPPING_METHOD    valid couriers_list code; default empty (Rapid picks default)
//   RAPID_SOURCE_TAG         default: "stratusbiolabs.com"
//   ADMIN_PASSWORD           gates admin retry calls
//
// Country mapping: convert the long names in checkout.html's <select> to 2-letter ISO.

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
function escapeXml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

const COUNTRY_MAP = {
  "united states": "US", "usa": "US", "us": "US",
  "canada": "CA", "ca": "CA",
  "united kingdom": "GB", "uk": "GB", "gb": "GB", "great britain": "GB",
  "australia": "AU", "au": "AU",
};
function toCountryCode(s) {
  const k = String(s || "").trim().toLowerCase();
  return COUNTRY_MAP[k] || (k.length === 2 ? k.toUpperCase() : "");
}

// ───────────────────────────────────────────────────────────────────
// SOAP helpers
// ───────────────────────────────────────────────────────────────────
function soapEnvelope(method, paramsXml) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope
  xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:xsd="http://www.w3.org/2001/XMLSchema"
  xmlns:ns1="urn:WFService"
  xmlns:SOAP-ENC="http://schemas.xmlsoap.org/soap/encoding/"
  SOAP-ENV:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <SOAP-ENV:Body>
    <ns1:${method}>${paramsXml}</ns1:${method}>
  </SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;
}

async function soapCall(env, method, paramsXml) {
  const host = env.RAPID_API_HOST || "stratusbiolabs.test.rapidfulfillmentcrm.com";
  const url = `https://${host}/api/soap/`;
  const body = soapEnvelope(method, paramsXml);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      "SOAPAction": `urn:WFService#${method}`,
    },
    body,
  });
  const text = await res.text();
  // Surface SOAP faults as errors
  const fault = text.match(/<faultstring[^>]*>([^<]+)<\/faultstring>/i);
  if (fault) throw new Error(`Rapid SOAP fault: ${fault[1]}`);
  if (!res.ok) throw new Error(`Rapid SOAP HTTP ${res.status}: ${text.slice(0, 200)}`);
  return text;
}

function parseReturnValue(xml) {
  // Match <return ...>VALUE</return> or <ns1:loginReturn>VALUE</ns1:loginReturn>
  const m = xml.match(/<(?:[a-z0-9:]+:)?(?:return|loginReturn|ordersNewReturn)[^>]*>([^<]+)<\/(?:[a-z0-9:]+:)?(?:return|loginReturn|ordersNewReturn)>/i);
  return m ? m[1] : null;
}

async function rapidLogin(env) {
  const params =
    `<username xsi:type="xsd:string">${escapeXml(env.RAPID_API_USERNAME)}</username>` +
    `<password xsi:type="xsd:string">${escapeXml(env.RAPID_API_PASSWORD)}</password>`;
  const xml = await soapCall(env, "login", params);
  const sessionId = parseReturnValue(xml);
  if (!sessionId) throw new Error(`Login: no sessionId in response: ${xml.slice(0, 300)}`);
  return sessionId;
}

async function rapidLogout(env, sessionId) {
  try {
    const params = `<sessionId xsi:type="xsd:string">${escapeXml(sessionId)}</sessionId>`;
    await soapCall(env, "logout", params);
  } catch { /* best-effort */ }
}

// ───────────────────────────────────────────────────────────────────
// Build the ordersNewData payload XML
// ───────────────────────────────────────────────────────────────────
function buildOrderXml(order, env) {
  const addr = order.shippingAddress || {};
  const countryCode = toCountryCode(addr.country);
  if (!countryCode) throw new Error(`Unsupported country: "${addr.country}". Must be US/CA/GB/AU.`);
  if (!addr.address || !addr.city || !addr.zip) {
    throw new Error("Missing required shipping fields (address/city/zip).");
  }

  // Rapid wants a numeric order_id. We extract digits from our "SB-XXXXXX" format.
  // Store the original ID in custom_data.orig_order_id for cross-reference.
  const numericId = parseInt(String(order.orderId).replace(/[^0-9]/g, "")) || (Date.now() % 1000000);
  const orderDate = (order.createdAt || new Date().toISOString())
    .replace("T", " ").replace(/\..+$/, "");  // YYYY-MM-DD HH:MM:SS

  // customer_id: max 20 chars. Use the customer's email-hash or just orderId prefix.
  const custId = (order.customerEmail || "anon").split("@")[0].slice(0, 20);

  const addressBlock = `
    <customer_id xsi:type="xsd:string">${escapeXml(custId)}</customer_id>
    <firstname xsi:type="xsd:string">${escapeXml(addr.firstName || "")}</firstname>
    <surname xsi:type="xsd:string">${escapeXml(addr.lastName || "")}</surname>
    <company xsi:type="xsd:string">${escapeXml(addr.institution || "")}</company>
    <address xsi:type="xsd:string">${escapeXml(addr.address || "")}</address>
    <address2 xsi:type="xsd:string">${escapeXml(addr.address2 || "")}</address2>
    <town xsi:type="xsd:string">${escapeXml(addr.city || "")}</town>
    <county xsi:type="xsd:string">${escapeXml(addr.state || "")}</county>
    <postcode xsi:type="xsd:string">${escapeXml(addr.zip || "")}</postcode>
    <country xsi:type="xsd:string">${countryCode}</country>
    <phone xsi:type="xsd:string">${escapeXml(addr.phone || "")}</phone>
    <email xsi:type="xsd:string">${escapeXml(order.customerEmail || "")}</email>`;

  // <products> array
  const productsXml = (order.items || []).map(it => `
        <item xsi:type="ns1:ordersProductsData">
          <product_id xsi:type="xsd:string">${escapeXml(it.sku || "")}</product_id>
          <name xsi:type="xsd:string">${escapeXml((it.name + (it.sizeKey ? ` ${it.sizeKey}` : "")).slice(0, 60))}</name>
          <qty xsi:type="xsd:int">${parseInt(it.qty) || 1}</qty>
          <unit_price xsi:type="xsd:string">${(Number(it.price) || 0).toFixed(2)}</unit_price>
        </item>`).join("");

  // custom_data: store our original order ID + any notes
  const customDataXml = `
        <item xsi:type="ns1:associativeEntity">
          <key xsi:type="xsd:string">order_source</key>
          <value xsi:type="xsd:string">${escapeXml(env.RAPID_SOURCE_TAG || "stratusbiolabs.com")}</value>
        </item>
        <item xsi:type="ns1:associativeEntity">
          <key xsi:type="xsd:string">orig_order_id</key>
          <value xsi:type="xsd:string">${escapeXml(order.orderId)}</value>
        </item>` +
    (addr.notes ? `
        <item xsi:type="ns1:associativeEntity">
          <key xsi:type="xsd:string">customer_notes</key>
          <value xsi:type="xsd:string">${escapeXml(addr.notes)}</value>
        </item>` : "");

  const prefix = parseInt(env.RAPID_ORDER_PREFIX) || 115;
  const shippingMethod = env.RAPID_SHIPPING_METHOD || ""; // empty = Rapid uses account default
  const message = "Thank you for your order — Stratus Biolabs. For Research Use Only.";

  return `
    <order_id_prefix xsi:type="xsd:int">${prefix}</order_id_prefix>
    <order_id xsi:type="xsd:int">${numericId}</order_id>
    <source xsi:type="xsd:string">${escapeXml(env.RAPID_SOURCE_TAG || "stratusbiolabs.com")}</source>
    <order_date xsi:type="xsd:string">${escapeXml(orderDate)}</order_date>
    <billing_address xsi:type="ns1:ordersAddressData">${addressBlock}</billing_address>
    <shipping_address xsi:type="ns1:ordersAddressData">${addressBlock}</shipping_address>
    <products SOAP-ENC:arrayType="ns1:ordersProductsData[]" xsi:type="ns1:ordersProductsDataArray">${productsXml}
      </products>
    <subtotal xsi:type="xsd:string">${(Number(order.subtotal) || 0).toFixed(2)}</subtotal>
    <shipping_cost xsi:type="xsd:string">${(Number(order.shipping) || 0).toFixed(2)}</shipping_cost>
    <discount xsi:type="xsd:string">${(Number(order.discount) || 0).toFixed(2)}</discount>
    <total_cost xsi:type="xsd:string">${(Number(order.total) || 0).toFixed(2)}</total_cost>
    <paidtodate xsi:type="xsd:string">${(Number(order.total) || 0).toFixed(2)}</paidtodate>
    <currency xsi:type="xsd:string">USD</currency>
    <message xsi:type="xsd:string">${escapeXml(message)}</message>
    <shipping_method xsi:type="xsd:string">${escapeXml(shippingMethod)}</shipping_method>
    <custom_data SOAP-ENC:arrayType="ns1:associativeEntity[]" xsi:type="ns1:associativeArray">${customDataXml}
      </custom_data>`;
}

async function rapidCreateOrder(env, sessionId, order) {
  const orderXml = buildOrderXml(order, env);
  const params =
    `<sessionId xsi:type="xsd:string">${escapeXml(sessionId)}</sessionId>` +
    `<ordersData xsi:type="ns1:ordersNewData">${orderXml}</ordersData>`;
  return soapCall(env, "orders_new", params);
}

// ───────────────────────────────────────────────────────────────────
// Main handler
// ───────────────────────────────────────────────────────────────────
export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
  if (!env.STRATUS_DATA) return json({ ok: false, error: "Storage not configured" }, 503);

  const orderId = String(body?.orderId || "").trim();
  if (!orderId) return json({ ok: false, error: "Missing orderId" }, 400);

  // Admin retry path: requires password
  const isAdmin = body?.adminPassword && body.adminPassword === env.ADMIN_PASSWORD;

  // Look up the order
  const raw = await env.STRATUS_DATA.get(`order:${orderId}`);
  if (!raw) return json({ ok: false, error: "Order not found" }, 404);
  const order = JSON.parse(raw);

  // Idempotency: if already dispatched, return ok
  if (order.rapidStatus === "dispatched" && !isAdmin) {
    return json({ ok: true, status: "already_dispatched", rapidOrderId: order.rapidOrderId || null });
  }

  // Require Rapid credentials
  if (!env.RAPID_API_USERNAME || !env.RAPID_API_PASSWORD) {
    // Don't fail loudly to customers — silently queue. Admin can retry once creds are set.
    order.rapidStatus = "pending";
    order.rapidError = "Rapid API credentials not yet configured on server.";
    await env.STRATUS_DATA.put(`order:${orderId}`, JSON.stringify(order));
    return json({ ok: false, error: "Fulfillment integration not yet configured.", retryable: true }, 503);
  }

  let sessionId = null;
  try {
    sessionId = await rapidLogin(env);
    const responseXml = await rapidCreateOrder(env, sessionId, order);
    // SOAP response: <return xsi:type="xsd:boolean">true</return>
    const success = /<(?:[a-z0-9:]+:)?return[^>]*>(true|1)<\/(?:[a-z0-9:]+:)?return>/i.test(responseXml);
    if (!success) {
      // Some Rapid responses include error info inline. Pass them through.
      const errMatch = responseXml.match(/<faultstring[^>]*>([^<]+)<\/faultstring>/i)
                   || responseXml.match(/<message[^>]*>([^<]+)<\/message>/i);
      throw new Error(errMatch ? errMatch[1] : "orders_new returned non-true; raw: " + responseXml.slice(0, 300));
    }

    order.rapidStatus = "dispatched";
    order.rapidDispatchedAt = new Date().toISOString();
    order.rapidError = null;
    order.rapidOrderId = String(parseInt(String(orderId).replace(/[^0-9]/g, "")) || "");
    await env.STRATUS_DATA.put(`order:${orderId}`, JSON.stringify(order));
    return json({ ok: true, status: "dispatched", rapidOrderId: order.rapidOrderId });

  } catch (err) {
    order.rapidStatus = "failed";
    order.rapidError = String(err.message || err).slice(0, 500);
    await env.STRATUS_DATA.put(`order:${orderId}`, JSON.stringify(order));
    return json({ ok: false, error: order.rapidError, retryable: true }, 502);
  } finally {
    if (sessionId) await rapidLogout(env, sessionId);
  }
}
