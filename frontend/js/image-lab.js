/* Image Lab - built-in sample "photos" and the edits used by the Tamper Lab.
 * The sample photos are synthetic landscape scenes painted on a <canvas>, fully
 * deterministic from a seed and a caption (no downloaded or copyrighted images).
 */
(function () {
  const W = 640;
  const H = 400;

  // ---------------- deterministic randomness ----------------
  function hashString(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------------- painting helpers ----------------
  function vertical(ctx, y0, y1, stops) {
    const g = ctx.createLinearGradient(0, y0, 0, y1);
    stops.forEach((c, i) => g.addColorStop(i / (stops.length - 1), c));
    return g;
  }
  function glow(ctx, x, y, r, rgb, alpha) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${rgb},${alpha})`);
    g.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
  function disc(ctx, x, y, r, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  /** A ridge line (hills / mountains) filled down to the bottom of the image. */
  function ridge(ctx, rand, baseY, amp, fill, { step = 6, sharp = 0 } = {}) {
    const f = [0.004 + rand() * 0.004, 0.011 + rand() * 0.01, 0.03 + rand() * 0.02];
    const p = [rand() * 6.3, rand() * 6.3, rand() * 6.3];
    const pts = [];
    for (let x = -step; x <= W + step; x += step) {
      let y = 0.55 * Math.sin(x * f[0] + p[0]) + 0.3 * Math.sin(x * f[1] + p[1]) + 0.15 * Math.sin(x * f[2] + p[2]);
      if (sharp) y = 1 - Math.abs(y) * 2 * sharp + y * (1 - sharp);
      pts.push([x, baseY - amp * y]);
    }
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.moveTo(-step, H);
    pts.forEach(([x, y]) => ctx.lineTo(x, y));
    ctx.lineTo(W + step, H);
    ctx.closePath();
    ctx.fill();
    return pts;
  }
  function cloud(ctx, x, y, s, color) {
    ctx.fillStyle = color;
    [[0, 0, 1], [0.9, 0.15, 0.75], [-0.85, 0.2, 0.7], [0.35, -0.35, 0.7], [-0.3, -0.25, 0.6]].forEach(([dx, dy, r]) => {
      ctx.beginPath();
      ctx.ellipse(x + dx * s, y + dy * s * 0.6, r * s, r * s * 0.55, 0, 0, Math.PI * 2);
      ctx.fill();
    });
  }
  function buildings(ctx, rand, { baseY, count, minH, maxH, color, window: win, lit = 0.5, x0 = 0, x1 = W }) {
    let x = x0 - rand() * 20;
    for (let i = 0; i < count && x < x1; i++) {
      const bw = 26 + rand() * 46;
      const bh = minH + rand() * (maxH - minH);
      ctx.fillStyle = color;
      ctx.fillRect(x, baseY - bh, bw, bh + 1);
      if (rand() < 0.3) ctx.fillRect(x + bw * 0.4, baseY - bh - 12, 3, 12); // antenna
      if (win) {
        for (let wy = baseY - bh + 8; wy < baseY - 8; wy += 11) {
          for (let wx = x + 5; wx < x + bw - 7; wx += 9) {
            if (rand() < lit) {
              ctx.fillStyle = win;
              ctx.fillRect(wx, wy, 4, 5);
            }
          }
        }
      }
      x += bw + 2 + rand() * 8;
    }
  }
  function pine(ctx, x, baseY, h, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x, baseY - h);
    ctx.lineTo(x + h * 0.32, baseY);
    ctx.lineTo(x - h * 0.32, baseY);
    ctx.closePath();
    ctx.fill();
  }
  function roundTree(ctx, x, baseY, h, leaf, trunk) {
    ctx.fillStyle = trunk;
    ctx.fillRect(x - 2, baseY - h * 0.45, 4, h * 0.45);
    disc(ctx, x, baseY - h * 0.62, h * 0.32, leaf);
    disc(ctx, x - h * 0.18, baseY - h * 0.5, h * 0.22, leaf);
    disc(ctx, x + h * 0.2, baseY - h * 0.48, h * 0.22, leaf);
  }
  function water(ctx, rand, horizon, top, bottom, shimmer) {
    ctx.fillStyle = vertical(ctx, horizon, H, [top, bottom]);
    ctx.fillRect(0, horizon, W, H - horizon);
    ctx.fillStyle = shimmer;
    for (let i = 0; i < 70; i++) {
      const y = horizon + 4 + Math.pow(rand(), 1.6) * (H - horizon);
      const len = 10 + rand() * 50 * ((y - horizon) / (H - horizon) + 0.3);
      ctx.fillRect(rand() * W, y, len, 1.5);
    }
  }
  function reflection(ctx, rand, x, horizon, width, rgb) {
    for (let y = horizon + 2; y < H; y += 5) {
      const spread = width * (0.4 + (y - horizon) / (H - horizon));
      const a = 0.55 * (1 - (y - horizon) / (H - horizon)) + 0.1;
      ctx.fillStyle = `rgba(${rgb},${a.toFixed(3)})`;
      const off = (rand() - 0.5) * spread * 0.6;
      ctx.fillRect(x - spread / 2 + off, y, spread * (0.5 + rand() * 0.5), 2);
    }
  }
  function vignette(ctx) {
    const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, W * 0.62);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, "rgba(0,0,0,0.28)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  // ---------------- scenes ----------------
  const PAINTERS = {
    harbour(ctx, r) {
      const horizon = H * (0.56 + r() * 0.04);
      const sx = W * (0.22 + r() * 0.12);
      ctx.fillStyle = vertical(ctx, 0, horizon, ["#1f3b73", "#6f6fa8", "#f2a07b", "#ffd39a"]);
      ctx.fillRect(0, 0, W, horizon);
      glow(ctx, sx, horizon - 30, 260, "255,214,150", 0.75);
      disc(ctx, sx, horizon - 28, 26, "#fff2d0");
      for (let i = 0; i < 4; i++) cloud(ctx, W * (0.45 + r() * 0.5), 40 + r() * 90, 24 + r() * 22, "rgba(255,226,214,0.55)");
      ridge(ctx, r, horizon - 6, 26, "#5b4a6e", { step: 8 });
      ctx.fillStyle = "#4a3e63";
      ctx.beginPath();
      ctx.moveTo(W * 0.55, horizon);
      ctx.quadraticCurveTo(W * 0.78, horizon - 70, W, horizon - 55);
      ctx.lineTo(W, horizon);
      ctx.fill();
      water(ctx, r, horizon, "#c98f86", "#2c3e6b", "rgba(255,230,200,0.35)");
      reflection(ctx, r, sx, horizon, 70, "255,226,170");
      // pier
      ctx.fillStyle = "#231b2e";
      ctx.fillRect(0, horizon + 34, W * 0.3, 7);
      for (let x = 8; x < W * 0.3; x += 28) ctx.fillRect(x, horizon + 34, 4, 46);
      // boats
      for (let i = 0; i < 3; i++) {
        const bx = W * (0.45 + i * 0.16 + r() * 0.05);
        const by = horizon + 30 + i * 22;
        const s = 0.8 + i * 0.25;
        ctx.fillStyle = "#1e1a2b";
        ctx.beginPath();
        ctx.moveTo(bx - 34 * s, by);
        ctx.lineTo(bx + 34 * s, by);
        ctx.lineTo(bx + 24 * s, by + 10 * s);
        ctx.lineTo(bx - 26 * s, by + 10 * s);
        ctx.fill();
        ctx.fillRect(bx - 2, by - 40 * s, 3, 40 * s);
        ctx.beginPath();
        ctx.moveTo(bx + 2, by - 38 * s);
        ctx.lineTo(bx + 24 * s, by - 6);
        ctx.lineTo(bx + 2, by - 6);
        ctx.fill();
      }
    },

    skyline(ctx, r) {
      const ground = H * 0.7;
      const sx = W * (0.7 + r() * 0.12);
      ctx.fillStyle = vertical(ctx, 0, ground, ["#2a1b4a", "#7a3b78", "#e46f6a", "#ffb36b"]);
      ctx.fillRect(0, 0, W, ground);
      glow(ctx, sx, ground - 40, 240, "255,170,110", 0.7);
      disc(ctx, sx, ground - 46, 30, "#ffd9a0");
      for (let i = 0; i < 3; i++) cloud(ctx, W * (0.1 + r() * 0.5), 50 + r() * 60, 20 + r() * 20, "rgba(255,170,190,0.35)");
      buildings(ctx, r, { baseY: ground, count: 22, minH: 60, maxH: 150, color: "#5d3d74" });
      buildings(ctx, r, { baseY: ground, count: 16, minH: 40, maxH: 200, color: "#24173a", window: "#ffd27a", lit: 0.35, x1: W * 0.62 });
      buildings(ctx, r, { baseY: ground, count: 6, minH: 30, maxH: 90, color: "#24173a", window: "#ffd27a", lit: 0.3, x0: W * 0.88 });
      water(ctx, r, ground, "#4a2c5c", "#140e24", "rgba(255,200,140,0.3)");
      reflection(ctx, r, sx, ground, 60, "255,190,120");
      ctx.fillStyle = "#0f0a1a";
      ctx.fillRect(0, ground - 2, W, 4);
    },

    campus(ctx, r) {
      const horizon = H * 0.6;
      ctx.fillStyle = vertical(ctx, 0, horizon, ["#3f86c9", "#86bde6", "#d9eef8"]);
      ctx.fillRect(0, 0, W, horizon);
      const sx = W * (0.12 + r() * 0.1);
      glow(ctx, sx, 60, 200, "255,250,220", 0.8);
      disc(ctx, sx, 60, 22, "#fffbe8");
      for (let i = 0; i < 5; i++) cloud(ctx, W * (0.3 + r() * 0.7), 40 + r() * 100, 18 + r() * 26, "rgba(255,255,255,0.85)");
      ridge(ctx, r, horizon - 30, 30, "#7fa86a");
      ridge(ctx, r, horizon + 10, 18, "#5f9a4c");
      // clock tower
      const tx = W * (0.56 + r() * 0.08);
      const top = horizon - 170;
      ctx.fillStyle = "#b8a184";
      ctx.fillRect(tx - 26, top, 52, 190);
      ctx.fillStyle = "#8d7556";
      ctx.beginPath();
      ctx.moveTo(tx - 34, top);
      ctx.lineTo(tx, top - 60);
      ctx.lineTo(tx + 34, top);
      ctx.fill();
      disc(ctx, tx, top + 34, 17, "#f4efe4");
      ctx.strokeStyle = "#3b2f22";
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(tx, top + 34);
      ctx.lineTo(tx, top + 22);
      ctx.moveTo(tx, top + 34);
      ctx.lineTo(tx + 9, top + 38);
      ctx.stroke();
      ctx.fillStyle = "#6e5a40";
      for (let i = 0; i < 3; i++) ctx.fillRect(tx - 16 + i * 13, top + 70, 7, 22);
      // halls either side
      ctx.fillStyle = "#c9b597";
      ctx.fillRect(tx - 170, horizon - 60, 140, 80);
      ctx.fillRect(tx + 30, horizon - 50, 150, 70);
      ctx.fillStyle = "#7c654a";
      for (let i = 0; i < 6; i++) ctx.fillRect(tx - 160 + i * 22, horizon - 44, 10, 16);
      for (let i = 0; i < 6; i++) ctx.fillRect(tx + 42 + i * 23, horizon - 36, 10, 16);
      // lawn and path
      ctx.fillStyle = vertical(ctx, horizon + 20, H, ["#6fb34f", "#3f8a33"]);
      ctx.fillRect(0, horizon + 20, W, H - horizon - 20);
      ctx.fillStyle = "#e3d6bb";
      ctx.beginPath();
      ctx.moveTo(tx - 10, horizon + 20);
      ctx.lineTo(tx + 10, horizon + 20);
      ctx.lineTo(tx + 120, H);
      ctx.lineTo(tx - 60, H);
      ctx.fill();
      for (let i = 0; i < 7; i++) roundTree(ctx, W * (0.04 + i * 0.14 + r() * 0.04), horizon + 40 + r() * 50, 60 + r() * 40, i % 2 ? "#2f7a3a" : "#3c8f43", "#5a4130");
    },

    mountains(ctx, r) {
      ctx.fillStyle = vertical(ctx, 0, H * 0.6, ["#1d5fa8", "#5aa2dc", "#cfe7f7"]);
      ctx.fillRect(0, 0, W, H);
      const sx = W * (0.8 + r() * 0.1);
      glow(ctx, sx, 50, 180, "255,255,240", 0.6);
      disc(ctx, sx, 50, 18, "#fffdf2");
      // two ranges of peaks, each with a snow cap above a wavy snow line
      [[H * 0.4, 95, "#7d90aa", 0.8], [H * 0.52, 105, "#56697f", 0.9]].forEach(([base, amp, rock, sharp], k) => {
        const peaks = ridge(ctx, r, base, amp, rock, { step: 5, sharp });
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(-5, H);
        peaks.forEach(([x, y]) => ctx.lineTo(x, y));
        ctx.lineTo(W + 5, H);
        ctx.closePath();
        ctx.clip();
        ctx.fillStyle = k ? "#f4f8fc" : "#e3ecf6";
        ctx.beginPath();
        ctx.moveTo(0, 0);
        for (let x = 0; x <= W; x += 10) ctx.lineTo(x, base - amp * 0.25 + Math.sin(x * 0.05 + k) * 8 + (r() - 0.5) * 10);
        ctx.lineTo(W, 0);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      });
      ridge(ctx, r, H * 0.7, 40, "#e9f0f7");
      for (let i = 0; i < 26; i++) pine(ctx, r() * W, H * (0.66 + r() * 0.3), 30 + r() * 50, i % 3 ? "#1f3d33" : "#2a4f40");
      // road
      ctx.strokeStyle = "#4a4f57";
      ctx.lineWidth = 16;
      ctx.beginPath();
      ctx.moveTo(W * 0.3, H + 10);
      ctx.bezierCurveTo(W * 0.5, H * 0.85, W * 0.2, H * 0.75, W * 0.55, H * 0.66);
      ctx.stroke();
      ctx.strokeStyle = "#f5d76e";
      ctx.lineWidth = 2;
      ctx.setLineDash([10, 10]);
      ctx.stroke();
      ctx.setLineDash([]);
    },

    solar(ctx, r) {
      const horizon = H * 0.5;
      ctx.fillStyle = vertical(ctx, 0, horizon, ["#4f9fd6", "#a9d4ef", "#f3ecd2"]);
      ctx.fillRect(0, 0, W, horizon);
      const sx = W * (0.75 + r() * 0.15);
      glow(ctx, sx, 70, 230, "255,244,200", 0.85);
      disc(ctx, sx, 70, 24, "#fffbe0");
      for (let i = 0; i < 3; i++) cloud(ctx, W * (0.05 + r() * 0.5), 50 + r() * 70, 20 + r() * 18, "rgba(255,255,255,0.8)");
      ridge(ctx, r, horizon - 20, 40, "#8aa37a");
      ridge(ctx, r, horizon + 5, 20, "#a7b86d");
      ctx.fillStyle = vertical(ctx, horizon + 20, H, ["#c7c46a", "#8c9a3e"]);
      ctx.fillRect(0, horizon + 20, W, H - horizon - 20);
      // houses on the left
      for (let i = 0; i < 4; i++) {
        const hx = 30 + i * 46 + r() * 10;
        const hy = horizon + 16 + r() * 10;
        ctx.fillStyle = "#e8dcc4";
        ctx.fillRect(hx, hy - 20, 34, 20);
        ctx.fillStyle = "#a6442e";
        ctx.beginPath();
        ctx.moveTo(hx - 4, hy - 20);
        ctx.lineTo(hx + 17, hy - 34);
        ctx.lineTo(hx + 38, hy - 20);
        ctx.fill();
      }
      // rows of panels (perspective)
      for (let row = 0; row < 6; row++) {
        const y = horizon + 50 + row * row * 6 + row * 18;
        const ph = 8 + row * 4;
        const startX = W * 0.3 - row * 30;
        for (let x = startX; x < W + 40; x += 34 + row * 10) {
          const pw = 28 + row * 9;
          ctx.fillStyle = "#1c3557";
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x + pw, y);
          ctx.lineTo(x + pw - 6, y - ph);
          ctx.lineTo(x + 6, y - ph);
          ctx.fill();
          ctx.fillStyle = "rgba(160,200,255,0.35)";
          ctx.fillRect(x + 8, y - ph + 2, pw - 16, 2);
        }
      }
    },

    night(ctx, r) {
      const ground = H * 0.66;
      ctx.fillStyle = vertical(ctx, 0, ground, ["#070b1f", "#1b1f47", "#3d2c5c"]);
      ctx.fillRect(0, 0, W, ground);
      for (let i = 0; i < 90; i++) disc(ctx, r() * W, r() * ground * 0.6, r() * 1.3 + 0.3, "rgba(255,255,255,0.8)");
      const mx = W * (0.78 + r() * 0.1);
      glow(ctx, mx, 70, 150, "200,210,255", 0.5);
      disc(ctx, mx, 70, 22, "#f2f0e6");
      buildings(ctx, r, { baseY: ground, count: 20, minH: 50, maxH: 140, color: "#120f26", window: "#ffcf73", lit: 0.25 });
      ctx.fillStyle = vertical(ctx, ground, H, ["#2b2236", "#14101c"]);
      ctx.fillRect(0, ground, W, H - ground);
      // stalls
      for (let i = 0; i < 6; i++) {
        const x = 20 + i * 106 + r() * 10;
        glow(ctx, x + 40, ground + 30, 90, "255,170,80", 0.35);
        ctx.fillStyle = ["#b23a48", "#2f6f8f", "#c78a2c"][i % 3];
        ctx.beginPath();
        ctx.moveTo(x - 6, ground + 10);
        ctx.lineTo(x + 40, ground - 14);
        ctx.lineTo(x + 86, ground + 10);
        ctx.fill();
        ctx.fillStyle = "#ffdd99";
        ctx.fillRect(x + 4, ground + 10, 72, 30);
        ctx.fillStyle = "#3a2a1c";
        ctx.fillRect(x, ground + 40, 80, 8);
      }
      // lantern strings
      for (let s = 0; s < 2; s++) {
        const y0 = ground - 70 - s * 40;
        for (let i = 0; i <= 24; i++) {
          const t = i / 24;
          const x = t * W;
          const y = y0 + Math.sin(t * Math.PI * 3) * 14 + 22 * Math.sin(t * Math.PI);
          glow(ctx, x, y, 14, "255,190,90", 0.45);
          disc(ctx, x, y, 4, ["#ff6b5b", "#ffd166", "#7bd389"][i % 3]);
        }
      }
    },

    storm(ctx, r) {
      const ground = H * 0.6;
      ctx.fillStyle = vertical(ctx, 0, ground, ["#2b2f36", "#555c66", "#8b8f8f"]);
      ctx.fillRect(0, 0, W, ground);
      for (let i = 0; i < 6; i++) cloud(ctx, r() * W, 30 + r() * 80, 40 + r() * 30, "rgba(40,44,52,0.7)");
      // lightning
      ctx.strokeStyle = "#f4f1ff";
      ctx.lineWidth = 3;
      ctx.beginPath();
      let lx = W * (0.15 + r() * 0.2);
      let ly = 20;
      ctx.moveTo(lx, ly);
      while (ly < ground - 60) {
        lx += (r() - 0.5) * 40;
        ly += 18 + r() * 20;
        ctx.lineTo(lx, ly);
      }
      ctx.stroke();
      glow(ctx, lx, ly, 120, "220,220,255", 0.35);
      buildings(ctx, r, { baseY: ground, count: 14, minH: 70, maxH: 190, color: "#3a3f47", window: "#c9c38a", lit: 0.15, x0: W * 0.35 });
      // flood water
      water(ctx, r, ground, "#6b6a5c", "#3b3a30", "rgba(220,220,200,0.35)");
      ctx.fillStyle = "#c33";
      ctx.fillRect(W * 0.2, ground + 30, 60, 22); // half-submerged car
      ctx.fillStyle = "rgba(60,58,48,0.8)";
      ctx.fillRect(W * 0.18, ground + 44, 90, 12);
    },
  };

  /** The built-in sample photos. Seeds come from the id and caption, so every browser paints the same scene. */
  const SCENES = [
    { id: "harbour", title: "Harbour at sunrise", caption: "Fishing boats return to the east harbour as the sun rises over the breakwater." },
    { id: "skyline", title: "City skyline at dusk", caption: "Office towers light up along the river at the end of the working day." },
    { id: "campus", title: "Clock tower on a spring morning", caption: "Students cross the main lawn below the old clock tower on the first day of term." },
    { id: "mountains", title: "Mountain pass after snowfall", caption: "Snow ploughs reopen the mountain pass after an overnight storm." },
    { id: "solar", title: "Solar farm in the valley", caption: "A new solar farm begins supplying power to three nearby villages." },
    { id: "night", title: "Night market lights", caption: "Food stalls and lanterns fill the old town square on festival night." },
  ];

  function paintScene(kind, seedText) {
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    PAINTERS[kind](ctx, mulberry32(hashString(seedText)));
    vignette(ctx);
    return canvas;
  }

  // ---------------- encoding / decoding ----------------
  function canvasBytes(canvas, type = "image/jpeg", quality = 0.92) {
    return new Promise((resolve, reject) =>
      canvas.toBlob(
        async (blob) => (blob ? resolve(new Uint8Array(await blob.arrayBuffer())) : reject(new Error("Could not encode the image"))),
        type,
        quality
      )
    );
  }

  /** Decode file bytes into a bitmap. Throws a friendly error for files that are not images. */
  async function decode(bytes, type) {
    try {
      return await createImageBitmap(new Blob([bytes], { type: type || "image/jpeg" }));
    } catch {
      throw new Error("This file could not be read as an image (use PNG, JPEG, WebP or GIF).");
    }
  }

  function toCanvas(source, w = source.width, h = source.height) {
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    const ctx = c.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, c.width, c.height);
    return c;
  }

  /** Small JPEG preview kept off-chain (max 360 px wide) for side-by-side comparisons. */
  function thumbnail(source, max = 360) {
    const s = Math.min(1, max / Math.max(source.width, source.height));
    return toCanvas(source, source.width * s, source.height * s).toDataURL("image/jpeg", 0.8);
  }

  /** Render a sample scene to JPEG file bytes (the "original photo file"). */
  async function sceneFile(scene) {
    const bytes = await canvasBytes(paintScene(scene.id, scene.id + "|" + scene.caption), "image/jpeg", 0.92);
    return { bytes, type: "image/jpeg", name: `${scene.id}.jpg` };
  }

  // ---------------- Tamper Lab edits ----------------
  const EDITS = [
    { id: "none", label: "No edit", hint: "The untouched original file, byte for byte." },
    { id: "social", label: "Social-media copy", hint: "Resized to 50% and re-saved as JPEG quality 60%, like a messaging app does." },
    { id: "crop", label: "Trim edges", hint: "3% cut away from every side (bigger crops can defeat dHash)." },
    { id: "tone", label: "Brightness / contrast", hint: "Brighter by 20% with 25% more contrast." },
    { id: "banner", label: "Fake BREAKING banner", hint: "A red news banner with a false headline across the bottom." },
    { id: "jpeg", label: "Heavy JPEG", hint: "Re-saved at JPEG quality 5%: blocky, but still the same picture." },
    { id: "flip", label: "Mirror flip", hint: "Flipped left to right." },
    { id: "different", label: "Different image", hint: "A fabricated scene (a staged flood) passed off with the same caption." },
  ];

  /** Apply an edit to a decoded image. Returns new file bytes. */
  async function applyEdit(editId, bitmap, original) {
    const w = bitmap.width;
    const h = bitmap.height;
    let c;
    switch (editId) {
      case "none":
        return { bytes: original.bytes, type: original.type };
      case "social":
        return { bytes: await canvasBytes(toCanvas(bitmap, w / 2, h / 2), "image/jpeg", 0.6), type: "image/jpeg" };
      case "crop": {
        const dx = Math.round(w * 0.03);
        const dy = Math.round(h * 0.03);
        c = document.createElement("canvas");
        c.width = w - 2 * dx;
        c.height = h - 2 * dy;
        c.getContext("2d").drawImage(bitmap, dx, dy, c.width, c.height, 0, 0, c.width, c.height);
        break;
      }
      case "tone": {
        c = toCanvas(bitmap);
        const ctx = c.getContext("2d");
        const img = ctx.getImageData(0, 0, w, h);
        const d = img.data;
        for (let i = 0; i < d.length; i += 4) {
          for (let k = 0; k < 3; k++) d[i + k] = Math.max(0, Math.min(255, ((d[i + k] - 128) * 1.25 + 128) * 1.2));
        }
        ctx.putImageData(img, 0, 0);
        break;
      }
      case "banner": {
        c = toCanvas(bitmap);
        const ctx = c.getContext("2d");
        const bh = Math.round(h * 0.17);
        ctx.fillStyle = "#c8161d";
        ctx.fillRect(0, h - bh, w, bh);
        ctx.fillStyle = "#ffffff";
        const tag = Math.round(bh * 0.62);
        ctx.fillRect(Math.round(w * 0.025), h - bh + Math.round(bh * 0.19), Math.round(tag * 4.4), tag);
        ctx.fillStyle = "#c8161d";
        ctx.font = `800 ${Math.round(tag * 0.62)}px Arial, sans-serif`;
        ctx.textBaseline = "middle";
        ctx.fillText("BREAKING", Math.round(w * 0.025) + tag * 0.3, h - bh / 2);
        ctx.fillStyle = "#ffffff";
        ctx.font = `700 ${Math.round(bh * 0.3)}px Arial, sans-serif`;
        ctx.fillText("Officials hide the truth about this scene", Math.round(w * 0.04) + tag * 4.6, h - bh / 2, w * 0.58);
        break;
      }
      case "jpeg":
        return { bytes: await canvasBytes(toCanvas(bitmap), "image/jpeg", 0.05), type: "image/jpeg" };
      case "flip": {
        c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const ctx = c.getContext("2d");
        ctx.translate(w, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(bitmap, 0, 0);
        break;
      }
      case "different":
        c = toCanvas(paintScene("storm", "storm|" + (original.caption || "")), w, h);
        break;
      default:
        throw new Error("Unknown edit " + editId);
    }
    return { bytes: await canvasBytes(c, "image/jpeg", 0.92), type: "image/jpeg" };
  }

  window.ImageLab = { SCENES, EDITS, W, H, paintScene, sceneFile, canvasBytes, decode, toCanvas, thumbnail, applyEdit, hashString };
})();
