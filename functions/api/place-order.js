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

// Per-fetch hard timeout. Rapid's SOAP server occasionally stalls; without a
// bound here a single hung request can eat the entire Workers budget and the
// admin sees a generic 500 with no useful diagnostic.
const SOAP_FETCH_TIMEOUT_MS = 12_000;

// Errors that match these patterns are network-transient and worth retrying.
// Anything not matching here (validation faults, "duplicate orderId", auth) is
// permanent and we should fail fast so admin sees the real reason.
const TRANSIENT_ERROR_RE = /(timeout|timed out|temporarily|temporary|try again|gateway|unavailable|reset|aborted|network|fetch failed|econnreset|service unavailable|internal server error|session expired|invalid session|too many)/i;

function isTransientError(err) {
  if (!err) return false;
  const name = (err.name || "").toLowerCase();
  if (name === "aborterror" || name === "timeouterror") return true;
  return TRANSIENT_ERROR_RE.test(String(err.message || err));
}

async function soapCall(env, method, paramsXml) {
  const host = env.RAPID_API_HOST || "stratusbiolabs.rapidfulfillmentcrm.com";
  // Endpoint is /api/soap/?action (the WSDL declares this as the service location).
  // SOAPAction is the same handler tag for every method.
  const url = `https://${host}/api/soap/?action`;
  const body = soapEnvelope(method, paramsXml);
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), SOAP_FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        "SOAPAction": "urn:WF_Api_Soap_HandlerAction",
      },
      body,
      signal: ctrl.signal,
    });
  } catch (err) {
    if (err && err.name === "AbortError") {
      throw new Error(`Rapid SOAP timeout after ${SOAP_FETCH_TIMEOUT_MS}ms on ${method}`);
    }
    throw new Error(`Rapid SOAP network error on ${method}: ${err.message || err}`);
  } finally {
    clearTimeout(tid);
  }
  const text = await res.text();
  // Surface SOAP faults as errors
  const fault = text.match(/<faultstring[^>]*>([^<]+)<\/faultstring>/i);
  if (fault) throw new Error(`Rapid SOAP fault (${method}): ${fault[1]}`);
  if (!res.ok) throw new Error(`Rapid SOAP HTTP ${res.status} on ${method}: ${text.slice(0, 200)}`);
  return text;
}

// Extract the named child element value out of a SOAP response body. Rapid's
// actual responses wrap returns in named tags like <sessionId>, <orderId>,
// etc. — not the generic <return> we initially assumed. Use this helper with
// the expected child name per method.
function parseElementValue(xml, tagName) {
  const re = new RegExp(`<(?:[a-z0-9_-]+:)?${tagName}[^>]*>([^<]*)<\\/(?:[a-z0-9_-]+:)?${tagName}>`, "i");
  const m = xml.match(re);
  return m ? m[1] : null;
}

async function rapidLogin(env) {
  const params =
    `<username xsi:type="xsd:string">${escapeXml(env.RAPID_API_USERNAME)}</username>` +
    `<password xsi:type="xsd:string">${escapeXml(env.RAPID_API_PASSWORD)}</password>`;
  const xml = await soapCall(env, "login", params);
  // Login response shape (confirmed against Rapid prod 2026-05-27):
  //   <ns1:loginResponse><sessionId xsi:type="xsd:string">SESSION_TOKEN</sessionId>
  const sessionId = parseElementValue(xml, "sessionId");
  if (!sessionId) throw new Error(`Login: no sessionId in response. Raw: ${xml.slice(0, 1500)}`);
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

  // <products> array. Name field follows the Chaos & Control listing format
  // mandated by the Master Agreement Exhibit A:  SBL-<SKU> -- <Product> -- <MG>
  // (Their dash is " – " but a hyphen-space-hyphen works too; using "–" en-dash.)
  const formatSize = (s) => String(s || "").replace(/mg$/i, " MG").replace(/ml$/i, " ML").trim();
  const productsXml = (order.items || []).map(it => {
    const fmtName = `${it.sku || ""} – ${it.name || ""} – ${formatSize(it.sizeKey)}`.slice(0, 60);
    return `
        <item xsi:type="ns1:ordersProductsData">
          <product_id xsi:type="xsd:string">${escapeXml(it.sku || "")}</product_id>
          <name xsi:type="xsd:string">${escapeXml(fmtName)}</name>
          <qty xsi:type="xsd:int">${parseInt(it.qty) || 1}</qty>
          <unit_price xsi:type="xsd:string">${(Number(it.price) || 0).toFixed(2)}</unit_price>
        </item>`;
  }).join("");

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

  // Idempotency: if already dispatched, return ok.
  if (order.rapidStatus === "dispatched" && !isAdmin) {
    return json({ ok: true, status: "already_dispatched", rapidOrderId: order.rapidOrderId || null });
  }

  // BUG-003 mitigation — claim a "dispatching" lock by writing the status to
  // KV BEFORE making the SOAP call. A concurrent webhook + admin-retry race
  // will see this on its KV read and bail out instead of issuing a second
  // SOAP create_order. The 10-minute staleness window protects against a
  // crashed dispatch that never resolved (it's OK to retry after that).
  const DISPATCH_LOCK_TTL_MS = 10 * 60 * 1000;
  if (order.rapidStatus === "dispatching" && order.rapidDispatchingAt) {
    const ageMs = Date.now() - Date.parse(order.rapidDispatchingAt);
    if (ageMs < DISPATCH_LOCK_TTL_MS) {
      return json({
        ok: true,
        status: "dispatch_in_progress",
        message: "Another dispatch is already in flight for this order.",
      });
    }
    // Else fall through — lock is stale, take it over.
  }

  // Payment gate: invoice orders cannot dispatch until admin marks them paid.
  // /api/admin/mark-paid flips paymentStatus -> 'paid' and then calls this endpoint.
  if (order.paymentStatus && order.paymentStatus !== "paid") {
    return json({
      ok: false,
      error: `Order is ${order.paymentStatus}. Dispatch blocked until payment is confirmed.`,
      retryable: false,
    }, 409);
  }

  // Require Rapid credentials
  if (!env.RAPID_API_USERNAME || !env.RAPID_API_PASSWORD) {
    // Don't fail loudly to customers — silently queue. Admin can retry once creds are set.
    order.rapidStatus = "pending";
    order.rapidError = "Rapid API credentials not yet configured on server.";
    await env.STRATUS_DATA.put(`order:${orderId}`, JSON.stringify(order));
    return json({ ok: false, error: "Fulfillment integration not yet configured.", retryable: true }, 503);
  }

  // Take the dispatch lock.
  order.rapidStatus = "dispatching";
  order.rapidDispatchingAt = new Date().toISOString();
  await env.STRATUS_DATA.put(`order:${orderId}`, JSON.stringify(order));

  // Auto-retry the full login → orders_new sequence once on transient errors.
  // Rapid's SOAP service blips often enough that a single shot fails ~5-10%
  // of the time; admin used to click Retry manually. We do that automatically
  // now while keeping the safety properties:
  //
  //   • Idempotency on orders_new — Rapid uses our orderId as their order_id,
  //     so a retry that lands a duplicate will be rejected by their server.
  //     We pattern-match the "duplicate" / "already exists" fault and treat
  //     it as success (the first attempt actually got through, the response
  //     just didn't reach us).
  //   • Permanent errors (invalid country, missing field, auth) fail fast
  //     without retry so admin sees the real diagnostic.
  //   • Budget — each attempt is bounded by SOAP_FETCH_TIMEOUT_MS (12s);
  //     two attempts + backoff stays well under the 30s Workers limit.
  const MAX_ATTEMPTS = 2;
  const RETRY_BACKOFF_MS = 600;
  let attempt = 0;
  let lastErr = null;
  let sessionId = null;
  let responseXml = null;
  let dispatchedViaDuplicate = false;

  while (attempt < MAX_ATTEMPTS) {
    attempt++;
    sessionId = null;
    try {
      sessionId = await rapidLogin(env);
      responseXml = await rapidCreateOrder(env, sessionId, order);
      // Success path — break out, validate below.
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      const msg = String(err.message || err);
      // Already created on a prior attempt — Rapid rejected the duplicate.
      // Treat as success because their server has the order on file.
      if (/duplicate|already exists|already been created|order_id.*exists/i.test(msg)) {
        dispatchedViaDuplicate = true;
        lastErr = null;
        break;
      }
      // Only retry on transient errors; permanent errors bail immediately.
      // (Logout happens in the finally block below before the continue runs.)
      if (attempt < MAX_ATTEMPTS && isTransientError(err)) {
        // Jittered backoff between attempts — keeps us from hammering a
        // stressed Rapid server lockstep with itself.
        const jitter = Math.floor((Math.random() - 0.5) * 200);
        await new Promise(r => setTimeout(r, RETRY_BACKOFF_MS + jitter));
        continue;
      }
      break;
    } finally {
      // Always end the session, even on retry — Rapid pools are finite and
      // a hung session can lock us out on subsequent dispatches.
      if (sessionId) { try { await rapidLogout(env, sessionId); } catch {} }
      sessionId = null;
    }
  }

  if (lastErr) {
    order.rapidStatus = "failed";
    order.rapidError = String(lastErr.message || lastErr).slice(0, 500);
    order.rapidRetryCount = attempt - 1;
    order.rapidLastFailedAt = new Date().toISOString();
    await env.STRATUS_DATA.put(`order:${orderId}`, JSON.stringify(order));
    return json({ ok: false, error: order.rapidError, retryable: true, attempts: attempt }, 502);
  }

  // SOAP response shape (confirmed against Rapid prod 2026-05-27):
  //   <ns1:orders_newResponse>
  //     <result xsi:type="xsd:boolean">true</result>
  //   </ns1:orders_newResponse>
  // Rapid uses the order_id we sent (echoed back in result=true), so we
  // don't get a Rapid-internal id in the response — we derive it from the
  // numeric portion of our orderId below.
  let returnedOrderId = null;
  let success = dispatchedViaDuplicate;
  if (!dispatchedViaDuplicate) {
    returnedOrderId = parseElementValue(responseXml, "orderId");
    const resultVal = (parseElementValue(responseXml, "result") || "").toLowerCase();
    success = !!returnedOrderId
      || resultVal === "true" || resultVal === "1"
      || /<(?:[a-z0-9_-]+:)?return[^>]*>(true|1)<\/(?:[a-z0-9_-]+:)?return>/i.test(responseXml);
  }
  if (!success) {
    const errMatch = (responseXml || "").match(/<faultstring[^>]*>([^<]+)<\/faultstring>/i)
                 || (responseXml || "").match(/<message[^>]*>([^<]+)<\/message>/i);
    const errMsg = errMatch ? errMatch[1] : "orders_new returned non-true. Raw: " + (responseXml || "").slice(0, 1500);
    order.rapidStatus = "failed";
    order.rapidError = String(errMsg).slice(0, 500);
    order.rapidRetryCount = attempt - 1;
    order.rapidLastFailedAt = new Date().toISOString();
    await env.STRATUS_DATA.put(`order:${orderId}`, JSON.stringify(order));
    return json({ ok: false, error: order.rapidError, retryable: true, attempts: attempt }, 502);
  }

  order.rapidStatus = "dispatched";
  order.rapidDispatchedAt = new Date().toISOString();
  order.rapidError = null;
  order.rapidRetryCount = attempt - 1;  // 0 if first try, 1 if took one retry
  order.rapidDispatchedViaDuplicate = dispatchedViaDuplicate || undefined;
  order.rapidOrderId = returnedOrderId
    || String(parseInt(String(orderId).replace(/[^0-9]/g, "")) || "");

  // Customer notification — fired the FIRST time a dispatch succeeds.
  // Idempotent via `orderDispatchedEmailSentAt` so admin "Retry Dispatch"
  // on an already-dispatched order doesn't re-send to the customer. We
  // best-effort the send: failure here doesn't unmark the dispatch.
  let dispatchedEmailResult = null;
  if (order.customerEmail && !order.orderDispatchedEmailSentAt) {
    try {
      const { sendOrderDispatchedEmail } = await import("../_lib/resend.js");
      dispatchedEmailResult = await sendOrderDispatchedEmail(env, { order });
      if (dispatchedEmailResult && dispatchedEmailResult.ok) {
        order.orderDispatchedEmailSentAt = new Date().toISOString();
        order.orderDispatchedEmailId = dispatchedEmailResult.id;
      } else if (dispatchedEmailResult && dispatchedEmailResult.error) {
        order.orderDispatchedEmailError = dispatchedEmailResult.error.slice(0, 200);
      }
    } catch (e) {
      order.orderDispatchedEmailError = String(e.message || e).slice(0, 200);
    }
  }

  await env.STRATUS_DATA.put(`order:${orderId}`, JSON.stringify(order));
  return json({
    ok: true,
    status: "dispatched",
    rapidOrderId: order.rapidOrderId,
    attempts: attempt,
    autoRecovered: attempt > 1 || dispatchedViaDuplicate,
    dispatchedEmailSent: !!(dispatchedEmailResult && dispatchedEmailResult.ok),
  });
}
