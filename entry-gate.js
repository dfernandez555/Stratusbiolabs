/*
 * Stratus Biolabs — Entry Gate
 * Required by Chaos & Control Master Agreement (Exhibit A) and FDA RUO positioning.
 *
 * Full-screen modal blocking site entry until visitor confirms:
 *   1. They are 21+ years old (age verification)
 *   2. They are purchasing for research use only
 *
 * Acceptance is stored in localStorage with a 30-day expiry. Choosing "Leave"
 * redirects to google.com. Decision is logged with timestamp + version so we
 * can re-prompt all visitors if compliance language changes (bump GATE_VERSION).
 */
(function () {
  "use strict";

  var KEY = "sbl-entry-accepted";
  var EXPIRY_DAYS = 30;
  var GATE_VERSION = 1;

  // Skip on admin page (gated by password) and any subpath that explicitly opts out.
  if (/\/admin/i.test(location.pathname)) return;
  if (document.documentElement.dataset.skipEntryGate === "true") return;

  // Honour existing acceptance.
  try {
    var raw = localStorage.getItem(KEY);
    if (raw) {
      var data = JSON.parse(raw);
      var age = (Date.now() - (data.ts || 0)) / 86400000; // days
      if (data.v === GATE_VERSION && age < EXPIRY_DAYS) return;
    }
  } catch (_) { /* corrupt storage → show modal */ }

  // ── Styles (scoped under .sbl-gate-* so they can't collide with site CSS) ──
  var css =
    // Overlay is now scrollable on viewports that can't fit the modal vertically.
    // padding-block creates breathing room top/bottom even when scrolled.
    ".sbl-gate-overlay{position:fixed;inset:0;z-index:99999;background:rgba(31,27,22,0.92);overflow-y:auto;-webkit-overflow-scrolling:touch;padding:2rem 1rem;font-family:'Inter',system-ui,sans-serif;animation:sbl-fade-in 0.3s ease;}" +
    "@keyframes sbl-fade-in{from{opacity:0}to{opacity:1}}" +
    // Modal centers horizontally via margin auto, vertically lives at top + scrolls.
    // On tall desktops there's plenty of headroom; on phones nothing gets clipped.
    ".sbl-gate-modal{background:#EFEAE0;max-width:500px;width:100%;margin:0 auto;padding:3rem 2.5rem;color:#1F1B16;position:relative;}" +
    ".sbl-gate-modal::before{content:'';position:absolute;top:-1px;left:-1px;width:32px;height:1px;background:#1F1B16;}" +
    ".sbl-gate-modal::after{content:'';position:absolute;top:-1px;left:-1px;width:1px;height:32px;background:#1F1B16;}" +
    ".sbl-gate-eyebrow{font-family:'JetBrains Mono',monospace;font-size:0.7rem;letter-spacing:0.28em;text-transform:uppercase;color:#7A746C;margin-bottom:1.25rem;}" +
    ".sbl-gate-brand{font-family:'Inter',sans-serif;font-size:0.78rem;font-weight:500;letter-spacing:0.32em;text-transform:uppercase;color:#1F1B16;margin-bottom:2rem;}" +
    ".sbl-gate-title{font-family:'Inter',sans-serif;font-size:1.8rem;font-weight:300;line-height:1.1;letter-spacing:-0.02em;margin-bottom:1.25rem;color:#1F1B16;}" +
    ".sbl-gate-body{font-size:0.95rem;color:#7A746C;line-height:1.65;margin-bottom:2rem;}" +
    ".sbl-gate-check{display:flex;gap:0.85rem;align-items:flex-start;margin-bottom:1.1rem;cursor:pointer;}" +
    ".sbl-gate-check input{width:18px;height:18px;margin-top:0.15rem;accent-color:#1F1B16;cursor:pointer;flex-shrink:0;}" +
    ".sbl-gate-check span{font-size:0.92rem;color:#1F1B16;line-height:1.5;cursor:pointer;}" +
    ".sbl-gate-check span strong{font-weight:500;}" +
    ".sbl-gate-actions{display:flex;gap:0.75rem;margin-top:2rem;flex-wrap:wrap;}" +
    ".sbl-gate-enter{flex:1 1 60%;font-family:'JetBrains Mono',monospace;font-size:0.74rem;letter-spacing:0.16em;text-transform:uppercase;font-weight:500;padding:1.05rem 1.4rem;background:#1F1B16;color:#EFEAE0;border:none;cursor:pointer;transition:background 0.2s,transform 0.15s;}" +
    ".sbl-gate-enter:hover:not(:disabled){background:#3D352C;transform:translateY(-1px);}" +
    ".sbl-gate-enter:disabled{opacity:0.32;cursor:not-allowed;}" +
    ".sbl-gate-leave{font-family:'JetBrains Mono',monospace;font-size:0.74rem;letter-spacing:0.16em;text-transform:uppercase;color:#7A746C;padding:1.05rem 1.2rem;background:none;border:1px solid rgba(31,27,22,0.18);cursor:pointer;transition:color 0.2s,border-color 0.2s;}" +
    ".sbl-gate-leave:hover{color:#1F1B16;border-color:#1F1B16;}" +
    ".sbl-gate-foot{font-family:'JetBrains Mono',monospace;font-size:0.58rem;letter-spacing:0.18em;color:#A39C92;text-transform:uppercase;margin-top:2rem;padding-top:1.5rem;border-top:1px solid rgba(31,27,22,0.1);text-align:center;}" +
    "@media (max-width:480px){.sbl-gate-overlay{padding:1rem;}.sbl-gate-modal{padding:2rem 1.5rem;}.sbl-gate-title{font-size:1.5rem;}.sbl-gate-body{font-size:0.9rem;margin-bottom:1.5rem;}.sbl-gate-actions{flex-direction:column;}.sbl-gate-enter,.sbl-gate-leave{flex:none;width:100%;}.sbl-gate-foot{margin-top:1.5rem;padding-top:1rem;}}";

  var style = document.createElement("style");
  style.id = "sbl-gate-style";
  style.textContent = css;
  document.head.appendChild(style);

  // Lock background scroll while modal is open.
  var prevOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";

  var overlay = document.createElement("div");
  overlay.className = "sbl-gate-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-labelledby", "sbl-gate-title");
  overlay.innerHTML =
    '<div class="sbl-gate-modal">' +
      '<p class="sbl-gate-brand">Stratus Biolabs</p>' +
      '<p class="sbl-gate-eyebrow">// Confirmation Required</p>' +
      '<h2 class="sbl-gate-title" id="sbl-gate-title">Before you enter.</h2>' +
      '<p class="sbl-gate-body">Stratus Biolabs supplies research-grade peptides for laboratory and in vitro use only. Products are not intended for human or veterinary consumption. Please confirm the following to continue.</p>' +
      '<label class="sbl-gate-check">' +
        '<input type="checkbox" id="sbl-gate-age"/>' +
        '<span>I confirm I am at least <strong>21 years of age</strong>.</span>' +
      '</label>' +
      '<label class="sbl-gate-check">' +
        '<input type="checkbox" id="sbl-gate-ruo"/>' +
        '<span>I confirm I am purchasing these products solely for <strong>research use</strong> and not for human or veterinary consumption.</span>' +
      '</label>' +
      '<div class="sbl-gate-actions">' +
        '<button type="button" class="sbl-gate-enter" id="sbl-gate-enter" disabled>Enter Site</button>' +
        '<button type="button" class="sbl-gate-leave" id="sbl-gate-leave">Leave</button>' +
      '</div>' +
      '<p class="sbl-gate-foot">For research use only — not for human or veterinary use</p>' +
    '</div>';
  document.body.appendChild(overlay);

  var ageBox = document.getElementById("sbl-gate-age");
  var ruoBox = document.getElementById("sbl-gate-ruo");
  var enterBtn = document.getElementById("sbl-gate-enter");
  var leaveBtn = document.getElementById("sbl-gate-leave");

  function refresh() {
    enterBtn.disabled = !(ageBox.checked && ruoBox.checked);
  }
  ageBox.addEventListener("change", refresh);
  ruoBox.addEventListener("change", refresh);

  enterBtn.addEventListener("click", function () {
    if (!ageBox.checked || !ruoBox.checked) return;
    try {
      localStorage.setItem(KEY, JSON.stringify({
        v: GATE_VERSION,
        ts: Date.now(),
        age21: true,
        ruo: true,
      }));
    } catch (_) { /* localStorage unavailable — gate will re-prompt next load */ }
    overlay.style.animation = "sbl-fade-in 0.25s reverse";
    setTimeout(function () {
      overlay.remove();
      style.remove();
      document.body.style.overflow = prevOverflow;
    }, 240);
  });

  leaveBtn.addEventListener("click", function () {
    // Send non-compliant visitors away. Google chosen as neutral destination.
    window.location.href = "https://www.google.com";
  });
})();
