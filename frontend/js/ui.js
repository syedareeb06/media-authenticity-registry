/* UI helpers shared by all projects: escaping, formatting, toasts, hashing, files. */
(function () {
  const esc = (v) =>
    String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  const short = (hex, n = 6) => (hex && hex.length > 2 * n + 2 ? hex.slice(0, n + 2) + "…" + hex.slice(-n) : hex || "-");

  const pad = (n) => String(n).padStart(2, "0");
  function fmtTime(ts) {
    if (!ts) return "-";
    const d = new Date(Number(ts) * 1000);
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  function fmtClock(ts) {
    const d = new Date(Number(ts) * 1000);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  function fmtDuration(sec) {
    sec = Math.max(0, Math.floor(sec));
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (d) return `${d}d ${h}h ${m}m`;
    if (h) return `${h}h ${pad(m)}m ${pad(s)}s`;
    return `${m}m ${pad(s)}s`;
  }

  // ---------- toasts ----------
  function toast(message, kind = "info", ms = 4500) {
    let host = document.getElementById("toasts");
    if (!host) {
      host = document.createElement("div");
      host.id = "toasts";
      document.body.appendChild(host);
    }
    const el = document.createElement("div");
    el.className = `toast toast-${kind}`;
    el.setAttribute("role", kind === "error" ? "alert" : "status");
    el.textContent = message;
    host.appendChild(el);
    setTimeout(() => {
      el.classList.add("toast-out");
      setTimeout(() => el.remove(), 300);
    }, ms);
  }

  /** Disable a button while an async action runs; shows errors as toasts. */
  async function busy(button, fn) {
    const original = button ? button.innerHTML : "";
    if (button) {
      button.disabled = true;
      button.innerHTML = `<span class="spinner" aria-hidden="true"></span>${original}`;
    }
    try {
      return await fn();
    } catch (e) {
      if (!e.revert) console.error(e); // smart-contract rejections are expected, not bugs
      toast(e.message || String(e), "error", 7000);
    } finally {
      if (button && button.isConnected) {
        button.disabled = false;
        button.innerHTML = original;
      }
    }
  }

  // ---------- bytes / hashing ----------
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const toBytes = (v) => (typeof v === "string" ? enc.encode(v) : v instanceof Uint8Array ? v : new Uint8Array(v));
  const bytesToHex = (b) => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  function hexToBytes(hex) {
    const h = hex.startsWith("0x") ? hex.slice(2) : hex;
    const out = new Uint8Array(h.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
    return out;
  }
  async function sha256(data) {
    const digest = await crypto.subtle.digest("SHA-256", toBytes(data));
    return bytesToHex(new Uint8Array(digest));
  }
  const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));
  function bytesToBase64(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function base64ToBytes(b64) {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  // ---------- files ----------
  function download(filename, content, type = "text/plain") {
    const blob = content instanceof Blob ? content : new Blob([content], { type });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 500);
  }
  const readFileText = (file) => file.text();
  const readFileBytes = async (file) => new Uint8Array(await file.arrayBuffer());

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast("Copied to clipboard", "success", 2000);
    } catch {
      toast("Copy failed - select the text and copy manually", "error");
    }
  }

  // ---------- live verification checklist ----------
  /** Render items [{title, status: "ok"|"bad"|"run"|"todo", detail}] as a checklist. */
  function checklist(items) {
    const marks = { ok: "✓", bad: "✕", run: "…" };
    return `<ol class="checklist">${items
      .map(
        (it, i) => `<li class="${it.status || ""}" data-i="${i}"><span class="mark">${marks[it.status] || i + 1}</span>
        <span><span class="title">${esc(it.title)}</span><span class="detail">${esc(it.detail || "")}</span></span></li>`
      )
      .join("")}</ol>`;
  }

  /** Run steps one by one, updating `host` live. Each step: { title, run: async () => detailText }.
   *  Stops at the first failure. Returns { ok, items } so callers can keep the result. */
  async function runSteps(host, steps) {
    const items = steps.map((s) => ({ title: s.title, status: "todo", detail: "" }));
    const paint = () => host && host.isConnected && (host.innerHTML = checklist(items));
    for (let i = 0; i < steps.length; i++) {
      items[i].status = "run";
      paint();
      try {
        items[i].detail = (await steps[i].run()) || "";
        items[i].status = "ok";
      } catch (e) {
        items[i].status = "bad";
        items[i].detail = e.message || String(e);
        paint();
        return { ok: false, items, error: e };
      }
      paint();
    }
    return { ok: true, items };
  }

  function setDocTheme(theme) {
    const root = document.documentElement;
    if (theme) root.setAttribute("data-theme", theme);
    else root.removeAttribute("data-theme");
  }

  window.UI = {
    esc,
    short,
    fmtTime,
    fmtClock,
    fmtDuration,
    toast,
    busy,
    toBytes,
    bytesToHex,
    hexToBytes,
    sha256,
    randomBytes,
    bytesToBase64,
    base64ToBytes,
    utf8: dec,
    download,
    readFileText,
    readFileBytes,
    copy,
    checklist,
    runSteps,
    setDocTheme,
  };
})();
