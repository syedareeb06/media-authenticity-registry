/* TrueFrame - Deepfake-Proof Media Authenticity Registry (web app) */
(function () {
  const ROLE = { None: 0, Publisher: 1, FactChecker: 2 };

  // Demo consortium: account 0 is the Press Council (contract deployer).
  const CONSORTIUM = [
    [1, "registerPublisher", "The Daily Ledger"],
    [2, "registerPublisher", "Metro News Network"],
    [3, "registerPublisher", "Campus Times"],
    [4, "registerFactChecker", "Northbridge Fact-Check Desk"],
  ];
  // Each demo publisher's "own" built-in sample photo.
  const PREFERRED_SCENE = { "The Daily Ledger": "harbour", "Metro News Network": "skyline", "Campus Times": "campus" };

  const THRESHOLD = 10; // max Hamming distance (out of 64 bits) to count as "the same picture"
  const MAX_UPLOAD = 5 * 1024 * 1024;
  const MAX_STORED_ORIGINAL = 400 * 1024; // larger originals keep only their thumbnail in this browser

  const ERRORS = {
    NotPressCouncil: () => "only the Press Council (account 0) can do this.",
    InvalidMember: () => "invalid member details.",
    AlreadyMember: () => "this account is already a member of the consortium.",
    NotActivePublisher: () => "this account is not an active publisher (it may have been suspended by the Press Council).",
    NotActiveFactChecker: () => "this account is not an active fact-checker.",
    InvalidMedia: () => "a title and an image hash are required.",
    CaptureTimeInFuture: (at, now) => `the capture time ${UI.fmtTime(at)} is later than the current block time ${UI.fmtTime(now)}.`,
    DuplicateMedia: (id) => `this exact image is already registered as record #${id}.`,
    InvalidSignatureLength: (n) => `a signature must be 65 bytes long, this one has ${n}.`,
    InvalidSignatureV: (v) => `invalid signature recovery id (v = ${v}).`,
    MalleableSignature: () => "malleable signature (high s value) rejected.",
    InvalidSignature: () => "the signature is not valid.",
    SignerMismatch: (rec, sender) =>
      `ecrecover says this signature belongs to ${Chain.label(rec)}, not to the sender ${Chain.label(sender)}. Only a publisher's own private key can register its photos.`,
    UnknownMedia: (id) => `record #${id} does not exist.`,
    NotMediaPublisher: (id) => `only the publisher that registered #${id} can revoke it.`,
    AlreadyRevoked: (id) => `record #${id} has already been revoked.`,
    AlreadyFlagged: (id) => `record #${id} is already disputed.`,
    ReasonRequired: () => "please give a reason.",
  };

  const lower = (a) => (a || "").toLowerCase();
  const sameAddr = (a, b) => lower(a) === lower(b);
  const council = () => Chain.accounts[0];
  const TF = () => window.TrueFrameCrypto;

  // ------------------------------------------------------------------
  // Data
  // ------------------------------------------------------------------
  async function load() {
    const c = Chain.contract;
    const [accts, infos] = await c.getMembers();
    const members = accts.map((a, i) => ({ address: a, role: Number(infos[i].role), name: infos[i].name, active: infos[i].active }));
    Chain.setName(council(), "Press Council");
    members.forEach((m) => Chain.setName(m.address, m.name));

    const count = Number(await c.mediaCount());
    const media = await Promise.all(
      Array.from({ length: count }, (_, id) =>
        c.getMedia(id).then((m) => ({
          id,
          sha3Hash: m.sha3Hash,
          pHash: m.pHash,
          publisher: m.publisher,
          capturedAt: Number(m.capturedAt),
          registeredAt: Number(m.registeredAt),
          revoked: m.revoked,
          flagged: m.flagged,
          flaggedBy: m.flaggedBy,
          title: m.title,
          caption: m.caption,
          revokeReason: m.revokeReason,
          flagReason: m.flagReason,
          signature: m.signature,
        }))
      )
    );
    return {
      members,
      media,
      publishers: members.filter((m) => m.role === ROLE.Publisher),
      factCheckers: members.filter((m) => m.role === ROLE.FactChecker),
    };
  }
  const memberOf = (data, addr) => data.members.find((m) => sameAddr(m.address, addr));

  // Off-chain storage (simulates each publisher's website / image server).
  const thumbs = () => Chain.store.get("thumbs", {}); // sha3 -> small JPEG data URL
  const originals = () => Chain.store.get("originals", {}); // sha3 -> { b64, type, name }
  const sceneIndex = () => Chain.store.get("scenes", {}); // sample scene id -> sha3
  function putOff(key, k, v) {
    const all = Chain.store.get(key, {});
    all[k] = v;
    Chain.store.set(key, all);
  }
  function storedOriginal(m) {
    const o = originals()[m.sha3Hash];
    return o ? { bytes: UI.base64ToBytes(o.b64), type: o.type, name: o.name } : null;
  }
  function dataUrlFile(url, name) {
    const [head, b64] = url.split(",");
    return { bytes: UI.base64ToBytes(b64), type: head.slice(5).split(";")[0], name };
  }

  const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`);
  const pad = (n) => String(n).padStart(2, "0");
  const toLocalInput = (ts) => {
    const d = new Date(ts * 1000);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const fromLocalInput = (v) => Math.floor(new Date(v).getTime() / 1000);
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "image";

  // ------------------------------------------------------------------
  // Images
  // ------------------------------------------------------------------
  /** Decode the file and compute both fingerprints. */
  async function analyse(file) {
    const bitmap = await ImageLab.decode(file.bytes, file.type);
    return {
      ...file,
      bitmap,
      width: bitmap.width,
      height: bitmap.height,
      sha3: TF().sha3(file.bytes),
      pHash: TF().dHash(bitmap),
    };
  }
  const objectUrl = (file) => file.url || (file.url = URL.createObjectURL(new Blob([file.bytes], { type: file.type })));

  const sceneCache = {};
  const sampleFile = (scene) =>
    (sceneCache[scene.id] = sceneCache[scene.id] || ImageLab.sceneFile(scene).then((f) => ({ ...f, scene: scene.id })));

  /** Which built-in scenes are already on the chain (by stored index, confirmed on-chain). */
  function registeredScenes(data) {
    const idx = sceneIndex();
    const onChain = new Set(data.media.map((m) => m.sha3Hash));
    return new Set(Object.keys(idx).filter((k) => onChain.has(idx[k])));
  }
  function defaultScene(publisherName, data, taken = new Set()) {
    const used = new Set([...registeredScenes(data), ...taken]);
    const preferred = PREFERRED_SCENE[publisherName];
    const others = new Set(Object.values(PREFERRED_SCENE));
    const order = [
      ...ImageLab.SCENES.filter((s) => s.id === preferred),
      ...ImageLab.SCENES.filter((s) => !others.has(s.id)),
      ...ImageLab.SCENES.filter((s) => others.has(s.id) && s.id !== preferred),
    ];
    return order.find((s) => !used.has(s.id)) || null;
  }

  /** Validate a file chosen in an <input type=file>. Returns null (with a toast) if unusable. */
  async function readImageInput(input) {
    const f = input.files && input.files[0];
    if (!f) return null;
    if (f.size > MAX_UPLOAD) {
      UI.toast(`"${f.name}" is ${fmtBytes(f.size)}. The limit is 5 MB.`, "error");
      return null;
    }
    if (!/^image\//.test(f.type)) {
      UI.toast(`"${f.name}" is not an image file.`, "error");
      return null;
    }
    return { bytes: await UI.readFileBytes(f), type: f.type, name: f.name };
  }

  function keepOffChain(item, sceneId) {
    putOff("thumbs", item.sha3, ImageLab.thumbnail(item.bitmap));
    let kept = "thumbnail";
    if (item.bytes.length <= MAX_STORED_ORIGINAL) {
      putOff("originals", item.sha3, { b64: UI.bytesToBase64(item.bytes), type: item.type, name: item.name });
      kept = "thumbnail and original file";
    }
    if (sceneId) putOff("scenes", sceneId, item.sha3);
    return kept;
  }

  // ------------------------------------------------------------------
  // Core actions
  // ------------------------------------------------------------------
  function nearest(pHash, pHashes) {
    return pHashes
      .map((h, id) => ({ id, d: TF().hamming(pHash, h) }))
      .sort((a, b) => a.d - b.d || a.id - b.id);
  }

  /** Publisher registers an original image: SHA3 -> dHash -> ECDSA signature -> transaction. */
  async function registerMedia(publisher, file, { title, caption, capturedAt }) {
    const s = Shell.state;
    let item, sig, result, id;
    const host = document.getElementById("reg-steps");
    const run = await UI.runSteps(host, [
      {
        title: "Fingerprint 1: SHA3-256 of the exact file bytes",
        run: async () => {
          item = await analyse(file);
          return `${item.sha3} · ${fmtBytes(item.bytes.length)}, ${item.width} × ${item.height} px`;
        },
      },
      {
        title: "Fingerprint 2: perceptual hash (dHash, 64 bits)",
        run: async () => {
          const near = nearest(item.pHash, [...(await Chain.contract.getAllPHashes())]).filter((n) => n.d <= THRESHOLD);
          return `${item.pHash} · ${
            near.length ? `warning: looks like record #${near[0].id} (distance ${near[0].d}/64)` : "no similar picture is registered yet"
          }`;
        },
      },
      {
        title: `Sign both hashes with ${Chain.label(publisher)}'s private key (ECDSA, secp256k1)`,
        run: async () => {
          sig = await TF().sign(publisher, item.sha3, item.pHash);
          const who = TF().recover(item.sha3, item.pHash, sig);
          if (!sameAddr(who, publisher)) throw new Error("Local signature check failed");
          return `${UI.short(sig, 10)} · checked locally: signer is ${Chain.label(who)}`;
        },
      },
      {
        title: "Send registerMedia: the contract re-checks the signature with ecrecover",
        run: async () => {
          result = await Chain.send(publisher, "registerMedia", [item.sha3, item.pHash, title, caption, capturedAt, sig]);
          id = Number(result.events.find((e) => e.name === "MediaRegistered").args.id);
          return `Record #${id} · block #${result.block.number} · tx ${UI.short(result.receipt.hash, 6)}`;
        },
      },
      {
        title: "Keep a thumbnail off-chain for side-by-side checks",
        run: async () => `${keepOffChain(item, file.scene)} kept in this browser. Only hashes, text and the signature are on-chain.`,
      },
    ]);
    s.regResult = { publisher, items: run.items };
    if (!run.ok) throw run.error;
    UI.toast(`"${title}" registered as record #${id} by ${Chain.label(publisher)}`, "success");
    return id;
  }

  /** Same as registerMedia without the step-by-step display (used for the sample photos). */
  async function quickRegister(publisher, file, meta) {
    const item = await analyse(file);
    const sig = await TF().sign(publisher, item.sha3, item.pHash);
    const r = await Chain.send(publisher, "registerMedia", [item.sha3, item.pHash, meta.title, meta.caption, meta.capturedAt, sig]);
    keepOffChain(item, file.scene);
    return Number(r.events.find((e) => e.name === "MediaRegistered").args.id);
  }

  /** Every active publisher registers one built-in sample photo. */
  async function registerSamples() {
    const data = await load();
    const taken = new Set();
    const done = [];
    let i = 0;
    for (const p of data.publishers.filter((x) => x.active)) {
      const scene = defaultScene(p.name, data, taken);
      if (!scene) break;
      taken.add(scene.id);
      const file = await sampleFile(scene);
      done.push(
        await quickRegister(p.address, file, { title: scene.title, caption: scene.caption, capturedAt: Chain.now() - (40 + 25 * i++) * 60 })
      );
    }
    if (!done.length) UI.toast("All built-in sample photos are already registered.", "info");
    else UI.toast(`${done.length} sample photo(s) registered: ${done.map((d) => "#" + d).join(", ")}`, "success");
    return done;
  }

  /** Public verification: read-only calls only, no account or transaction needed. */
  async function verifyImage(file) {
    const s = Shell.state;
    const data = await load();
    const c = Chain.contract;
    // Decide which checks apply (cheap), then run them one by one on screen.
    const item = await analyse(file);
    const [isExact, exactIdBig] = await c.findBySha3(item.sha3);
    const ranking = nearest(item.pHash, [...(await c.getAllPHashes())]);
    const exact = isExact ? data.media[Number(exactIdBig)] : null;
    const near = !exact && ranking.length && ranking[0].d <= THRESHOLD ? data.media[ranking[0].id] : null;
    const match = exact || near;
    let signer = null;

    const steps = [
      {
        title: "Read the image in your browser (nothing is uploaded)",
        run: async () => `${item.width} × ${item.height} px · ${fmtBytes(item.bytes.length)} · ${item.type}`,
      },
      { title: "Compute SHA3-256 of the exact file bytes", run: async () => TF().sha3(item.bytes) },
      {
        title: "Look up the exact hash on the blockchain (findBySha3)",
        run: async () => {
          const [f, id] = await c.findBySha3(item.sha3);
          return f ? `Exact match: record #${id} "${data.media[Number(id)].title}"` : "No exact match. Any change to the file, even a re-save, changes the SHA-3 hash.";
        },
      },
    ];
    if (!exact) {
      steps.push(
        { title: "Compute the perceptual hash (dHash, 64 bits)", run: async () => TF().dHash(item.bitmap) },
        {
          title: `Compare with every registered fingerprint (getAllPHashes), threshold ≤ ${THRESHOLD} bits`,
          run: async () =>
            ranking.length
              ? `Closest: record #${ranking[0].id} at Hamming distance ${ranking[0].d}/64 ${ranking[0].d <= THRESHOLD ? "→ same picture, edited" : "→ too different"}`
              : "The registry is empty.",
        }
      );
    }
    if (match) {
      steps.push({
        title: `Check the publisher's ECDSA signature on record #${match.id} (ecrecover)`,
        run: async () => {
          const local = TF().recover(match.sha3Hash, match.pHash, match.signature);
          const onChain = await c.recoverSigner(match.sha3Hash, match.pHash, match.signature);
          if (!sameAddr(local, onChain) || !sameAddr(onChain, match.publisher)) throw new Error("Signature does not belong to the publisher");
          const pub = memberOf(data, onChain);
          if (!pub || pub.role !== ROLE.Publisher) throw new Error("Signer is not a registered publisher");
          signer = pub;
          return `Signed by ${pub.name} (${UI.short(onChain, 4)}) · local and on-chain ecrecover agree`;
        },
      });
    }

    s.verify = null;
    const run = await UI.runSteps(document.getElementById("verify-steps"), steps);
    let verdict;
    if (!run.ok) verdict = "unverified";
    else if (exact) verdict = exact.revoked ? "revoked" : "original";
    else if (near) verdict = "edited";
    else verdict = "unverified";
    s.verify = {
      items: run.items,
      verdict,
      matchId: match ? match.id : null,
      distance: match ? TF().hamming(item.pHash, match.pHash) : null,
      ranking: ranking.slice(0, 3),
      signer: signer ? signer.address : null,
      failed: !run.ok,
      scroll: true,
      candidate: { url: objectUrl(file), name: file.name, origin: file.origin, width: item.width, height: item.height, size: item.bytes.length, sha3: item.sha3, pHash: item.pHash },
    };
    return s.verify;
  }

  /** Apply a Tamper Lab edit to a registered image. */
  async function tamper(mediaId, editId) {
    const data = await load();
    const m = data.media[mediaId];
    if (!m) throw new Error(`Record #${mediaId} does not exist`);
    let file = storedOriginal(m);
    let fromThumb = false;
    if (!file) {
      const t = thumbs()[m.sha3Hash];
      if (!t) throw new Error("This image is not stored in this browser.");
      file = dataUrlFile(t, `${slug(m.title)}-thumbnail.jpg`);
      fromThumb = true;
    }
    const original = await analyse(file);
    const editedFile = await ImageLab.applyEdit(editId, original.bitmap, { ...file, caption: m.caption });
    const edited = await analyse({ ...editedFile, name: editId === "none" ? file.name : `${slug(m.title)}-${editId}.jpg` });
    objectUrl(original);
    objectUrl(edited);
    return {
      mediaId,
      editId,
      fromThumb,
      original,
      edited,
      exact: edited.sha3 === m.sha3Hash,
      distance: TF().hamming(m.pHash, edited.pHash),
    };
  }

  const expectedVerdict = (r) => (r.exact ? "original" : r.distance <= THRESHOLD ? "edited" : "unverified");

  async function revoke(publisher, id, reason) {
    await Chain.send(publisher, "revokeMedia", [id, reason]);
    UI.toast(`Record #${id} revoked. Verifiers will now see a warning.`, "success");
  }

  async function flag(checker, id, reason) {
    await Chain.send(checker, "flagMedia", [id, reason]);
    UI.toast(`Record #${id} disputed by ${Chain.label(checker)}`, "success");
  }

  // ------------------------------------------------------------------
  // View helpers
  // ------------------------------------------------------------------
  const pageHead = (title, sub, actions = "") =>
    `<div class="page-head"><div><h1>${title}</h1><p>${sub}</p></div><div class="row">${actions}</div></div>`;

  function thumbHtml(m, T, cls = "thumb") {
    const t = T[m.sha3Hash];
    return t
      ? `<img class="${cls}" src="${t}" alt="${UI.esc(m.title)}">`
      : `<span class="${cls} thumb-empty" title="Thumbnail not stored in this browser">${Shell.icon("image")}</span>`;
  }

  function statusChips(m, data) {
    const out = [m.revoked ? `<span class="chip chip-bad">Revoked</span>` : `<span class="chip chip-ok">Registered</span>`];
    if (m.flagged) out.push(`<span class="chip chip-warn">Disputed</span>`);
    const p = memberOf(data, m.publisher);
    if (p && !p.active) out.push(`<span class="chip chip-bad">Publisher suspended</span>`);
    return `<div class="row" style="gap:4px">${out.join("")}</div>`;
  }

  const roleName = (r) => (r === ROLE.Publisher ? "Publisher" : r === ROLE.FactChecker ? "Fact-checker" : "-");
  const activeChip = (m) => (m.active ? `<span class="chip chip-ok">Active</span>` : `<span class="chip chip-bad">Suspended</span>`);

  function mediaTable(list, data, T, { actions = null, empty = "No images registered yet.", compact = false } = {}) {
    if (!list.length) return `<div class="empty">${empty}</div>`;
    if (compact) {
      return `<div class="table-wrap"><table class="table">
      <thead><tr><th>Photo</th><th>Record</th><th>Status</th></tr></thead>
      <tbody>${list
        .map(
          (m) => `<tr>
          <td data-label="Photo">${thumbHtml(m, T)}</td>
          <td data-label="Record"><strong>#${m.id} ${UI.esc(m.title)}</strong><div class="muted small">${UI.esc(Chain.label(m.publisher))} · ${UI.fmtTime(m.registeredAt)}</div></td>
          <td data-label="Status">${statusChips(m, data)}</td>
        </tr>`
        )
        .join("")}</tbody></table></div>`;
    }
    return `<div class="table-wrap"><table class="table">
      <thead><tr><th>Photo</th><th>Record</th><th>Publisher</th><th>Registered</th><th>Status</th>${actions ? "<th></th>" : ""}</tr></thead>
      <tbody>${list
        .map(
          (m) => `<tr>
          <td data-label="Photo">${thumbHtml(m, T)}</td>
          <td data-label="Record"><strong>#${m.id} ${UI.esc(m.title)}</strong><div class="muted small clamp">${UI.esc(m.caption)}</div></td>
          <td data-label="Publisher">${UI.esc(Chain.label(m.publisher))}</td>
          <td data-label="Registered" class="nowrap">${UI.fmtTime(m.registeredAt)}</td>
          <td data-label="Status">${statusChips(m, data)}</td>
          ${actions ? `<td data-label="Actions">${actions(m)}</td>` : ""}
        </tr>`
        )
        .join("")}</tbody></table></div>`;
  }

  function bitGrid(hex, otherHex) {
    const a = TF().bits(hex);
    const b = otherHex ? TF().bits(otherHex) : a;
    return `<div class="bitgrid" role="img" aria-label="64-bit perceptual hash ${hex}">${a
      .map((v, i) => `<span class="${v ? "on" : ""}${v !== b[i] ? " diff" : ""}"></span>`)
      .join("")}</div>`;
  }

  function meter(d) {
    const pct = Math.min(100, (d / 32) * 100);
    return `<div class="meter" title="${d} of 64 bits differ"><span class="${d <= THRESHOLD ? "ok" : "bad"}" style="width:${Math.max(3, pct)}%"></span><i style="left:${(THRESHOLD / 32) * 100}%"></i></div>`;
  }

  const VERDICTS = {
    original: { cls: "verdict-ok", icon: "✅", title: "Original" },
    edited: { cls: "verdict-warn", icon: "⚠️", title: "Edited version of a registered image" },
    revoked: { cls: "verdict-bad", icon: "❌", title: "Revoked by its publisher" },
    unverified: { cls: "verdict-bad", icon: "❌", title: "Unverified" },
  };

  // ------------------------------------------------------------------
  // Views
  // ------------------------------------------------------------------
  async function viewHome(el, { data, action, go }) {
    const T = thumbs();
    const ms = data.media;
    const activePubs = data.publishers.filter((p) => p.active).length;
    el.innerHTML = `
      ${pageHead(
        "Deepfake-Proof Media Authenticity Registry",
        "Edited or fake pictures spread online as if they were real, and nobody can check whether a picture is the original a trusted publisher released. TrueFrame lets publishers fingerprint and sign their originals on a blockchain, so anyone can check an image in seconds.",
        `<button class="btn" id="samples-btn">${Shell.icon("image")} Register sample photos</button>
         <a class="btn btn-secondary" href="#/verify">${Shell.icon("check")} Verify an image</a>`
      )}
      <div class="grid-4" style="margin-bottom:16px">
        <div class="card stat"><span class="stat-value">${ms.length}</span><span class="stat-label">Images registered on-chain</span></div>
        <div class="card stat"><span class="stat-value">${activePubs}</span><span class="stat-label">Active trusted publishers</span></div>
        <div class="card stat"><span class="stat-value">${ms.filter((m) => m.flagged).length}</span><span class="stat-label">Disputed by fact-checkers</span></div>
        <div class="card stat"><span class="stat-value">${ms.filter((m) => m.revoked).length}</span><span class="stat-label">Revoked by publishers</span></div>
      </div>
      <div class="card" style="margin-bottom:16px">
        <div class="card-head"><h2>How it works</h2></div>
        <div class="flow" style="--steps:4">
          <div class="flow-step"><h3>Fingerprint</h3><p>SHA3-256 of the exact file and a 64-bit perceptual hash (dHash) of what the picture looks like.</p></div>
          <div class="flow-step"><h3>Sign</h3><p>The publisher signs both hashes with its private key (ECDSA), proving who released the picture.</p></div>
          <div class="flow-step"><h3>Anchor</h3><p>The smart contract checks the signature with ecrecover, rejects duplicates and timestamps the record.</p></div>
          <div class="flow-step"><h3>Verify</h3><p>Anyone checks an image: exact hash match = original, close perceptual hash = edited copy, neither = unverified.</p></div>
        </div>
      </div>
      <div class="grid-2" style="align-items:start">
        <div class="card"><div class="card-head"><h2>Registered images</h2><a href="#/publisher" class="small">Register more</a></div>
          ${mediaTable(ms.slice().reverse().slice(0, 6), data, T, { compact: true, empty:"No images yet. Click <strong>Register sample photos</strong> or open the Publisher page." })}</div>
        <div class="card">
          <div class="card-head"><h2>Demo script (5 minutes)</h2></div>
          <ol class="demo-list">
            <li><a href="#/publisher">Publisher</a>: as The Daily Ledger, register the sample photo. Watch SHA3, dHash, signature and transaction.</li>
            <li>Same page: <em>Re-register</em> or <em>Copy a signature</em>. The smart contract blocks both.</li>
            <li>Back here: <strong>Register sample photos</strong> so every publisher has one.</li>
            <li><a href="#/verify">Verify an Image</a>: pick a registered photo. Result: ✅ Original.</li>
            <li><a href="#/tamper">Tamper Lab</a>: add a fake BREAKING banner, send it to Verify: ⚠️ Edited, side by side with the original. Try <em>Mirror flip</em> and <em>Different image</em> too.</li>
            <li><a href="#/factcheck">Fact-Checker</a> disputes a caption; the publisher revokes a photo; <a href="#/council">Press Council</a> suspends a publisher.</li>
            <li><a href="#/explorer">Blockchain Explorer</a>: hash-linked blocks and the audit log.</li>
          </ol>
        </div>
      </div>`;

    const sb = el.querySelector("#samples-btn");
    sb.addEventListener("click", () => action(sb, registerSamples));
  }

  async function viewPublisher(el, { data, state, action }) {
    if (!data.publishers.length) return (el.innerHTML = `<div class="empty">No publishers registered.</div>`);
    state.pub = state.pub && data.publishers.some((p) => sameAddr(p.address, state.pub)) ? state.pub : data.publishers[0].address;
    const me = data.publishers.find((p) => sameAddr(p.address, state.pub));
    const T = thumbs();
    const O = originals();
    const mine = data.media.filter((m) => sameAddr(m.publisher, me.address));
    const regScenes = registeredScenes(data);
    state.pubSource = state.pubSource || "sample";
    if (!state.pubFile || state.pubFile.owner !== me.address || (state.pubFile.scene && regScenes.has(state.pubFile.scene))) {
      const sc = defaultScene(me.name, data) || ImageLab.SCENES[0];
      state.pubFile = null;
      state.pubScene = sc.id;
    }
    const scene = ImageLab.SCENES.find((s) => s.id === state.pubScene) || ImageLab.SCENES[0];
    const result = state.regResult && sameAddr(state.regResult.publisher, me.address) ? state.regResult : null;
    const sample = state.pubSource === "sample";

    el.innerHTML = `
      ${pageHead(
        "Publisher newsroom",
        "Register original photos. Each one is fingerprinted twice, signed with the publisher's own private key and anchored on the blockchain, where the smart contract verifies the signature."
      )}
      <div class="segmented" style="margin-bottom:16px" role="tablist">${data.publishers
        .map((p) => `<button type="button" role="tab" data-pub="${p.address}" class="${sameAddr(p.address, me.address) ? "active" : ""}">${UI.esc(p.name)}</button>`)
        .join("")}</div>
      <div class="card" style="margin-bottom:16px">
        <div class="kv"><span>Publisher</span><strong>${UI.esc(me.name)}</strong> ${activeChip(me)}</div>
        <div class="kv"><span>Account (public key)</span><code>${UI.esc(me.address)}</code></div>
        <div class="kv"><span>Registered images</span><span>${mine.length} (${mine.filter((m) => m.revoked).length} revoked)</span></div>
      </div>
      <div class="grid-2" style="align-items:start;margin-bottom:16px">
        <form class="card" id="reg-form" autocomplete="off">
          <div class="card-head"><h2>Register an original photo</h2>
            <div class="segmented" role="group" aria-label="Image source">
              <button type="button" data-src="sample" class="${sample ? "active" : ""}">Sample photo</button>
              <button type="button" data-src="upload" class="${sample ? "" : "active"}">Upload file</button>
            </div></div>
          ${
            sample
              ? `<div class="field"><label for="f-scene">Built-in sample (generated in your browser)</label>
                  <select id="f-scene">${ImageLab.SCENES.map(
                    (s) => `<option value="${s.id}" ${s.id === scene.id ? "selected" : ""}>${UI.esc(s.title)}${regScenes.has(s.id) ? " (already registered)" : ""}</option>`
                  ).join("")}</select></div>`
              : `<div class="field"><label for="f-file">Image file (PNG, JPEG, WebP; max 5 MB)</label>
                  <input id="f-file" type="file" accept="image/*"><span class="hint">Processed in your browser. Only hashes go on-chain.</span></div>`
          }
          <figure class="preview" id="pub-preview"><div class="preview-empty">${sample ? "Painting sample…" : "Choose an image file"}</div></figure>
          <div class="field"><label for="f-title">Title</label><input id="f-title" name="title" type="text" required maxlength="80" value="${sample ? UI.esc(scene.title) : ""}"></div>
          <div class="field"><label for="f-caption">Caption</label><input id="f-caption" name="caption" type="text" maxlength="200" value="${sample ? UI.esc(scene.caption) : ""}"></div>
          <div class="field"><label for="f-captured">Captured at</label><input id="f-captured" name="captured" type="datetime-local" required value="${toLocalInput(Chain.now() - 3600)}">
            <span class="hint">The contract rejects capture times later than the current block time.</span></div>
          <button class="btn" type="submit" id="reg-btn">${Shell.icon("shield")} Fingerprint, sign &amp; register</button>
        </form>
        <div class="stack">
          <div class="card">
            <div class="card-head"><h2>What happens</h2></div>
            <div id="reg-steps">${
              result
                ? UI.checklist(result.items)
                : `<p class="muted">The steps run in your browser and are shown here: the SHA3-256 file hash, the perceptual hash, the ECDSA signature and the blockchain transaction.</p>`
            }</div>
          </div>
          <div class="card">
            <div class="card-head"><h2>Try to cheat the registry</h2></div>
            <p class="muted small">Both attempts are sent as real transactions. The smart contract refuses them.</p>
            <div class="row">
              <button type="button" class="btn btn-secondary" id="dup-btn" ${data.media.length ? "" : "disabled"}>${Shell.icon("layers")} Re-register an existing photo</button>
              <button type="button" class="btn btn-secondary" id="steal-btn" ${data.media.length ? "" : "disabled"}>${Shell.icon("key")} Copy a signature onto a staged photo</button>
            </div>
            ${data.media.length ? "" : `<p class="muted small" style="margin-top:8px">Register a photo first.</p>`}
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h2>${UI.esc(me.name)}'s registered images</h2><span class="muted small">Revoking keeps the record on-chain, marked as withdrawn.</span></div>
        ${mediaTable(mine.slice().reverse(), data, T, {
          empty: "No images registered by this publisher yet.",
          actions: (m) => `<div class="row" style="gap:6px">
            <button class="btn btn-secondary btn-sm" data-verify="${m.id}">Verify</button>
            ${O[m.sha3Hash] ? `<button class="btn btn-ghost btn-sm" data-dl="${m.id}">Download</button>` : ""}
            ${m.revoked ? "" : `<button class="btn btn-danger btn-sm" data-revoke="${m.id}">Revoke</button>`}</div>`,
        })}
      </div>`;

    const form = el.querySelector("#reg-form");
    const preview = el.querySelector("#pub-preview");
    const showPreview = (file) => {
      if (!preview.isConnected) return;
      preview.innerHTML = `<img src="${objectUrl(file)}" alt="Image to register"><figcaption>${UI.esc(file.name)} · ${fmtBytes(file.bytes.length)}</figcaption>`;
    };
    const loadScene = async (sc) => {
      const f = await sampleFile(sc);
      state.pubFile = { ...f, owner: me.address };
      state.pubScene = sc.id;
      showPreview(state.pubFile);
    };
    if (state.pubFile && (!sample || state.pubFile.scene === scene.id) && (sample || !state.pubFile.scene)) showPreview(state.pubFile);
    else if (sample) loadScene(scene);
    else state.pubFile = null;

    el.querySelectorAll("[data-pub]").forEach((b) =>
      b.addEventListener("click", () => {
        state.pub = b.dataset.pub;
        Shell.render();
      })
    );
    el.querySelectorAll("[data-src]").forEach((b) =>
      b.addEventListener("click", () => {
        state.pubSource = b.dataset.src;
        state.pubFile = null;
        Shell.render();
      })
    );
    const sel = el.querySelector("#f-scene");
    if (sel)
      sel.addEventListener("change", () => {
        const sc = ImageLab.SCENES.find((s) => s.id === sel.value);
        form.title.value = sc.title;
        form.caption.value = sc.caption;
        preview.innerHTML = `<div class="preview-empty">Painting sample…</div>`;
        loadScene(sc);
      });
    const fileIn = el.querySelector("#f-file");
    if (fileIn)
      fileIn.addEventListener("change", async () => {
        const f = await readImageInput(fileIn);
        if (!f) return;
        state.pubFile = { ...f, owner: me.address };
        if (!form.title.value) form.title.value = f.name.replace(/\.[^.]+$/, "");
        showPreview(state.pubFile);
      });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (!state.pubFile) return UI.toast(sample ? "The sample is still being painted, try again" : "Choose an image file first", "error");
      const file = state.pubFile;
      action(el.querySelector("#reg-btn"), async () => {
        await registerMedia(me.address, file, {
          title: form.title.value.trim(),
          caption: form.caption.value.trim(),
          capturedAt: fromLocalInput(form.captured.value),
        });
        state.pubFile = null;
      });
    });

    el.querySelector("#dup-btn").addEventListener("click", (e) =>
      action(e.currentTarget, async () => {
        const target = data.media.slice().reverse().find((m) => O[m.sha3Hash]);
        if (!target) throw new Error("No registered original is stored in this browser.");
        const item = await analyse(storedOriginal(target));
        const sig = await TF().sign(me.address, item.sha3, item.pHash);
        await Chain.send(me.address, "registerMedia", [item.sha3, item.pHash, target.title + " (copy)", target.caption, Chain.now() - 60, sig]);
      })
    );
    el.querySelector("#steal-btn").addEventListener("click", (e) =>
      action(e.currentTarget, async () => {
        const donor = data.media.slice().reverse().find((m) => !sameAddr(m.publisher, me.address)) || data.media[data.media.length - 1];
        const staged = await analyse({
          bytes: await ImageLab.canvasBytes(ImageLab.paintScene("storm", "staged|" + me.address)),
          type: "image/jpeg",
          name: "staged-flood.jpg",
        });
        await Chain.send(me.address, "registerMedia", [
          staged.sha3,
          staged.pHash,
          "City centre under water",
          "Staged photo carrying a signature copied from record #" + donor.id,
          Chain.now() - 60,
          donor.signature,
        ]);
      })
    );
    el.querySelectorAll("[data-verify]").forEach((b) => b.addEventListener("click", () => openInVerify(data.media[Number(b.dataset.verify)])));
    el.querySelectorAll("[data-dl]").forEach((b) =>
      b.addEventListener("click", () => {
        const f = storedOriginal(data.media[Number(b.dataset.dl)]);
        UI.download(f.name, new Blob([f.bytes], { type: f.type }));
      })
    );
    el.querySelectorAll("[data-revoke]").forEach((b) =>
      b.addEventListener("click", () => {
        const reason = prompt("Reason for revoking this photo (shown to everyone who verifies it):", "Caption named the wrong location - corrected version to follow");
        if (reason) action(b, () => revoke(me.address, Number(b.dataset.revoke), reason));
      })
    );
  }

  function openInVerify(m) {
    const f = storedOriginal(m);
    if (!f) return UI.toast("The original file is not stored in this browser. Upload it on the Verify page.", "error");
    Shell.state.verifyFile = { ...f, origin: `Original file of record #${m.id}` };
    Shell.state.autoVerify = true;
    if (location.hash === "#/verify") Shell.render();
    else location.hash = "#/verify";
  }

  async function viewFactCheck(el, { data, state, action }) {
    if (!data.factCheckers.length) return (el.innerHTML = `<div class="empty">No fact-checkers registered.</div>`);
    state.checker = state.checker && data.factCheckers.some((f) => sameAddr(f.address, state.checker)) ? state.checker : data.factCheckers[0].address;
    const me = data.factCheckers.find((f) => sameAddr(f.address, state.checker));
    const T = thumbs();
    el.innerHTML = `
      ${pageHead(
        "Fact-Checker",
        "Independent fact-checkers can dispute a registered photo, for example when it is real but the caption is misleading. The dispute is public and permanent, and every verifier sees it next to the record."
      )}
      ${
        data.factCheckers.length > 1
          ? `<div class="segmented" style="margin-bottom:16px" role="tablist">${data.factCheckers
              .map((f) => `<button type="button" role="tab" data-fc="${f.address}" class="${sameAddr(f.address, me.address) ? "active" : ""}">${UI.esc(f.name)}</button>`)
              .join("")}</div>`
          : ""
      }
      <div class="card" style="margin-bottom:16px">
        <div class="kv"><span>Fact-checker</span><strong>${UI.esc(me.name)}</strong> ${activeChip(me)}</div>
        <div class="kv"><span>Account</span><code>${UI.esc(me.address)}</code></div>
        <div class="kv"><span>Disputes raised</span><span>${data.media.filter((m) => sameAddr(m.flaggedBy, me.address)).length}</span></div>
      </div>
      <div class="card">
        <div class="card-head"><h2>Registered images</h2></div>
        ${mediaTable(data.media.slice().reverse(), data, T, {
          actions: (m) =>
            m.flagged
              ? `<div class="small"><strong>Disputed:</strong> ${UI.esc(m.flagReason)}</div>`
              : m.revoked
              ? `<span class="muted small">Revoked: ${UI.esc(m.revokeReason)}</span>`
              : `<button class="btn btn-secondary btn-sm" data-flag="${m.id}">${Shell.icon("search")} Dispute</button>`,
        })}
      </div>`;
    el.querySelectorAll("[data-fc]").forEach((b) =>
      b.addEventListener("click", () => {
        state.checker = b.dataset.fc;
        Shell.render();
      })
    );
    el.querySelectorAll("[data-flag]").forEach((b) =>
      b.addEventListener("click", () => {
        const reason = prompt("Why is this record misleading? (stored on-chain)", "Photo is genuine but was taken last year, not this week");
        if (reason) action(b, () => flag(me.address, Number(b.dataset.flag), reason));
      })
    );
  }

  async function viewCouncil(el, { data, action }) {
    const free = Chain.accounts.slice(1).filter((a) => !memberOf(data, a));
    const names = new Set(data.members.map((m) => m.name));
    const suggestion = ["Valley Gazette", "Harbour City Herald", "Riverside Broadcast", "Northern Wire", "Coastline Radio News"].find((n) => !names.has(n)) || "";
    const disputes = data.media.filter((m) => m.flagged);
    const T = thumbs();
    el.innerHTML = `
      ${pageHead(
        "Press Council",
        `Acting as <code>${UI.esc(UI.short(council(), 4))}</code> (contract owner). The council runs the permissioned consortium: it admits publishers and fact-checkers and can suspend them.`
      )}
      <div class="grid-2" style="align-items:start;margin-bottom:16px">
        <form class="card" id="admit-form" autocomplete="off">
          <div class="card-head"><h2>Admit a new member</h2></div>
          ${
            free.length
              ? `<div class="field"><label for="f-acct">Account</label><select id="f-acct" name="account">${free
                  .map((a) => `<option value="${a}">${UI.esc(UI.short(a, 6))}</option>`)
                  .join("")}</select></div>
                <div class="field"><label for="f-name">Organisation name</label><input id="f-name" name="name" type="text" required maxlength="60" value="${UI.esc(suggestion)}"></div>
                <div class="field"><label for="f-role">Role</label><select id="f-role" name="role"><option value="registerPublisher">Publisher</option><option value="registerFactChecker">Fact-checker</option></select></div>
                <button class="btn" type="submit" id="admit-btn">${Shell.icon("users")} Admit member</button>`
              : `<p class="muted">All demo accounts are already members.</p>`
          }
        </form>
        <div class="card">
          <div class="card-head"><h2>Why a permissioned consortium?</h2></div>
          <ul class="bullets">
            <li>Anyone may <strong>verify</strong> images, but only vetted organisations may <strong>vouch</strong> for them.</li>
            <li>The smart contract enforces roles: only active publishers can register, only active fact-checkers can dispute.</li>
            <li>Suspending a publisher stops new registrations at once. Its existing records stay on-chain and verifiers see the suspension.</li>
            <li>Every decision is an on-chain event, so the council itself is auditable.</li>
          </ul>
        </div>
      </div>
      <div class="card" style="margin-bottom:16px">
        <div class="card-head"><h2>Members</h2><span class="muted small">Only the Press Council can change this list.</span></div>
        <div class="table-wrap"><table class="table"><thead><tr><th>Name</th><th>Role</th><th>Account</th><th>Images</th><th>Status</th><th></th></tr></thead><tbody>
        ${data.members
          .map(
            (m) => `<tr><td data-label="Name"><strong>${UI.esc(m.name)}</strong></td>
            <td data-label="Role"><span class="chip">${roleName(m.role)}</span></td>
            <td data-label="Account"><code>${UI.esc(UI.short(m.address, 4))}</code></td>
            <td data-label="Images">${m.role === ROLE.Publisher ? data.media.filter((x) => sameAddr(x.publisher, m.address)).length : "-"}</td>
            <td data-label="Status">${activeChip(m)}</td>
            <td><button class="btn btn-secondary btn-sm" data-toggle="${m.address}" data-active="${m.active}">${m.active ? "Suspend" : "Re-activate"}</button></td></tr>`
          )
          .join("")}</tbody></table></div>
      </div>
      <div class="card">
        <div class="card-head"><h2>Open disputes</h2><span class="muted small">Raised by fact-checkers</span></div>
        ${mediaTable(disputes, data, T, {
          empty: "No disputes.",
          actions: (m) => `<div class="small"><strong>${UI.esc(Chain.label(m.flaggedBy))}:</strong> ${UI.esc(m.flagReason)}</div>`,
        })}
      </div>`;

    const form = el.querySelector("#admit-form");
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      action(el.querySelector("#admit-btn"), async () => {
        await Chain.send(council(), form.role.value, [form.account.value, form.name.value.trim()]);
        UI.toast(`${form.name.value.trim()} admitted to the consortium`, "success");
      });
    });
    el.querySelectorAll("[data-toggle]").forEach((b) =>
      b.addEventListener("click", () =>
        action(b, async () => {
          const on = b.dataset.active !== "true";
          await Chain.send(council(), "setMemberActive", [b.dataset.toggle, on]);
          UI.toast(`${Chain.label(b.dataset.toggle)} ${on ? "re-activated" : "suspended"}`, "success");
        })
      )
    );
  }

  function verdictHtml(v, data, T) {
    const m = v.matchId != null ? data.media[v.matchId] : null;
    const V = VERDICTS[v.verdict];
    const pub = m ? memberOf(data, m.publisher) : null;
    let sub;
    if (v.failed) sub = "A verification step failed (see the checklist), so the image cannot be trusted.";
    else if (v.verdict === "original") sub = `Exact SHA3-256 match with record #${m.id}, signed by <strong>${UI.esc(pub.name)}</strong>.`;
    else if (v.verdict === "revoked") sub = `This is record #${m.id}, but ${UI.esc(pub.name)} withdrew it: “${UI.esc(m.revokeReason)}”.`;
    else if (v.verdict === "edited")
      sub = `The file is not the original, but it looks like record #${m.id} by <strong>${UI.esc(pub.name)}</strong>: only ${v.distance} of 64 perceptual-hash bits differ (threshold ${THRESHOLD}).`;
    else
      sub = `No registered original matches${v.ranking.length ? ` (closest: record #${v.ranking[0].id} at distance ${v.ranking[0].d}/64)` : ""}. This does not prove the image is fake, only that no trusted publisher vouches for it.`;
    const notes = [];
    if (m && m.flagged) notes.push(`⚠️ Disputed by ${UI.esc(Chain.label(m.flaggedBy))}: “${UI.esc(m.flagReason)}”`);
    if (m && m.revoked && v.verdict !== "revoked") notes.push(`❌ The matching original was revoked by its publisher: “${UI.esc(m.revokeReason)}”`);
    if (pub && !pub.active) notes.push("⚠️ This publisher is currently suspended by the Press Council.");
    return `<div class="verdict ${V.cls}" id="verdict" data-verdict="${v.verdict}">
        <span class="v-icon" aria-hidden="true">${V.icon}</span>
        <div><div class="v-title">${V.title}</div><div class="v-sub">${sub}</div>
        ${notes.map((n) => `<div class="v-note">${n}</div>`).join("")}</div>
      </div>`;
  }

  function compareHtml(v, data, T) {
    const m = v.matchId != null ? data.media[v.matchId] : null;
    const c = v.candidate;
    if (!m) {
      return `<div class="compare" style="margin-top:14px">
          <figure><img src="${c.url}" alt="Image you checked"><figcaption>Image you checked · ${c.width} × ${c.height}</figcaption></figure>
          <figure><div class="preview-empty compare-empty">No registered original<br>is similar enough</div><figcaption>Registry</figcaption></figure>
        </div>`;
    }
    const t = T[m.sha3Hash];
    const exact = c.sha3 === m.sha3Hash;
    return `<div class="compare" style="margin-top:14px">
        <figure><img src="${c.url}" alt="Image you checked"><figcaption>Image you checked · ${c.width} × ${c.height} · ${fmtBytes(c.size)}</figcaption></figure>
        <figure>${t ? `<img src="${t}" alt="Registered original">` : `<div class="preview-empty compare-empty">Thumbnail not stored<br>in this browser</div>`}
          <figcaption>Registered original #${m.id} · ${UI.esc(Chain.label(m.publisher))}</figcaption></figure>
      </div>
      <dl class="facts">
        <dt>Title</dt><dd><strong>${UI.esc(m.title)}</strong></dd>
        <dt>Caption</dt><dd>${UI.esc(m.caption || "-")}</dd>
        <dt>Captured</dt><dd>${UI.fmtTime(m.capturedAt)}</dd>
        <dt>Registered</dt><dd>${UI.fmtTime(m.registeredAt)} (block time)</dd>
        <dt>SHA3-256</dt><dd><span class="row" style="gap:6px"><code>${UI.esc(UI.short(c.sha3, 8))}</code>${
          exact ? `<span class="chip chip-ok">identical</span>` : `<span class="chip chip-bad">${TF().hexDiff(c.sha3, m.sha3Hash)}/64 hex digits differ</span>`
        }</span></dd>
        <dt>dHash distance</dt><dd>${v.distance} / 64 bits (threshold ${THRESHOLD}) ${meter(v.distance)}</dd>
      </dl>
      <div class="bits-pair">
        <div><div class="small muted">Your image · <code>${c.pHash}</code></div>${bitGrid(c.pHash, m.pHash)}</div>
        <div><div class="small muted">Original · <code>${m.pHash}</code></div>${bitGrid(m.pHash, c.pHash)}</div>
      </div>
      <p class="muted small" style="margin-top:8px">Each square is one bit of the 64-bit dHash (filled = the left cell is brighter than its right neighbour). Outlined squares differ.</p>`;
  }

  async function viewVerify(el, { data, state, action }) {
    const T = thumbs();
    const O = originals();
    const gallery = data.media.filter((m) => O[m.sha3Hash]);
    const v = state.verify;
    const file = state.verifyFile;
    el.innerHTML = `
      ${pageHead(
        "Verify an Image",
        "Public and free: no account, wallet or transaction is needed. The image is hashed in your browser and checked against the blockchain with read-only calls."
      )}
      <div class="grid-2" style="align-items:start">
        <div class="stack">
          <div class="card">
            <div class="card-head"><h2>Image to check</h2>
              <label class="btn">${Shell.icon("upload")} Upload image<input type="file" accept="image/*" id="verify-file" hidden></label></div>
            ${
              file
                ? `<div class="file-line">${Shell.icon("image")}<div><strong>${UI.esc(file.name)}</strong><div class="muted small">${UI.esc(file.origin || "Uploaded file")} · ${fmtBytes(
                    file.bytes.length
                  )}</div></div><button class="btn btn-secondary btn-sm" id="verify-btn">Check again</button></div>`
                : `<p class="muted small">Max 5 MB. Or pick a registered original below, or send an edited copy from the <a href="#/tamper">Tamper Lab</a>.</p>`
            }
            <h3 style="margin:14px 0 8px">Registered originals stored in this browser</h3>
            ${
              gallery.length
                ? `<div class="gallery">${gallery
                    .map(
                      (m) => `<button type="button" class="gallery-item" data-pick="${m.id}" title="Verify the original file of record #${m.id}">${thumbHtml(m, T, "gallery-img")}<span>#${m.id} ${UI.esc(
                        m.title
                      )}</span></button>`
                    )
                    .join("")}</div>`
                : `<p class="muted small">None yet. Register a photo on the <a href="#/publisher">Publisher</a> page.</p>`
            }
          </div>
          <div class="card">
            <div class="card-head"><h2>Verification steps</h2></div>
            <div id="verify-steps">${v ? UI.checklist(v.items) : `<p class="muted">Choose an image to start.</p>`}</div>
          </div>
        </div>
        <div class="card" id="result-card">
          <div class="card-head"><h2>Result</h2></div>
          ${
            v
              ? verdictHtml(v, data, T) + compareHtml(v, data, T)
              : `<div class="legend">
                  <div class="verdict verdict-ok"><span class="v-icon">✅</span><div><div class="v-title">Original</div><div class="v-sub">The SHA3-256 hash matches a registered record exactly and the publisher's signature is valid.</div></div></div>
                  <div class="verdict verdict-warn"><span class="v-icon">⚠️</span><div><div class="v-title">Edited version</div><div class="v-sub">The file differs, but its perceptual hash is within ${THRESHOLD} of 64 bits of a registered original. You see both side by side.</div></div></div>
                  <div class="verdict verdict-bad"><span class="v-icon">❌</span><div><div class="v-title">Unverified</div><div class="v-sub">No trusted publisher has registered this picture or anything that looks like it.</div></div></div>
                </div>`
          }
        </div>
      </div>`;

    const start = (f) => {
      state.verifyFile = f;
      state.verify = null;
      state.autoVerify = true;
      Shell.render();
    };
    el.querySelector("#verify-file").addEventListener("change", async (e) => {
      const f = await readImageInput(e.target);
      if (f) start({ ...f, origin: "Uploaded file" });
    });
    el.querySelectorAll("[data-pick]").forEach((b) =>
      b.addEventListener("click", () => {
        const m = data.media[Number(b.dataset.pick)];
        start({ ...storedOriginal(m), origin: `Original file of record #${m.id}` });
      })
    );
    if (v && v.scroll) {
      // On narrow screens the result card sits below the steps: bring it into view once.
      v.scroll = false;
      if (matchMedia("(max-width: 860px)").matches) setTimeout(() => el.querySelector("#result-card").scrollIntoView({ block: "start" }), 0);
    }
    const vb = el.querySelector("#verify-btn");
    if (vb) vb.addEventListener("click", () => action(vb, () => verifyImage(state.verifyFile)));
    if (state.autoVerify && file && vb) {
      state.autoVerify = false;
      action(vb, () => verifyImage(file));
    }
  }

  async function viewTamper(el, { data, state, action }) {
    const T = thumbs();
    const O = originals();
    const usable = data.media.filter((m) => O[m.sha3Hash] || T[m.sha3Hash]);
    if (!usable.length) {
      el.innerHTML = `${pageHead("Tamper Lab", "Edit a registered photo and see which fingerprint survives.")}
        <div class="card empty">No registered photos in this browser yet. Register one on the <a href="#/publisher">Publisher</a> page or click <a href="#/">Register sample photos</a>.</div>`;
      return;
    }
    const t = (state.tamper = state.tamper || {});
    if (!usable.some((m) => m.id === t.mediaId)) t.mediaId = usable[0].id;
    t.edit = t.edit || "banner";
    const edit = ImageLab.EDITS.find((e) => e.id === t.edit);
    const r = t.result && t.result.mediaId === t.mediaId && t.result.editId === t.edit ? t.result : null;
    const m = data.media[t.mediaId];
    const all = state.tamperAll && state.tamperAll.mediaId === t.mediaId ? state.tamperAll : null;
    const outcome = (x) =>
      ({ original: `<span class="chip chip-ok">✅ Original</span>`, edited: `<span class="chip chip-warn">⚠️ Edited copy of #${t.mediaId}</span>`, unverified: `<span class="chip chip-bad">❌ Unverified</span>` })[
        expectedVerdict(x)
      ];

    el.innerHTML = `
      ${pageHead(
        "Tamper Lab",
        "Edit a registered photo in your browser and watch the two fingerprints. The exact SHA3-256 hash breaks on any change at all; the perceptual hash still recognises edited copies of the same picture."
      )}
      <div class="card" style="margin-bottom:16px">
        <div class="tamper-controls">
          <div class="field" style="margin:0"><label for="t-media">1. Registered photo</label>
            <select id="t-media">${usable.map((x) => `<option value="${x.id}" ${x.id === t.mediaId ? "selected" : ""}>#${x.id} ${UI.esc(x.title)}</option>`).join("")}</select></div>
          <div class="field" style="margin:0"><label>2. Edit</label>
            <div class="segmented edit-picker" role="group" aria-label="Edit">${ImageLab.EDITS.map(
              (e) => `<button type="button" data-edit="${e.id}" class="${e.id === t.edit ? "active" : ""}">${UI.esc(e.label)}</button>`
            ).join("")}</div></div>
        </div>
        <p class="muted small" style="margin:10px 0 0">${UI.esc(edit.hint)}</p>
      </div>
      <div class="card" style="margin-bottom:16px" id="tamper-card">
        ${
          r
            ? `<div class="tamper-grid">
                <figure class="tamper-fig"><img src="${r.original.url}" alt="Registered original"><figcaption><strong>Registered original #${m.id}</strong><br>${r.original.width} × ${
                  r.original.height
                } · ${fmtBytes(r.original.bytes.length)} · ${UI.esc(Chain.label(m.publisher))}${r.fromThumb ? " (thumbnail: original file not stored here)" : ""}</figcaption></figure>
                <figure class="tamper-fig"><img src="${r.edited.url}" alt="Edited copy"><figcaption><strong>${UI.esc(edit.label)}</strong><br>${r.edited.width} × ${r.edited.height} · ${fmtBytes(
                  r.edited.bytes.length
                )}</figcaption></figure>
                <div class="tamper-side">
                  <div class="metric">
                    <div class="metric-head">${Shell.icon("shield")} Exact fingerprint (SHA3-256)</div>
                    <div class="hash">${r.edited.sha3}</div>
                    ${
                      r.exact
                        ? `<span class="chip chip-ok">identical to the registered hash</span>`
                        : `<span class="chip chip-bad">broken: ${TF().hexDiff(r.edited.sha3, m.sha3Hash)} of 64 hex digits changed</span>`
                    }
                  </div>
                  <div class="metric">
                    <div class="metric-head">${Shell.icon("image")} Perceptual fingerprint (dHash)</div>
                    <div class="hash">${r.edited.pHash} vs ${m.pHash}</div>
                    <div class="small">Hamming distance <strong id="t-distance">${r.distance}</strong> / 64 ${r.distance <= THRESHOLD ? "≤" : ">"} ${THRESHOLD} ${meter(r.distance)}</div>
                  </div>
                  <div class="small">Verify will say: ${outcome(r)}</div>
                  <div class="row">
                    <button class="btn" id="t-send">${Shell.icon("check")} Send to Verify</button>
                    <button class="btn btn-secondary" id="t-download">Download</button>
                  </div>
                </div>
              </div>
              ${t.edit === "flip" ? `<div class="callout callout-warn" style="margin-top:12px">dHash compares each cell with its right-hand neighbour, so a mirror image reverses most comparisons. A simple flip defeats this perceptual hash: an honest limitation (better hashes compare the flipped image too).</div>` : ""}`
            : `<div class="empty"><span class="spinner"></span><p style="margin-top:8px">Applying the edit…</p></div>`
        }
      </div>
      <div class="card">
        <div class="card-head"><h2>Every edit at a glance</h2><button class="btn btn-secondary btn-sm" id="t-all">${Shell.icon("layers")} Run all edits on #${t.mediaId}</button></div>
        ${
          all
            ? `<div class="table-wrap"><table class="table" id="t-all-table"><thead><tr><th>Edit</th><th>SHA3-256</th><th>dHash distance</th><th>Verify says</th></tr></thead><tbody>
              ${all.rows
                .map(
                  (x) => `<tr><td data-label="Edit"><strong>${UI.esc(ImageLab.EDITS.find((e) => e.id === x.editId).label)}</strong></td>
                  <td data-label="SHA3-256">${x.exact ? `<span class="chip chip-ok">match</span>` : `<span class="chip chip-bad">changed</span>`}</td>
                  <td data-label="dHash">${x.distance} / 64</td><td data-label="Verify">${outcome(x)}</td></tr>`
                )
                .join("")}</tbody></table></div>`
            : `<p class="muted small">Applies all ${ImageLab.EDITS.length} edits to the selected photo and summarises which fingerprint survives each one.</p>`
        }
      </div>`;

    el.querySelector("#t-media").addEventListener("change", (e) => {
      t.mediaId = Number(e.target.value);
      Shell.render();
    });
    el.querySelectorAll("[data-edit]").forEach((b) =>
      b.addEventListener("click", () => {
        t.edit = b.dataset.edit;
        Shell.render();
      })
    );
    el.querySelector("#t-all").addEventListener("click", (e) =>
      action(e.currentTarget, async () => {
        const rows = [];
        for (const ed of ImageLab.EDITS) {
          const x = await tamper(t.mediaId, ed.id);
          rows.push({ editId: ed.id, exact: x.exact, distance: x.distance });
        }
        state.tamperAll = { mediaId: t.mediaId, rows };
      })
    );
    if (r) {
      el.querySelector("#t-send").addEventListener("click", () => {
        state.verifyFile = { bytes: r.edited.bytes, type: r.edited.type, name: r.edited.name, origin: `Tamper Lab: ${edit.label} on record #${m.id}` };
        state.verify = null;
        state.autoVerify = true;
        location.hash = "#/verify";
      });
      el.querySelector("#t-download").addEventListener("click", () => UI.download(r.edited.name, new Blob([r.edited.bytes], { type: r.edited.type })));
    } else {
      const key = `${t.mediaId}:${t.edit}`;
      if (t.failed === key) {
        el.querySelector("#tamper-card").innerHTML = `<div class="empty">This photo could not be edited in this browser.</div>`;
      } else if (t.pending !== key) {
        t.pending = key;
        tamper(t.mediaId, t.edit)
          .then((res) => {
            t.result = res;
          })
          .catch((e) => {
            t.failed = key;
            UI.toast(e.message, "error");
          })
          .finally(() => {
            t.pending = null;
            Shell.render();
          });
      }
    }
  }

  function formatEvent(e) {
    const a = e.args;
    switch (e.name) {
      case "MemberRegistered":
        return `${a.name} admitted as ${Number(a.role) === ROLE.Publisher ? "publisher" : "fact-checker"} by the Press Council`;
      case "MemberStatusChanged":
        return `${Chain.label(a.account)} ${a.active ? "re-activated" : "suspended"} by the Press Council`;
      case "MediaRegistered":
        return `${Chain.label(a.publisher)} registered #${a.id} "${a.title}" · SHA3 ${UI.short(a.sha3Hash, 4)} · dHash ${a.pHash} · signature verified`;
      case "MediaRevoked":
        return `${Chain.label(a.publisher)} revoked #${a.id}: ${a.reason}`;
      case "MediaFlagged":
        return `${Chain.label(a.factChecker)} disputed #${a.id}: ${a.reason}`;
      default:
        return "";
    }
  }

  async function viewExplorer(el) {
    el.innerHTML = `${pageHead("Blockchain Explorer", "Every registration, revocation, dispute and council decision is a transaction in a block. Each block stores the hash of the previous one, so changing any old record would break the chain.")}<div id="explorer-host"></div>`;
    await Explorer.render(el.querySelector("#explorer-host"), { formatEvent });
  }

  async function viewAbout(el) {
    const ok = TF().selfTest();
    el.innerHTML = `
      ${pageHead("About the project", "TrueFrame: a deepfake-proof media authenticity registry using SHA-3, perceptual hashing, ECDSA signatures and a permissioned blockchain.")}
      <div class="stack">
        <div class="card">
          <h2>Problem</h2>
          <p style="margin-top:8px">Edited or fake images spread online as if they were real. A cropped photo with a false caption, a picture from another year or a generated "news" image looks just as convincing as the original, and nobody can check whether a picture is the one a trusted publisher actually released.</p>
          <h2 style="margin-top:14px">Solution</h2>
          <ul class="bullets">
            <li><strong>Exact fingerprint:</strong> SHA3-256 of the file. Identical bytes = the original; any change gives a completely different hash.</li>
            <li><strong>Perceptual fingerprint:</strong> a 64-bit dHash of what the picture looks like. Resized, recompressed or lightly edited copies stay within a small Hamming distance, so an edited copy still points to its original.</li>
            <li><strong>Digital signature:</strong> the publisher signs both hashes with its private key; the smart contract verifies it with <code>ecrecover</code>, so nobody can register photos in a publisher's name.</li>
            <li><strong>Permissioned consortium:</strong> only publishers admitted by the Press Council can vouch for images; fact-checkers can dispute; everyone can verify for free.</li>
          </ul>
        </div>
        <div class="card">
          <h2>Syllabus mapping (22CS743)</h2>
          <div class="table-wrap" style="margin-top:8px"><table class="table"><thead><tr><th>Module</th><th>Concept</th><th>Where it is used</th></tr></thead><tbody>
            <tr><td data-label="Module">II</td><td data-label="Concept">Cryptographic hash functions (SHA-3), hash-linked blocks</td><td data-label="Used in">SHA3-256 (FIPS 202) of every file vs a perceptual dHash compared by Hamming distance; the explorer checks each block's previous-hash link</td></tr>
            <tr><td data-label="Module">III</td><td data-label="Concept">Ethereum, EVM, smart contracts, digital signatures (ECDSA)</td><td data-label="Used in"><code>MediaRegistry.sol</code> recovers the signer with <code>ecrecover</code> over an EIP-191 digest, rejects malleable signatures, duplicates and future capture times</td></tr>
            <tr><td data-label="Module">IV</td><td data-label="Concept">Permissioned / consortium blockchain</td><td data-label="Used in">The Press Council admits and suspends publishers and fact-checkers; roles are enforced on-chain</td></tr>
            <tr><td data-label="Module">V</td><td data-label="Concept">Security, identity, privacy, applications</td><td data-label="Used in">Misinformation and deepfake defence, publisher identity through keys, revocation and disputes, privacy: only hashes are on-chain</td></tr>
          </tbody></table></div>
        </div>
        <div class="grid-2">
          <div class="card">
            <h2>On-chain vs off-chain</h2>
            <ul class="bullets">
              <li><strong>On-chain:</strong> members and roles, SHA3-256 and dHash of each image, title, caption, capture time, block time, the 65-byte signature, revocations and disputes.</li>
              <li><strong>Off-chain:</strong> the image files themselves (the demo keeps a 360 px thumbnail and small originals in browser storage, standing in for the publisher's website).</li>
            </ul>
            <p class="small muted" style="margin-top:8px">Self-test: SHA3-256("abc") = <code>${UI.short(TF().SHA3_ABC, 8)}</code> ${ok ? `<span class="chip chip-ok">correct, and different from keccak256</span>` : `<span class="chip chip-bad">failed</span>`}</p>
          </div>
          <div class="card">
            <h2>Technology</h2>
            <ul class="bullets">
              <li>Solidity 0.8.24 smart contract, Hardhat (local blockchain + tests)</li>
              <li>In-browser Ethereum chain (Ganache) for zero-install demos</li>
              <li>ethers.js v6 (ECDSA signing and recovery), js-sha3 (SHA3-256)</li>
              <li>Canvas API for dHash, thumbnails, sample photos and the Tamper Lab</li>
              <li>HTML, CSS and JavaScript (no build step), hosted on GitHub Pages</li>
            </ul>
          </div>
        </div>
        <div class="card callout-warn">
          <h2>Limitations</h2>
          <ul class="bullets">
            <li>TrueFrame proves where a picture came from. An "Unverified" image is not proven fake, and a registered photo can still carry a misleading caption (that is what disputes are for).</li>
            <li>dHash survives resizing, recompression, brightness changes and small banners, but not mirror flips, rotations or large crops. Production systems combine several perceptual hashes or learned embeddings.</li>
            <li>The similarity scan reads all 64-bit hashes and compares them in the browser. That is fine for thousands of records; millions would need an off-chain index (for example a BK-tree) anchored to the chain.</li>
            <li>If a publisher's private key is stolen, the thief can register in its name until the Press Council suspends the account. Real deployments would use hardware wallets.</li>
          </ul>
        </div>
      </div>`;
  }

  // ------------------------------------------------------------------
  Shell.start({
    brand: { name: "TrueFrame", tagline: "Deepfake-proof media authenticity registry", icon: "image" },
    timeTravel: false,
    load,
    chain: {
      storageKey: "trueframe",
      artifact: window.CONTRACT_ARTIFACT,
      errors: ERRORS,
      async isSeeded(chain) {
        const [accts] = await chain.contract.getMembers();
        return accts.length > 0;
      },
      async seed(chain) {
        for (const [i, method, name] of CONSORTIUM) await chain.send(chain.accounts[0], method, [chain.accounts[i], name]);
      },
    },
    routes: [
      { id: "home", title: "Overview", icon: "home", render: viewHome },
      { id: "publisher", title: "Publisher", icon: "upload", section: "Roles", render: viewPublisher },
      { id: "factcheck", title: "Fact-Checker", icon: "search", section: "Roles", render: viewFactCheck },
      { id: "council", title: "Press Council", icon: "users", section: "Roles", render: viewCouncil },
      { id: "verify", title: "Verify an Image", icon: "check", section: "Public", render: viewVerify },
      { id: "tamper", title: "Tamper Lab", icon: "layers", section: "Public", render: viewTamper },
      { id: "explorer", title: "Blockchain Explorer", icon: "blocks", section: "Public", render: viewExplorer },
      { id: "about", title: "About & Syllabus", icon: "book", section: "Project", render: viewAbout },
    ],
  });

  // Exposed for automated tests.
  window.TrueFrameApp = { registerMedia, quickRegister, registerSamples, verifyImage, tamper, revoke, flag, load, THRESHOLD };
})();
