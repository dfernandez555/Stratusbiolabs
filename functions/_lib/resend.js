// Shared helper for sending email via Resend.
//
// All customer-facing transactional emails route through here so we have one
// place to set the From address, branding, and error-handling policy.
//
// Calls are fire-and-forget from the caller's perspective: we log failures
// but never throw, so an email outage doesn't break checkout or webhook
// processing.

const RESEND_API = "https://api.resend.com/emails";

// We send "from" an address at the root domain — Resend uses the verified
// `send.stratusbiolabs.com` subdomain for the envelope-from (Return-Path,
// where bounces land and where SPF is checked), but customers see this in
// their inbox.
const FROM = "Stratus Biolabs <orders@stratusbiolabs.com>";
const REPLY_TO = "info@stratusbiolabs.com";

// Where admin notifications go. Override via the ADMIN_NOTIFICATION_EMAIL
// env var if you want a different inbox (e.g. once Martin needs alerts too).
const DEFAULT_ADMIN_INBOX = "info@stratusbiolabs.com";

/**
 * Send an email via Resend.
 * @param {object} env  - Cloudflare Pages env (must contain RESEND_API_KEY)
 * @param {object} opts - { to, subject, html, text? }
 * @returns {Promise<{ok: boolean, id?: string, error?: string}>}
 */
export async function sendEmail(env, { to, subject, html, text }) {
  if (!env.RESEND_API_KEY) {
    console.warn("RESEND_API_KEY not configured; skipping email", { to, subject });
    return { ok: false, error: "RESEND_API_KEY not set" };
  }
  if (!to || !subject || !html) {
    return { ok: false, error: "Missing required field (to/subject/html)" };
  }

  try {
    const res = await fetch(RESEND_API, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM,
        to: [to],
        reply_to: REPLY_TO,
        subject,
        html,
        text: text || stripHtml(html),
        // Deliverability headers. List-Unsubscribe + Auto-Submitted help us
        // pass Gmail/Outlook's "is this transactional?" heuristics — most
        // major filters score senders higher when these are present, even
        // on transactional mail. The mailto unsubscribe handler is just
        // info@ since we're not running a bulk list yet; any customer
        // emailing it asking to stop will reach the ops inbox.
        headers: {
          "List-Unsubscribe": "<mailto:info@stratusbiolabs.com?subject=unsubscribe>",
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          "Auto-Submitted": "auto-generated",
          "X-Entity-Ref-ID": "stratusbiolabs-transactional",
        },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, error: data.message || `HTTP ${res.status}` };
    }
    return { ok: true, id: data.id };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// Small util: derive a plain-text fallback from HTML for clients that
// can't render rich email (rare in 2026 but Resend wants both).
function stripHtml(html) {
  return String(html)
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

// Small util: HTML-escape a value before interpolating into the template.
function esc(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

// Build the public tracking URL for an order. Includes the per-order
// statusToken so the link works without auth but other customers can't
// enumerate order IDs to peek at someone else's order.
function trackUrl(env, order) {
  const base = env.PUBLIC_BASE_URL || "https://stratusbiolabs.com";
  if (!order || !order.orderId || !order.statusToken) return null;
  return `${base}/track?id=${encodeURIComponent(order.orderId)}&t=${encodeURIComponent(order.statusToken)}`;
}

/**
 * Order-received email for the BTC Buddies flow.
 * Includes the BTC address + amount + step-by-step instructions so the
 * customer can come back to it any time.
 */
export async function sendBtcBuddiesOrderEmail(env, { order, payAddress, payAmount }) {
  const orderId = order.orderId;
  const tUrl    = trackUrl(env, order);
  const items = Array.isArray(order.items) ? order.items : [];
  const itemRows = items.map(it => `
    <tr>
      <td style="padding:8px 0;font-size:14px;color:#1F1B16;">
        ${esc(it.name)} ${it.sizeKey ? `<span style="color:#7A746C;font-size:12px;">(${esc(it.sizeKey)})</span>` : ""}
      </td>
      <td style="padding:8px 0;font-size:14px;color:#7A746C;text-align:right;">× ${esc(it.qty)}</td>
      <td style="padding:8px 0;font-size:14px;color:#1F1B16;text-align:right;font-family:monospace;">$${((Number(it.price) || 0) * (Number(it.qty) || 1)).toFixed(2)}</td>
    </tr>
  `).join("");

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Order Received — ${esc(orderId)}</title></head>
<body style="margin:0;padding:0;background:#EFEAE0;font-family:-apple-system,BlinkMacSystemFont,'Inter',sans-serif;color:#1F1B16;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#EFEAE0;padding:32px 16px;">
<tr><td align="center">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;background:#FFFFFF;border:1px solid rgba(31,27,22,0.12);">
  <tr><td style="padding:32px 32px 24px;">
    <div style="font-size:12px;letter-spacing:0.25em;text-transform:uppercase;color:#7A746C;font-family:monospace;margin-bottom:8px;">// Order Received</div>
    <h1 style="margin:0 0 4px;font-size:28px;font-weight:300;color:#1F1B16;line-height:1.2;">Thank you for your order.</h1>
    <div style="font-family:monospace;font-size:13px;color:#7A746C;letter-spacing:0.1em;">Order ${esc(orderId)}</div>
  </td></tr>

  <tr><td style="padding:0 32px 24px;color:#1F1B16;font-size:15px;line-height:1.6;">
    <p style="margin:0 0 16px;">We've received your order. To complete it, please send your payment via <strong>Zelle through BTC Buddies</strong> using the steps below — they convert your Zelle payment to Bitcoin and forward it to us. Your order ships within 72 hours of payment confirmation.</p>
  </td></tr>

  <tr><td style="padding:0 32px;">
    <div style="background:#EFEAE0;border:1px solid rgba(31,27,22,0.12);padding:20px;">
      <div style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#7A746C;font-family:monospace;margin-bottom:12px;">// Payment Details</div>

      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr>
          <td style="padding:6px 0;font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:#7A746C;font-family:monospace;">USD Amount</td>
          <td style="padding:6px 0;font-size:15px;color:#1F1B16;text-align:right;font-family:monospace;"><strong>$${(Number(order.total) || 0).toFixed(2)}</strong></td>
        </tr>
        <tr>
          <td style="padding:6px 0;font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:#7A746C;font-family:monospace;">BTC Amount</td>
          <td style="padding:6px 0;font-size:15px;color:#1F1B16;text-align:right;font-family:monospace;"><strong>${esc(payAmount)} BTC</strong></td>
        </tr>
        <tr>
          <td colspan="2" style="padding-top:10px;font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:#7A746C;font-family:monospace;">Recipient BTC Address</td>
        </tr>
        <tr>
          <td colspan="2" style="padding:4px 0 6px;font-size:12px;color:#1F1B16;font-family:monospace;word-break:break-all;background:rgba(31,27,22,0.04);padding:10px;">${esc(payAddress)}</td>
        </tr>
        <tr>
          <td colspan="2" style="padding:10px 0 0;font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:#7A746C;font-family:monospace;">Reference / Order ID</td>
        </tr>
        <tr>
          <td colspan="2" style="padding:4px 0;font-size:13px;color:#1F1B16;font-family:monospace;"><strong>${esc(orderId)}</strong></td>
        </tr>
      </table>
    </div>
  </td></tr>

  <tr><td style="padding:24px 32px 0;">
    <div style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#7A746C;font-family:monospace;margin-bottom:12px;">// How to Pay via BTC Buddies</div>
    <ol style="margin:0;padding-left:20px;color:#1F1B16;font-size:14px;line-height:1.7;">
      <li>Visit <a href="https://www.btcbuddies.com/" style="color:#1F1B16;font-weight:500;">www.btcbuddies.com</a></li>
      <li>Click <strong>"Request a Transaction"</strong> at the top.</li>
      <li>Enter the <strong>USD amount</strong> shown above.</li>
      <li>Paste the <strong>BTC address</strong> above as the recipient. Double-check the first 3 and last 3 characters match.</li>
      <li>Include your <strong>Order ID</strong> (${esc(orderId)}) in the reference field so we can match your payment.</li>
      <li>Complete the payment via <strong>Zelle</strong>. BTC Buddies will convert your Zelle payment into BTC and send it to our wallet automatically.</li>
    </ol>
    <p style="margin:16px 0 0;font-size:12px;color:#7A746C;line-height:1.6;"><strong style="color:#1F1B16;">Note:</strong> BTC Buddies is a third-party service. Stratus Biolabs is not responsible for your transaction with BTC Buddies — please verify the wallet address carefully before submitting. Once BTC arrives at our address, your order auto-confirms and ships within 72 hours.</p>
  </td></tr>

  ${order.shippingAddress?.researchField ? `<tr><td style="padding:24px 32px 0;">
    <div style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#7A746C;font-family:monospace;margin-bottom:12px;">// Research Information</div>
    <div style="font-family:'Inter',sans-serif;font-size:13px;color:#1F1B16;line-height:1.6;">
      You certified your primary research field as: <strong>${esc(order.shippingAddress.researchField)}</strong>${order.shippingAddress?.institution ? ` &middot; ${esc(order.shippingAddress.institution)}` : ""}
    </div>
  </td></tr>` : ""}

  <tr><td style="padding:24px 32px 0;">
    <div style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#7A746C;font-family:monospace;margin-bottom:12px;">// Order Summary</div>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-top:1px solid rgba(31,27,22,0.12);">
      ${itemRows}
      <tr style="border-top:1px solid rgba(31,27,22,0.12);">
        <td style="padding:8px 0;font-size:12px;color:#7A746C;font-family:monospace;letter-spacing:0.1em;text-transform:uppercase;">Subtotal</td>
        <td></td>
        <td style="padding:8px 0;text-align:right;font-family:monospace;font-size:14px;">$${(Number(order.subtotal) || 0).toFixed(2)}</td>
      </tr>
      <tr>
        <td style="padding:4px 0;font-size:12px;color:#7A746C;font-family:monospace;letter-spacing:0.1em;text-transform:uppercase;">Shipping</td>
        <td></td>
        <td style="padding:4px 0;text-align:right;font-family:monospace;font-size:14px;">${Number(order.shipping) === 0 ? "Free" : "$" + (Number(order.shipping) || 0).toFixed(2)}</td>
      </tr>
      ${Number(order.discount) > 0 ? `<tr>
        <td style="padding:4px 0;font-size:12px;color:#7A746C;font-family:monospace;letter-spacing:0.1em;text-transform:uppercase;">Discount${order.promoCode ? " (" + esc(order.promoCode) + ")" : ""}</td>
        <td></td>
        <td style="padding:4px 0;text-align:right;font-family:monospace;font-size:14px;">-$${(Number(order.discount) || 0).toFixed(2)}</td>
      </tr>` : ""}
      <tr style="border-top:1px solid rgba(31,27,22,0.12);">
        <td style="padding:10px 0;font-size:13px;letter-spacing:0.1em;text-transform:uppercase;font-family:monospace;"><strong>Total</strong></td>
        <td></td>
        <td style="padding:10px 0;text-align:right;font-family:monospace;font-size:16px;"><strong>$${(Number(order.total) || 0).toFixed(2)}</strong></td>
      </tr>
      <tr>
        <td style="padding:6px 0;font-size:12px;color:#7A746C;font-family:monospace;letter-spacing:0.1em;text-transform:uppercase;">Payment Method</td>
        <td></td>
        <td style="padding:6px 0;text-align:right;font-size:13px;">Zelle via BTC Buddies</td>
      </tr>
    </table>
  </td></tr>

  ${tUrl ? `<tr><td style="padding:24px 32px 0;">
    <a href="${esc(tUrl)}" style="display:inline-block;font-family:'JetBrains Mono',monospace;font-size:12px;letter-spacing:0.16em;text-transform:uppercase;padding:14px 22px;background:#1F1B16;color:#EFEAE0;text-decoration:none;">Track Your Order →</a>
    <p style="margin:8px 0 0;font-size:11px;color:#7A746C;">View live status, payment confirmation, and shipping updates any time.</p>
  </td></tr>` : ""}

  <tr><td style="padding:24px 32px 32px;font-size:11px;color:#7A746C;line-height:1.6;border-top:1px solid rgba(31,27,22,0.12);margin-top:24px;">
    <p style="margin:0 0 8px;font-family:monospace;letter-spacing:0.1em;text-transform:uppercase;">// For Research Use Only</p>
    <p style="margin:0;">All products supplied by Stratus Biolabs are intended for laboratory, academic, or institutional research only. Not for human or animal consumption.</p>
    <p style="margin:12px 0 0;">Questions? Reply to this email or write to <a href="mailto:info@stratusbiolabs.com" style="color:#1F1B16;">info@stratusbiolabs.com</a> with your order ID.</p>
    <p style="margin:12px 0 0;font-size:10px;color:#A39C92;">📬 If our emails land in your spam/junk folder, mark them as "Not Spam" so future updates reach your inbox.</p>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;

  return sendEmail(env, {
    to: order.customerEmail,
    // Cleaner subject — avoid trigger words like "Payment Required" that
    // tip-off spam filters. Brand + order ID + neutral next-steps phrasing.
    subject: `Your Stratus Biolabs order ${orderId} — next steps`,
    html,
  });
}

/**
 * Payment-confirmed email, sent when NOWPayments IPN reports the BTC payment
 * arrived and the order has been auto-marked paid.
 */
export async function sendPaymentConfirmedEmail(env, { order }) {
  const orderId = order.orderId;
  const tUrl    = trackUrl(env, order);
  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Payment Confirmed — ${esc(orderId)}</title></head>
<body style="margin:0;padding:0;background:#EFEAE0;font-family:-apple-system,BlinkMacSystemFont,'Inter',sans-serif;color:#1F1B16;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#EFEAE0;padding:32px 16px;">
<tr><td align="center">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;background:#FFFFFF;border:1px solid rgba(31,27,22,0.12);">
  <tr><td style="padding:32px 32px 24px;">
    <div style="font-size:12px;letter-spacing:0.25em;text-transform:uppercase;color:#4a9a6a;font-family:monospace;margin-bottom:8px;">// Payment Confirmed</div>
    <h1 style="margin:0 0 4px;font-size:28px;font-weight:300;color:#1F1B16;line-height:1.2;">Your payment arrived.</h1>
    <div style="font-family:monospace;font-size:13px;color:#7A746C;letter-spacing:0.1em;">Order ${esc(orderId)}</div>
  </td></tr>

  <tr><td style="padding:0 32px 24px;color:#1F1B16;font-size:15px;line-height:1.7;">
    <p style="margin:0 0 16px;">We've received and confirmed your Bitcoin payment. Your order is now in fulfillment and will ship within 72 hours.</p>
    <p style="margin:0;color:#7A746C;font-size:13px;">You'll receive a separate email with tracking information once your order ships.</p>
  </td></tr>

  <tr><td style="padding:0 32px;">
    <div style="background:rgba(74,154,106,0.08);border:1px solid rgba(74,154,106,0.25);padding:16px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr>
          <td style="font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:#7A746C;font-family:monospace;">Amount Paid</td>
          <td style="font-size:15px;color:#1F1B16;text-align:right;font-family:monospace;"><strong>$${(Number(order.total) || 0).toFixed(2)}</strong></td>
        </tr>
        ${order.paymentChannel ? `<tr>
          <td style="padding-top:6px;font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:#7A746C;font-family:monospace;">Channel</td>
          <td style="padding-top:6px;font-size:13px;color:#1F1B16;text-align:right;">${esc(order.paymentChannel)}</td>
        </tr>` : ""}
        ${order.paymentReference ? `<tr>
          <td style="padding-top:6px;font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:#7A746C;font-family:monospace;">Reference</td>
          <td style="padding-top:6px;font-size:12px;color:#1F1B16;text-align:right;font-family:monospace;word-break:break-all;">${esc(order.paymentReference)}</td>
        </tr>` : ""}
      </table>
    </div>
  </td></tr>

  ${tUrl ? `<tr><td style="padding:24px 32px 0;">
    <a href="${esc(tUrl)}" style="display:inline-block;font-family:'JetBrains Mono',monospace;font-size:12px;letter-spacing:0.16em;text-transform:uppercase;padding:14px 22px;background:#1F1B16;color:#EFEAE0;text-decoration:none;">Track Your Order →</a>
  </td></tr>` : ""}

  <tr><td style="padding:24px 32px 32px;font-size:11px;color:#7A746C;line-height:1.6;border-top:1px solid rgba(31,27,22,0.12);margin-top:24px;">
    <p style="margin:0 0 8px;font-family:monospace;letter-spacing:0.1em;text-transform:uppercase;">// For Research Use Only</p>
    <p style="margin:0;">All products supplied by Stratus Biolabs are intended for laboratory, academic, or institutional research only. Not for human or animal consumption.</p>
    <p style="margin:12px 0 0;">Questions? Reply to this email or write to <a href="mailto:info@stratusbiolabs.com" style="color:#1F1B16;">info@stratusbiolabs.com</a> with your order ID.</p>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;

  return sendEmail(env, {
    to: order.customerEmail,
    subject: `Your Stratus Biolabs order ${orderId} is shipping soon`,
    html,
  });
}

/**
 * Customer-facing order email for Invoice-style payments (Cash App or Zelle
 * direct). Includes payment instructions inline so the customer can pay
 * even after closing the success-page tab.
 *
 * Previously only BTC Buddies orders triggered a customer email (sent from
 * create-btc-invoice.js). Invoice orders silently relied on the success
 * page — so any customer who closed the tab got nothing.
 */
export async function sendInvoiceOrderEmail(env, { order }) {
  const orderId = order.orderId;
  const method = String(order.paymentMethod || "").toLowerCase();
  const isCash = method === "cashapp";
  const items = Array.isArray(order.items) ? order.items : [];
  const itemRows = items.map(it => `
    <tr>
      <td style="padding:8px 0;font-size:14px;color:#1F1B16;">
        ${esc(it.name)} ${it.sizeKey ? `<span style="color:#7A746C;font-size:12px;">(${esc(it.sizeKey)})</span>` : ""}
      </td>
      <td style="padding:8px 0;font-size:14px;color:#7A746C;text-align:right;">× ${esc(it.qty)}</td>
      <td style="padding:8px 0;font-size:14px;color:#1F1B16;text-align:right;font-family:monospace;">$${((Number(it.price) || 0) * (Number(it.qty) || 1)).toFixed(2)}</td>
    </tr>
  `).join("");

  // Method-specific payment instructions block.
  const payInstructions = isCash
    ? `
      <div style="background:#EFEAE0;border:1px solid rgba(31,27,22,0.12);padding:20px;">
        <div style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#7A746C;font-family:monospace;margin-bottom:14px;">// Pay via Cash App</div>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
          <tr>
            <td style="padding:6px 0;font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:#7A746C;font-family:monospace;">Send to</td>
            <td style="padding:6px 0;font-size:18px;color:#1F1B16;text-align:right;font-family:monospace;"><strong>$dfernandez555</strong></td>
          </tr>
          <tr>
            <td style="padding:6px 0;font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:#7A746C;font-family:monospace;">Amount</td>
            <td style="padding:6px 0;font-size:16px;color:#1F1B16;text-align:right;font-family:monospace;"><strong>$${(Number(order.total) || 0).toFixed(2)}</strong></td>
          </tr>
        </table>
        <p style="margin:14px 0 0;font-size:12px;color:#7A746C;line-height:1.6;">
          <strong style="color:#1F1B16;">Important:</strong> Do NOT write anything in the Cash App note field. Tap the sparkle (✨) icon at the top right of the &ldquo;Note (required)&rdquo; field to bypass it. Keeping the note blank keeps the transaction private.
        </p>
      </div>`
    : `
      <div style="background:#EFEAE0;border:1px solid rgba(31,27,22,0.12);padding:20px;">
        <div style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#7A746C;font-family:monospace;margin-bottom:14px;">// Pay via Zelle</div>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
          <tr>
            <td style="padding:6px 0;font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:#7A746C;font-family:monospace;">Send to</td>
            <td style="padding:6px 0;font-size:18px;color:#1F1B16;text-align:right;font-family:monospace;"><strong>(909) 522-2875</strong></td>
          </tr>
          <tr>
            <td style="padding:6px 0;font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:#7A746C;font-family:monospace;">Amount</td>
            <td style="padding:6px 0;font-size:16px;color:#1F1B16;text-align:right;font-family:monospace;"><strong>$${(Number(order.total) || 0).toFixed(2)}</strong></td>
          </tr>
        </table>
        <p style="margin:14px 0 0;font-size:12px;color:#7A746C;line-height:1.6;">
          <strong style="color:#1F1B16;">Important — Do NOT write anything in the Zelle memo or comments field.</strong> Keeping the memo blank keeps the transaction private. We'll match your payment by the amount and the sender name from your bank, so please make sure the name on your Zelle account matches the name on your shipping address (or email us at <a href="mailto:info@stratusbiolabs.com" style="color:#1F1B16;">info@stratusbiolabs.com</a> with your order ID if they differ). Most banks (Chase, BofA, Wells Fargo, etc.) support Zelle via their mobile app.
        </p>
      </div>`;

  const methodLabel = isCash ? "Cash App" : "Zelle";

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Order Received — ${esc(orderId)}</title></head>
<body style="margin:0;padding:0;background:#EFEAE0;font-family:-apple-system,BlinkMacSystemFont,'Inter',sans-serif;color:#1F1B16;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#EFEAE0;padding:32px 16px;">
<tr><td align="center">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;background:#FFFFFF;border:1px solid rgba(31,27,22,0.12);">
  <tr><td style="padding:32px 32px 24px;">
    <div style="font-size:12px;letter-spacing:0.25em;text-transform:uppercase;color:#7A746C;font-family:monospace;margin-bottom:8px;">// Order Received</div>
    <h1 style="margin:0 0 4px;font-size:28px;font-weight:300;color:#1F1B16;line-height:1.2;">Thank you for your order.</h1>
    <div style="font-family:monospace;font-size:13px;color:#7A746C;letter-spacing:0.1em;">Order ${esc(orderId)}</div>
  </td></tr>

  <tr><td style="padding:0 32px 24px;color:#1F1B16;font-size:15px;line-height:1.6;">
    <p style="margin:0;">We've received your order. To complete it, please send your <strong>${esc(methodLabel)}</strong> payment using the details below. We'll mark your order paid within 24 hours of receiving funds, and ship within 72 hours of payment confirmation.</p>
  </td></tr>

  <tr><td style="padding:0 32px;">
    ${payInstructions}
  </td></tr>

  <tr><td style="padding:24px 32px 0;">
    <div style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#7A746C;font-family:monospace;margin-bottom:12px;">// Order Summary</div>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-top:1px solid rgba(31,27,22,0.12);">
      ${itemRows}
      <tr style="border-top:1px solid rgba(31,27,22,0.12);">
        <td style="padding:8px 0;font-size:12px;color:#7A746C;font-family:monospace;letter-spacing:0.1em;text-transform:uppercase;">Subtotal</td>
        <td></td>
        <td style="padding:8px 0;text-align:right;font-family:monospace;font-size:14px;">$${(Number(order.subtotal) || 0).toFixed(2)}</td>
      </tr>
      <tr>
        <td style="padding:4px 0;font-size:12px;color:#7A746C;font-family:monospace;letter-spacing:0.1em;text-transform:uppercase;">Shipping</td>
        <td></td>
        <td style="padding:4px 0;text-align:right;font-family:monospace;font-size:14px;">${Number(order.shipping) === 0 ? "Free" : "$" + (Number(order.shipping) || 0).toFixed(2)}</td>
      </tr>
      ${Number(order.discount) > 0 ? `<tr>
        <td style="padding:4px 0;font-size:12px;color:#7A746C;font-family:monospace;letter-spacing:0.1em;text-transform:uppercase;">Discount${order.promoCode ? " (" + esc(order.promoCode) + ")" : ""}</td>
        <td></td>
        <td style="padding:4px 0;text-align:right;font-family:monospace;font-size:14px;">-$${(Number(order.discount) || 0).toFixed(2)}</td>
      </tr>` : ""}
      <tr style="border-top:1px solid rgba(31,27,22,0.12);">
        <td style="padding:10px 0;font-size:13px;letter-spacing:0.1em;text-transform:uppercase;font-family:monospace;"><strong>Total</strong></td>
        <td></td>
        <td style="padding:10px 0;text-align:right;font-family:monospace;font-size:16px;"><strong>$${(Number(order.total) || 0).toFixed(2)}</strong></td>
      </tr>
      <tr>
        <td style="padding:6px 0;font-size:12px;color:#7A746C;font-family:monospace;letter-spacing:0.1em;text-transform:uppercase;">Payment Method</td>
        <td></td>
        <td style="padding:6px 0;text-align:right;font-size:13px;">${esc(methodLabel)} (direct)</td>
      </tr>
    </table>
  </td></tr>

  <tr><td style="padding:24px 32px 32px;font-size:11px;color:#7A746C;line-height:1.6;border-top:1px solid rgba(31,27,22,0.12);margin-top:24px;">
    <p style="margin:0 0 8px;font-family:monospace;letter-spacing:0.1em;text-transform:uppercase;">// For Research Use Only</p>
    <p style="margin:0;">All products supplied by Stratus Biolabs are intended for laboratory, academic, or institutional research only. Not for human or animal consumption.</p>
    <p style="margin:12px 0 0;">Questions? Reply to this email or write to <a href="mailto:info@stratusbiolabs.com" style="color:#1F1B16;">info@stratusbiolabs.com</a> with your order ID. <strong>Tip:</strong> if you don't see this email later, check your spam folder.</p>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;

  return sendEmail(env, {
    to: order.customerEmail,
    subject: `Your Stratus Biolabs order ${orderId} — ${methodLabel} payment instructions`,
    html,
  });
}

// Detect the carrier from a tracking number and return the corresponding
// tracking URL. Falls back to AfterShip's universal tracker (which auto-
// detects the carrier on their end) when none of our patterns match.
//
// We don't ask Rapid which carrier they used — they don't surface that
// reliably — so we infer from the tracking-number format. Patterns are
// the well-known prefixes/lengths used by the major US shippers.
function carrierLinkFor(trackingNumber) {
  const t = String(trackingNumber || "").trim().replace(/\s+/g, "");
  if (!t) return { carrier: null, url: null };

  // UPS: starts with "1Z" followed by 16 alphanumeric chars
  if (/^1Z[0-9A-Z]{16}$/i.test(t)) {
    return { carrier: "UPS", url: `https://www.ups.com/track?tracknum=${encodeURIComponent(t)}` };
  }
  // FedEx: 12 or 15 numeric digits
  if (/^[0-9]{12}$/.test(t) || /^[0-9]{15}$/.test(t)) {
    return { carrier: "FedEx", url: `https://www.fedex.com/fedextrack/?tracknumbers=${encodeURIComponent(t)}` };
  }
  // USPS: 22 numeric digits, OR starts with 9 with 22 digits, OR USPS prefixes (EA, ER, EC, etc.)
  if (/^[0-9]{20,22}$/.test(t) || /^9[0-9]{15,21}$/.test(t) || /^[A-Z]{2}[0-9]{9}US$/i.test(t)) {
    return { carrier: "USPS", url: `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(t)}` };
  }
  // DHL: 10 or 11 numeric digits (commonly used by DHL Express)
  if (/^[0-9]{10,11}$/.test(t)) {
    return { carrier: "DHL", url: `https://www.dhl.com/en/express/tracking.html?AWB=${encodeURIComponent(t)}` };
  }

  // Unknown — universal tracker (AfterShip auto-detects from their end)
  return { carrier: null, url: `https://www.aftership.com/track/${encodeURIComponent(t)}` };
}

/**
 * Customer-facing notification — fired from place-order.js the moment we
 * successfully dispatch to Rapid Fulfillment. Tells the customer their order
 * has been handed off and to expect a separate shipping email soon.
 *
 * Idempotent at the caller level via `order.orderDispatchedEmailSentAt`.
 */
export async function sendOrderDispatchedEmail(env, { order }) {
  const orderId = order.orderId;
  const tUrl    = trackUrl(env, order);
  const items   = Array.isArray(order.items) ? order.items : [];

  const itemsHtml = items.map(it => `
    <tr>
      <td style="padding:6px 0;font-size:14px;color:#1F1B16;">${esc(it.name)} <span style="color:#7A746C;">·</span> <span style="color:#7A746C;font-family:monospace;font-size:12px;">${esc(it.sizeKey || "")}</span></td>
      <td style="padding:6px 0;font-size:14px;color:#7A746C;text-align:right;">× ${esc(it.qty || 1)}</td>
    </tr>`).join("");

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Order Dispatched — ${esc(orderId)}</title></head>
<body style="margin:0;padding:0;background:#EFEAE0;font-family:-apple-system,BlinkMacSystemFont,'Inter',sans-serif;color:#1F1B16;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#EFEAE0;padding:32px 16px;">
<tr><td align="center">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;background:#FFFFFF;border:1px solid rgba(31,27,22,0.12);">
  <tr><td style="padding:32px 32px 24px;">
    <div style="font-size:12px;letter-spacing:0.25em;text-transform:uppercase;color:#4a9a6a;font-family:monospace;margin-bottom:8px;">// Order Dispatched</div>
    <h1 style="margin:0 0 4px;font-size:28px;font-weight:300;color:#1F1B16;line-height:1.2;">Your order is on its way.</h1>
    <div style="font-family:monospace;font-size:13px;color:#7A746C;letter-spacing:0.1em;">Order ${esc(orderId)}</div>
  </td></tr>

  <tr><td style="padding:0 32px 24px;color:#1F1B16;font-size:15px;line-height:1.7;">
    <p style="margin:0 0 16px;">Your order has been handed off to our fulfillment partner and is being prepared for shipment. You'll receive a separate email with your tracking number as soon as the carrier picks it up — typically within 24-72 hours.</p>
    <p style="margin:0;color:#7A746C;font-size:13px;">No further action is needed on your end.</p>
  </td></tr>

  ${items.length ? `<tr><td style="padding:0 32px 16px;">
    <div style="font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#7A746C;font-family:monospace;margin-bottom:10px;">// In this shipment</div>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-top:1px solid rgba(31,27,22,0.12);">
      ${itemsHtml}
    </table>
  </td></tr>` : ""}

  ${tUrl ? `<tr><td style="padding:8px 32px 0;">
    <a href="${esc(tUrl)}" style="display:inline-block;font-family:'JetBrains Mono',monospace;font-size:12px;letter-spacing:0.16em;text-transform:uppercase;padding:14px 22px;background:#1F1B16;color:#EFEAE0;text-decoration:none;">View Order Status →</a>
  </td></tr>` : ""}

  <tr><td style="padding:24px 32px 32px;font-size:11px;color:#7A746C;line-height:1.6;border-top:1px solid rgba(31,27,22,0.12);margin-top:24px;">
    <p style="margin:0 0 8px;font-family:monospace;letter-spacing:0.1em;text-transform:uppercase;">// For Research Use Only</p>
    <p style="margin:0;">All products supplied by Stratus Biolabs are intended for laboratory, academic, or institutional research only. Not for human or animal consumption.</p>
    <p style="margin:12px 0 0;">Questions? Reply to this email or write to <a href="mailto:info@stratusbiolabs.com" style="color:#1F1B16;">info@stratusbiolabs.com</a> with your order ID.</p>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;

  return sendEmail(env, {
    to: order.customerEmail,
    subject: `Your Stratus Biolabs order ${orderId} is being prepared for shipment`,
    html,
  });
}

/**
 * Customer-facing notification — fired from sync-rapid.js the first time
 * we detect that Rapid has shipped the order (status=shipped, tracking
 * number populated). Auto-detects carrier from the tracking number format
 * and includes a direct tracking link.
 *
 * Idempotent at the caller level via `order.orderShippedEmailSentAt`.
 */
export async function sendOrderShippedEmail(env, { order, trackingNumber, shippedAt }) {
  const orderId = order.orderId;
  const tUrl    = trackUrl(env, order);
  const tn      = trackingNumber || order.trackingNumber || "";
  const { carrier, url: carrierUrl } = carrierLinkFor(tn);

  const carrierLabel = carrier ? `via <strong>${esc(carrier)}</strong>` : "with the carrier";
  const shippedDate = shippedAt || order.shippedAt;
  let shippedDateLabel = "";
  try {
    if (shippedDate) {
      shippedDateLabel = new Date(shippedDate).toLocaleDateString("en-US", {
        weekday: "long", year: "numeric", month: "long", day: "numeric",
      });
    }
  } catch { /* fall through */ }

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Shipped — ${esc(orderId)}</title></head>
<body style="margin:0;padding:0;background:#EFEAE0;font-family:-apple-system,BlinkMacSystemFont,'Inter',sans-serif;color:#1F1B16;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#EFEAE0;padding:32px 16px;">
<tr><td align="center">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;background:#FFFFFF;border:1px solid rgba(31,27,22,0.12);">
  <tr><td style="padding:32px 32px 24px;">
    <div style="font-size:12px;letter-spacing:0.25em;text-transform:uppercase;color:#4a9a6a;font-family:monospace;margin-bottom:8px;">// Shipped</div>
    <h1 style="margin:0 0 4px;font-size:28px;font-weight:300;color:#1F1B16;line-height:1.2;">Your order has shipped.</h1>
    <div style="font-family:monospace;font-size:13px;color:#7A746C;letter-spacing:0.1em;">Order ${esc(orderId)}</div>
  </td></tr>

  <tr><td style="padding:0 32px 24px;color:#1F1B16;font-size:15px;line-height:1.7;">
    <p style="margin:0 0 16px;">Your order is on the move ${carrierLabel}${shippedDateLabel ? ` &mdash; picked up <strong>${esc(shippedDateLabel)}</strong>` : ""}.</p>
  </td></tr>

  ${tn ? `<tr><td style="padding:0 32px 16px;">
    <div style="background:rgba(31,27,22,0.05);border:1px solid rgba(31,27,22,0.12);padding:16px;">
      <div style="font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#7A746C;font-family:monospace;margin-bottom:6px;">// Tracking Number</div>
      <div style="font-family:monospace;font-size:16px;color:#1F1B16;letter-spacing:0.02em;word-break:break-all;"><strong>${esc(tn)}</strong></div>
      ${carrier ? `<div style="margin-top:6px;font-size:12px;color:#7A746C;">Carrier: ${esc(carrier)}</div>` : ""}
    </div>
  </td></tr>` : ""}

  ${carrierUrl ? `<tr><td style="padding:8px 32px 0;">
    <a href="${esc(carrierUrl)}" style="display:inline-block;font-family:'JetBrains Mono',monospace;font-size:12px;letter-spacing:0.16em;text-transform:uppercase;padding:14px 22px;background:#1F1B16;color:#EFEAE0;text-decoration:none;margin-right:8px;margin-bottom:8px;">Track With ${esc(carrier || "Carrier")} →</a>
    ${tUrl ? `<a href="${esc(tUrl)}" style="display:inline-block;font-family:'JetBrains Mono',monospace;font-size:12px;letter-spacing:0.16em;text-transform:uppercase;padding:14px 22px;background:transparent;color:#1F1B16;border:1px solid rgba(31,27,22,0.18);text-decoration:none;margin-bottom:8px;">Order Status</a>` : ""}
  </td></tr>` : (tUrl ? `<tr><td style="padding:8px 32px 0;">
    <a href="${esc(tUrl)}" style="display:inline-block;font-family:'JetBrains Mono',monospace;font-size:12px;letter-spacing:0.16em;text-transform:uppercase;padding:14px 22px;background:#1F1B16;color:#EFEAE0;text-decoration:none;">View Order Status →</a>
  </td></tr>` : "")}

  <tr><td style="padding:24px 32px 32px;font-size:11px;color:#7A746C;line-height:1.6;border-top:1px solid rgba(31,27,22,0.12);margin-top:24px;">
    <p style="margin:0 0 8px;font-family:monospace;letter-spacing:0.1em;text-transform:uppercase;">// For Research Use Only</p>
    <p style="margin:0;">All products supplied by Stratus Biolabs are intended for laboratory, academic, or institutional research only. Not for human or animal consumption.</p>
    <p style="margin:12px 0 0;">Questions about your shipment? Reply to this email or write to <a href="mailto:info@stratusbiolabs.com" style="color:#1F1B16;">info@stratusbiolabs.com</a> with your order ID.</p>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;

  return sendEmail(env, {
    to: order.customerEmail,
    subject: `Your Stratus Biolabs order ${orderId} has shipped${carrier ? ` (${carrier})` : ""}`,
    html,
  });
}

/**
 * Admin notification — fired from log-order whenever a new order is created.
 * Per-method actionability hint helps you decide whether to do anything:
 *   - btcbuddies / crypto / free → auto-confirms; FYI only
 *   - cashapp / zelle           → action needed: verify funds + Mark Paid in /admin
 */
export async function sendAdminOrderNotificationEmail(env, { order }) {
  const orderId = order.orderId;
  const method = String(order.paymentMethod || "").toLowerCase();
  const items = Array.isArray(order.items) ? order.items : [];
  const addr  = order.shippingAddress || {};

  const methodLabel =
    method === "btcbuddies" ? "Zelle via BTC Buddies" :
    method === "crypto"     ? "Cryptocurrency (NOWPayments)" :
    method === "cashapp"    ? "Cash App" :
    method === "zelle"      ? "Zelle (direct)" :
    method === "free"       ? "Free order (100% promo)" :
    method;

  const needsAction =
    method === "cashapp" || method === "zelle";
  const actionHtml = needsAction
    ? `<div style="margin-top:6px;padding:10px 14px;background:rgba(229,165,57,0.12);border:1px solid rgba(229,165,57,0.4);font-size:13px;color:#9a6a17;">
         <strong>Action needed:</strong> verify funds in your ${method === "cashapp" ? "Cash App" : "bank Zelle"} app, then click <strong>Mark Paid</strong> in /admin.
       </div>`
    : `<div style="margin-top:6px;padding:10px 14px;background:rgba(74,154,106,0.10);border:1px solid rgba(74,154,106,0.35);font-size:13px;color:#3a6d4f;">
         <strong>No action needed.</strong> Auto-confirms via NOWPayments webhook, then dispatches to Rapid automatically.
       </div>`;

  const itemRows = items.map(it => `
    <tr>
      <td style="padding:4px 0;font-size:13px;">${esc(it.name || it.sku)} ${it.sizeKey ? `<span style="color:#7A746C;font-size:11px;">(${esc(it.sizeKey)})</span>` : ""}</td>
      <td style="padding:4px 0;font-size:12px;color:#7A746C;text-align:right;">×${esc(it.qty)}</td>
      <td style="padding:4px 0;font-family:monospace;font-size:12px;text-align:right;">$${((Number(it.price) || 0) * (Number(it.qty) || 1)).toFixed(2)}</td>
    </tr>
  `).join("");

  const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#EFEAE0;font-family:-apple-system,BlinkMacSystemFont,'Inter',sans-serif;color:#1F1B16;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#EFEAE0;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;background:#FFFFFF;border:1px solid rgba(31,27,22,0.12);">
  <tr><td style="padding:24px 28px 16px;">
    <div style="font-size:11px;letter-spacing:0.22em;text-transform:uppercase;color:#7A746C;font-family:monospace;margin-bottom:6px;">// New Order</div>
    <h1 style="margin:0;font-size:22px;font-weight:400;color:#1F1B16;line-height:1.2;">
      $${(Number(order.total) || 0).toFixed(2)} &middot; ${esc(methodLabel)}
    </h1>
    <div style="margin-top:6px;font-family:monospace;font-size:13px;color:#7A746C;letter-spacing:0.08em;">
      Order ${esc(orderId)}
    </div>
  </td></tr>

  <tr><td style="padding:0 28px 16px;">
    ${actionHtml}
  </td></tr>

  <tr><td style="padding:0 28px 16px;">
    <div style="font-size:10px;letter-spacing:0.2em;text-transform:uppercase;color:#7A746C;font-family:monospace;margin-bottom:8px;">// Items</div>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
      ${itemRows || `<tr><td style="color:#7A746C;font-size:12px;font-style:italic;">no items</td></tr>`}
    </table>
  </td></tr>

  <tr><td style="padding:0 28px 16px;">
    <div style="font-size:10px;letter-spacing:0.2em;text-transform:uppercase;color:#7A746C;font-family:monospace;margin-bottom:8px;">// Customer</div>
    <div style="font-size:13px;line-height:1.5;color:#1F1B16;">
      <div><strong>${esc((addr.firstName || "") + " " + (addr.lastName || ""))}</strong></div>
      <div style="font-family:monospace;font-size:12px;color:#7A746C;">${esc(order.customerEmail || "")}</div>
      ${addr.researchField ? `<div style="font-size:12px;color:#7A746C;margin-top:4px;">Research field: ${esc(addr.researchField)}</div>` : ""}
      <div style="margin-top:6px;font-size:12px;color:#7A746C;">
        ${esc(addr.city || "")}${addr.state ? ", " + esc(addr.state) : ""} ${esc(addr.zip || "")}${addr.country && addr.country !== "United States" ? " &middot; " + esc(addr.country) : ""}
      </div>
    </div>
  </td></tr>

  <tr><td style="padding:14px 28px 22px;border-top:1px solid rgba(31,27,22,0.1);font-size:11px;color:#7A746C;line-height:1.6;">
    Open in admin: <a href="https://stratusbiolabs.com/admin" style="color:#1F1B16;font-family:monospace;">stratusbiolabs.com/admin</a>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;

  // Subject line categorization makes it obvious at a glance which orders
  // need your attention (Invoice = manual verify + Mark Paid) vs which are
  // already handling themselves (BTC Buddies / crypto = auto-confirms via
  // webhook). Filterable in Zoho/Gmail so admin can triage faster.
  const subjectPrefix = needsAction
    ? `[INVOICE — VERIFY PAYMENT]`
    : `[AUTO — ${methodLabel.toUpperCase()}]`;

  return sendEmail(env, {
    to: env.ADMIN_NOTIFICATION_EMAIL || DEFAULT_ADMIN_INBOX,
    subject: `${subjectPrefix} $${(Number(order.total) || 0).toFixed(2)} — ${orderId}`,
    html,
  });
}
