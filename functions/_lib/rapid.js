// Shared Rapid Fulfillment SOAP client.
//
// Used by:
//   - functions/api/place-order.js       (orders_new — dispatch new orders)
//   - functions/api/admin/order.js       (orders_cancel — when admin cancels)
//   - functions/api/admin/sync-rapid.js  (orders_get — pull current status)
//
// Endpoint:  /api/soap/?action  at RAPID_API_HOST
// SOAPAction header (same for every method):  urn:WF_Api_Soap_HandlerAction
// Auth:      login → sessionId → pass sessionId to every other call → logout
//
// Method names below (orders_cancel, orders_get) are best-effort guesses based
// on Rapid's naming convention (we know `login`, `logout`, `orders_new` work).
// If a method 404s with "Procedure not found" in the SOAP fault, we surface
// that exact error so admin can email Ethan with the right thing to ask for.

export function escapeXml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

// Extract the named child element value out of a SOAP response. Rapid's
// responses wrap returns in named tags like <sessionId>, <return>, etc.
export function parseElementValue(xml, tagName) {
  const re = new RegExp(`<(?:[a-z0-9_-]+:)?${tagName}[^>]*>([^<]*)<\\/(?:[a-z0-9_-]+:)?${tagName}>`, "i");
  const m = xml.match(re);
  return m ? m[1] : null;
}

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

export async function soapCall(env, method, paramsXml) {
  const host = env.RAPID_API_HOST || "stratusbiolabs.rapidfulfillmentcrm.com";
  const url  = `https://${host}/api/soap/?action`;
  const body = soapEnvelope(method, paramsXml);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      "SOAPAction":   "urn:WF_Api_Soap_HandlerAction",
    },
    body,
  });
  const text = await res.text();
  const fault = text.match(/<faultstring[^>]*>([^<]+)<\/faultstring>/i);
  if (fault) throw new Error(`Rapid SOAP fault (${method}): ${fault[1]}`);
  if (!res.ok) throw new Error(`Rapid SOAP HTTP ${res.status} on ${method}: ${text.slice(0, 200)}`);
  return text;
}

export async function rapidLogin(env) {
  const params =
    `<username xsi:type="xsd:string">${escapeXml(env.RAPID_API_USERNAME)}</username>` +
    `<password xsi:type="xsd:string">${escapeXml(env.RAPID_API_PASSWORD)}</password>`;
  const xml = await soapCall(env, "login", params);
  const sessionId = parseElementValue(xml, "sessionId");
  if (!sessionId) throw new Error(`Login: no sessionId in response. Raw: ${xml.slice(0, 1500)}`);
  return sessionId;
}

export async function rapidLogout(env, sessionId) {
  try {
    const params = `<sessionId xsi:type="xsd:string">${escapeXml(sessionId)}</sessionId>`;
    await soapCall(env, "logout", params);
  } catch { /* best-effort */ }
}

/**
 * Cancel an order on the Rapid side.
 * @returns { ok: true } on success
 *          { ok: false, error: "..." } on failure (e.g. order already shipped,
 *          method not supported, network issue). Caller decides whether to
 *          still mark the order cancelled locally.
 *
 * Method guess: `orders_cancel`. If Rapid returns a "Procedure not found"
 * SOAP fault, the error message will say exactly that so admin can ask
 * Ethan/Denise for the actual method name and we can rename here.
 */
export async function rapidCancelOrder(env, orderIdNumeric) {
  if (!env.RAPID_API_USERNAME || !env.RAPID_API_PASSWORD) {
    return { ok: false, error: "Rapid API credentials not configured" };
  }
  let sessionId = null;
  try {
    sessionId = await rapidLogin(env);
    const params =
      `<sessionId xsi:type="xsd:string">${escapeXml(sessionId)}</sessionId>` +
      `<orderId xsi:type="xsd:string">${escapeXml(String(orderIdNumeric))}</orderId>`;
    const xml = await soapCall(env, "orders_cancel", params);
    // Success indicator: a <return>true</return> or just non-fault response.
    const success = /<(?:[a-z0-9:]+:)?return[^>]*>(true|1)<\/(?:[a-z0-9:]+:)?return>/i.test(xml) ||
                    !/<faultstring/i.test(xml);
    if (!success) return { ok: false, error: `orders_cancel returned non-true: ${xml.slice(0, 300)}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  } finally {
    if (sessionId) await rapidLogout(env, sessionId);
  }
}

/**
 * Query Rapid for the current status of an order.
 * Used by the sync-rapid endpoint to detect cancellations or status changes
 * made directly in Rapid's CRM (e.g. ops voids an order on their end).
 *
 * @returns { ok: true, status: "cancelled" | "shipped" | "queued" | "unknown",
 *            shippedAt: ISO string | null, trackingNumber: string | null,
 *            raw: { ... extracted fields ... } }
 *          { ok: false, error: "..." } on failure
 *
 * Method guess: `orders_get`. Rapid's response structure unknown until we
 * see a real one — this helper is permissive and extracts whatever fields
 * it can identify by common tag names.
 */
export async function rapidGetOrderStatus(env, orderIdNumeric) {
  if (!env.RAPID_API_USERNAME || !env.RAPID_API_PASSWORD) {
    return { ok: false, error: "Rapid API credentials not configured" };
  }
  let sessionId = null;
  try {
    sessionId = await rapidLogin(env);
    const params =
      `<sessionId xsi:type="xsd:string">${escapeXml(sessionId)}</sessionId>` +
      `<orderId xsi:type="xsd:string">${escapeXml(String(orderIdNumeric))}</orderId>`;
    const xml = await soapCall(env, "orders_get", params);

    // Permissive extraction — pull whatever common fields exist.
    const orderStatus = (parseElementValue(xml, "status") ||
                         parseElementValue(xml, "order_status") ||
                         parseElementValue(xml, "state") ||
                         "").toLowerCase().trim();
    const shippedAt = parseElementValue(xml, "shipped_at") ||
                      parseElementValue(xml, "shipping_date") ||
                      parseElementValue(xml, "ship_date") ||
                      parseElementValue(xml, "dispatched_at") ||
                      parseElementValue(xml, "shipdate") ||
                      null;

    // Try every conventional name Rapid (or generic CRMs) may use for the
    // tracking number. Rapid's CRM definitely shows tracking on shipped
    // orders — if we still pull null after this expanded list, the WSDL
    // probably uses a nested structure (e.g. <shipments><tracking>) which
    // would require an actual schema lookup or sample response inspection.
    const TRACKING_KEYS = [
      "tracking_number", "tracking", "trackingNumber",
      "track_number", "track_id", "tracking_id",
      "shipping_tracking_number", "shipment_tracking",
      "shipment_tracking_number", "carrier_tracking_number",
      "carrier_tracking", "waybill", "waybill_number",
      "consignment", "consignment_number", "airbill", "airwaybill",
    ];
    let trackingNumber = null;
    for (const k of TRACKING_KEYS) {
      const v = parseElementValue(xml, k);
      if (v && String(v).trim()) { trackingNumber = String(v).trim(); break; }
    }

    // Try to also surface the carrier name if Rapid reports it separately.
    const carrierName = parseElementValue(xml, "carrier") ||
                        parseElementValue(xml, "shipping_carrier") ||
                        parseElementValue(xml, "courier") ||
                        null;

    // Normalize to our vocabulary
    let normalized = "unknown";
    if (/cancel|void|reject/i.test(orderStatus)) normalized = "cancelled";
    else if (/ship|dispatch|complete|fulfill/i.test(orderStatus)) normalized = "shipped";
    else if (/queue|pending|hold|new/i.test(orderStatus)) normalized = "queued";

    return {
      ok: true,
      status: normalized,
      rawStatus: orderStatus || null,
      shippedAt: shippedAt,
      trackingNumber: trackingNumber,
      carrierName: carrierName,
      // Snippet of raw XML so admin can verify what fields Rapid actually
      // sent — useful when debugging "why didn't tracking come through?"
      rawXmlExcerpt: xml ? xml.slice(0, 1500) : null,
    };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  } finally {
    if (sessionId) await rapidLogout(env, sessionId);
  }
}

// Convert our "SB-NNNNNN" orderId to the numeric ID Rapid expects.
// Same logic as buildOrderXml uses when creating orders.
export function orderIdToRapidNumeric(orderId) {
  const n = parseInt(String(orderId).replace(/[^0-9]/g, ""));
  return n || 0;
}
