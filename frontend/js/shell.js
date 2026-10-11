/* Shell - app frame shared by all projects: top bar, navigation, chain mode
 * switch, chain clock + time travel, theme, router and re-rendering. */
(function () {
  const ICONS = {
    home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/>',
    building: '<path d="M3 21h18"/><path d="M5 21V8l7-5 7 5v13"/><path d="M9 21v-4h6v4"/><path d="M9 10h.01M15 10h.01M9 13.5h.01M15 13.5h.01"/>',
    key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.8-9.8"/><path d="m16 7 3 3"/><path d="m18.5 4.5 2 2"/>',
    school: '<path d="m2 9 10-5 10 5-10 5z"/><path d="M6 11v5c0 1.7 2.7 3 6 3s6-1.3 6-3v-5"/><path d="M22 9v6"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
    blocks: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><path d="M10 6.5h4M17.5 10v4"/>',
    book: '<path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v17H6.5A2.5 2.5 0 0 0 4 21.5z"/><path d="M4 21.5A2.5 2.5 0 0 1 6.5 19H20v3H6.5"/>',
    shield: '<path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
    upload: '<path d="M12 15V3"/><path d="m7 8 5-5 5 5"/><path d="M5 21h14"/>',
    check: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
    cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
    layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
    bug: '<rect x="7" y="7" width="10" height="13" rx="5"/><path d="M9 7a3 3 0 0 1 6 0"/><path d="M3 13h4M17 13h4M4 7l3 2M20 7l-3 2M4 19l3-2M20 19l-3-2M12 11v9"/>',
    coins: '<circle cx="9" cy="9" r="6"/><path d="M15.5 3.5a6 6 0 0 1 0 11M12 21a6 6 0 0 0 9-5"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M21.5 20a6.5 6.5 0 0 0-4-6"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
    forward: '<path d="m4 6 7 6-7 6z"/><path d="m13 6 7 6-7 6z"/>',
    reset: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  };
  const icon = (name) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;

  let opts;
  let busyDepth = 0;
  let renderSeq = 0;
  let lastRouteId = null;
  const state = {}; // per-app UI state (selected tabs, last results...)

  const $ = (sel, root = document) => root.querySelector(sel);

  function buildChrome() {
    const b = opts.brand;
    document.body.innerHTML = `
      <header class="topbar">
        <a class="brand" href="#/">
          <span class="brand-mark">${icon(b.icon)}</span>
          <span style="min-width:0"><div class="brand-name">${UI.esc(b.name)}</div><div class="brand-sub">${UI.esc(b.tagline)}</div></span>
        </a>
        <div class="topbar-right">
          <div class="chain-pill" id="chain-pill" title="Connected blockchain"><span class="dot" id="chain-dot"></span><span id="chain-text">Connecting…</span></div>
          <div class="segmented" role="group" aria-label="Blockchain">
            <button type="button" data-mode="browser" title="Ethereum chain running inside this page - nothing to install">In-browser chain</button>
            <button type="button" data-mode="local" title="Hardhat node on http://127.0.0.1:8545">Local Hardhat</button>
          </div>
          ${
            opts.timeTravel
              ? `<div class="segmented" role="group" aria-label="Fast-forward chain time">
                   <button type="button" data-ff="300" title="Move blockchain time forward 5 minutes">${icon("forward")}<span style="margin-left:4px">+5 min</span></button>
                   <button type="button" data-ff="3600" title="Move blockchain time forward 1 hour">+1 h</button>
                 </div>`
              : ""
          }
          <label class="theme-switch" title="Switch between light and dark theme">
            <input type="checkbox" id="theme-toggle" role="switch" aria-label="Dark theme" />
            <span class="theme-track" aria-hidden="true"><span class="theme-thumb" id="theme-thumb"></span></span>
            <span class="theme-label" id="theme-label">Light</span>
          </label>
        </div>
      </header>
      <div class="shell">
        <aside class="sidebar">
          <nav class="nav" id="nav" aria-label="Main"></nav>
          <div class="sidebar-foot">
            <div id="foot-info">-</div>
            <button type="button" class="btn btn-secondary btn-sm" id="reset-btn" style="margin-top:10px;width:100%">${icon("reset")} Reset demo</button>
          </div>
        </aside>
        <main id="view"></main>
      </div>
      <div id="toasts" aria-live="polite"></div>`;

    let lastSection = null;
    $("#nav").innerHTML = opts.routes
      .map((r) => {
        const head = r.section && r.section !== lastSection ? `<div class="nav-section">${UI.esc(r.section)}</div>` : "";
        lastSection = r.section;
        return `${head}<a href="#/${r.id === "home" ? "" : r.id}" data-route="${r.id}">${icon(r.icon)}<span>${UI.esc(r.title)}</span></a>`;
      })
      .join("");

    document.querySelectorAll("[data-mode]").forEach((btn) =>
      btn.addEventListener("click", () => {
        if (btn.dataset.mode === Chain.mode) return;
        try {
          localStorage.setItem(`${opts.chain.storageKey}:mode`, JSON.stringify(btn.dataset.mode));
        } catch {}
        location.href = location.pathname + location.hash;
      })
    );
    document.querySelectorAll("[data-ff]").forEach((btn) =>
      btn.addEventListener("click", () => action(btn, async () => {
        await Chain.fastForward(Number(btn.dataset.ff));
        UI.toast(`Blockchain time moved forward ${UI.fmtDuration(Number(btn.dataset.ff))}`, "success", 2500);
      }))
    );
    $("#theme-toggle").addEventListener("change", (e) => setTheme(e.target.checked ? "dark" : "light"));
    // Follow the operating system's theme until the user picks one.
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
    $("#reset-btn").addEventListener("click", () => {
      const msg =
        Chain.mode === "browser"
          ? "Reset the demo? All papers, transactions and blocks in the in-browser chain will be deleted."
          : "Deploy a fresh contract on the local Hardhat node? The current contract's data will no longer be shown.";
      if (confirm(msg)) action($("#reset-btn"), () => Chain.reset());
    });
  }

  // ---------- theme ----------
  const themeKey = () => `${opts.chain.storageKey}:theme`;
  function currentTheme() {
    const t = document.documentElement.getAttribute("data-theme");
    if (t) return t;
    return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  function applyTheme() {
    let t = null;
    try {
      t = localStorage.getItem(themeKey());
    } catch {}
    UI.setDocTheme(t);
    const dark = currentTheme() === "dark";
    const toggle = $("#theme-toggle");
    if (toggle) toggle.checked = dark;
    const thumb = $("#theme-thumb");
    if (thumb) thumb.innerHTML = icon(dark ? "moon" : "sun");
    const label = $("#theme-label");
    if (label) label.textContent = dark ? "Dark" : "Light";
  }
  function setTheme(theme) {
    try {
      localStorage.setItem(themeKey(), theme);
    } catch {}
    applyTheme();
  }

  // ---------- status ----------
  function setModeButtons(mode) {
    document.querySelectorAll("[data-mode]").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  }

  async function updateChainInfo() {
    try {
      const n = await Chain.provider.getBlockNumber();
      $("#chain-dot").className = "dot dot-ok";
      $("#chain-text").innerHTML = `${Chain.mode === "browser" ? "In-browser chain" : "Local Hardhat"} · block #${n} · <span id="chain-clock" class="mono">${UI.fmtClock(Chain.now())}</span>`;
      $("#foot-info").innerHTML = `Contract<br><code title="${UI.esc(Chain.address)}">${UI.esc(UI.short(Chain.address, 4))}</code><br>Chain ID ${Chain.chainId}`;
    } catch {
      $("#chain-dot").className = "dot dot-bad";
      $("#chain-text").textContent = "Disconnected";
    }
  }

  function showLoading(text) {
    $("#view").innerHTML = `<div class="loading-screen"><div><span class="spinner"></span><p style="margin-top:12px">${UI.esc(text)}</p></div></div>`;
  }

  function showFatal(err, mode) {
    $("#chain-dot").className = "dot dot-bad";
    $("#chain-text").textContent = "Not connected";
    $("#view").innerHTML = `
      <div class="card" style="max-width:720px">
        <h2>Could not connect to the blockchain</h2>
        <p class="muted" style="margin-top:6px">${UI.esc(err.message)}</p>
        ${
          mode === "local"
            ? `<div class="callout" style="margin:12px 0">
                 <strong>Start the local blockchain:</strong>
                 <ol style="margin:6px 0 0 18px;padding:0">
                   <li>Open a terminal in the <code>blockchain</code> folder</li>
                   <li><code>npm install</code> (first time only)</li>
                   <li><code>npm run node</code> and keep it running</li>
                   <li>Optional: in a second terminal, <code>npm run deploy</code></li>
                   <li>Reload this page</li>
                 </ol>
               </div>`
            : ""
        }
        <div class="row"><button class="btn" id="retry-btn">Retry</button>
        ${mode === "local" ? `<button class="btn btn-secondary" id="use-browser">Use the in-browser chain instead</button>` : ""}</div>
      </div>`;
    $("#retry-btn").addEventListener("click", () => location.reload());
    const ub = $("#use-browser");
    if (ub)
      ub.addEventListener("click", () => {
        try {
          localStorage.setItem(`${opts.chain.storageKey}:mode`, JSON.stringify("browser"));
        } catch {}
        location.href = location.pathname + location.hash;
      });
  }

  // ---------- router / render ----------
  function currentRoute() {
    const id = (location.hash.replace(/^#\/?/, "").split("?")[0] || "home").trim();
    return opts.routes.find((r) => r.id === id) || opts.routes[0];
  }

  async function render() {
    const seq = ++renderSeq;
    const route = currentRoute();
    document.querySelectorAll("#nav a").forEach((a) => a.classList.toggle("active", a.dataset.route === route.id));
    document.title = `${route.title} · ${opts.brand.name}`;
    const el = $("#view");
    let data;
    try {
      data = await opts.load();
    } catch (e) {
      console.error(e);
      if (seq === renderSeq) el.innerHTML = `<div class="card callout-bad"><h2>Could not read the contract</h2><p>${UI.esc(e.message)}</p></div>`;
      return;
    }
    if (seq !== renderSeq) return;
    const sameRoute = lastRouteId === route.id;
    const scroll = window.scrollY;
    lastRouteId = route.id;
    try {
      await route.render(el, ctx(data));
    } catch (e) {
      console.error(e);
      el.innerHTML = `<div class="card callout-bad"><h2>Something went wrong</h2><p>${UI.esc(e.message)}</p></div>`;
    }
    if (sameRoute) window.scrollTo(0, scroll);
    else window.scrollTo(0, 0);
    updateChainInfo();
    tick();
  }

  /** Run an async user action: spinner on the button, errors as toasts, one re-render at the end. */
  async function action(button, fn) {
    busyDepth++;
    try {
      return await UI.busy(button, fn);
    } finally {
      busyDepth--;
      if (!busyDepth) await render();
    }
  }

  function ctx(data) {
    return { data, state, action, render, icon, go: (id) => (location.hash = `#/${id}`) };
  }

  // ---------- clock + countdowns ----------
  function tick() {
    const now = Chain.now();
    const clock = $("#chain-clock");
    if (clock) clock.textContent = UI.fmtClock(now);
    let crossed = false;
    document.querySelectorAll("[data-countdown]").forEach((el) => {
      const left = Number(el.dataset.countdown) - now;
      if (left > 0) el.textContent = UI.fmtDuration(left);
      else {
        el.textContent = el.dataset.doneText || "now";
        if (!el.dataset.fired) {
          el.dataset.fired = "1";
          crossed = true;
        }
      }
    });
    const typing = document.activeElement && document.activeElement.closest && document.activeElement.closest("form");
    if (crossed && !busyDepth && !typing) render();
  }

  async function start(o) {
    opts = o;
    buildChrome();
    applyTheme();
    const mode = Chain.getSavedMode(o.chain.storageKey);
    setModeButtons(mode);
    showLoading(mode === "browser" ? "Starting the in-browser Ethereum chain…" : "Connecting to the local Hardhat node…");
    try {
      await Chain.init(o.chain, mode);
    } catch (e) {
      console.error(e);
      showFatal(e, mode);
      return;
    }
    Chain.onChange(() => {
      if (!busyDepth) render();
    });
    window.addEventListener("hashchange", render);
    setInterval(tick, 1000);
    await render();
    window.APP_READY = true;
  }

  window.Shell = { start, icon, action, render, state };
})();
