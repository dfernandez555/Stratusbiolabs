/*
 * Stratus Biolabs — Share button helper.
 *
 * On mobile (iOS Safari, Android Chrome, etc.): triggers the native OS share
 * sheet with the page URL pre-filled. From there the customer can post to
 * Instagram Stories (link sticker), DM via iMessage / WhatsApp, share to X,
 * etc. — whatever apps they have installed.
 *
 * On desktop (where navigator.share isn't available): copies the URL to the
 * clipboard and shows a brief inline toast.
 *
 * Usage: any button with [data-share] attribute auto-binds on page load.
 * Optionally pass data-share-text="..." to override the default share text.
 */
(function () {
  "use strict";

  function makeToast() {
    if (document.getElementById("sbl-share-toast")) return document.getElementById("sbl-share-toast");
    var t = document.createElement("div");
    t.id = "sbl-share-toast";
    t.style.cssText =
      "position:fixed;left:50%;bottom:calc(1.5rem + env(safe-area-inset-bottom));" +
      "transform:translateX(-50%) translateY(120%);" +
      "background:#1F1B16;color:#EFEAE0;font-family:'Inter',system-ui,sans-serif;" +
      "font-size:0.85rem;padding:0.85rem 1.5rem;letter-spacing:0.01em;" +
      "box-shadow:0 8px 24px rgba(31,27,22,0.25);" +
      "z-index:9999;transition:transform 0.3s cubic-bezier(0.4,0,0.2,1);" +
      "opacity:0;pointer-events:none;max-width:90vw;text-align:center;";
    document.body.appendChild(t);
    return t;
  }

  function showToast(message) {
    var t = makeToast();
    t.textContent = message;
    requestAnimationFrame(function () {
      t.style.transform = "translateX(-50%) translateY(0)";
      t.style.opacity = "1";
    });
    setTimeout(function () {
      t.style.transform = "translateX(-50%) translateY(120%)";
      t.style.opacity = "0";
    }, 2400);
  }

  async function sharePage(opts) {
    opts = opts || {};
    var shareData = {
      title: document.title || "Stratus Biolabs",
      text:  opts.text || "Research-grade peptides — Stratus Biolabs",
      url:   opts.url  || window.location.href,
    };

    // Web Share API (iOS Safari, Android Chrome, Safari macOS 14+, Edge mobile)
    if (navigator.share) {
      try {
        await navigator.share(shareData);
        return { ok: true, method: "native" };
      } catch (e) {
        // User cancelled the share sheet — silent, not an error.
        if (e && e.name === "AbortError") return { ok: false, method: "cancelled" };
        // Fall through to clipboard for other errors.
      }
    }

    // Clipboard fallback (desktop or browsers without Web Share)
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(shareData.url);
        showToast("Link copied — paste anywhere to share");
        return { ok: true, method: "clipboard" };
      }
    } catch { /* fall through */ }

    // Textarea fallback for browsers/contexts without modern clipboard API.
    try {
      var ta = document.createElement("textarea");
      ta.value = shareData.url;
      ta.style.cssText = "position:fixed;left:-9999px;top:-9999px;";
      document.body.appendChild(ta);
      ta.focus(); ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      showToast("Link copied — paste anywhere to share");
      return { ok: true, method: "execCommand" };
    } catch {
      showToast("Could not share. Long-press the URL to copy.");
      return { ok: false };
    }
  }

  // Auto-bind any element with [data-share]. Markup pattern:
  //   <button type="button" data-share>Share</button>
  // Optional override:
  //   <button data-share data-share-text="Custom share text">Share</button>
  function bind() {
    document.querySelectorAll("[data-share]").forEach(function (el) {
      if (el.__sblShareBound) return;
      el.__sblShareBound = true;
      el.addEventListener("click", function (e) {
        e.preventDefault();
        sharePage({ text: el.getAttribute("data-share-text") || undefined });
      });
    });
  }

  // Expose globally so pages can call sharePage() directly if they want.
  window.shareThisPage = sharePage;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bind);
  } else {
    bind();
  }
})();
