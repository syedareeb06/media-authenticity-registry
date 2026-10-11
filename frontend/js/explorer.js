/* Explorer - a small block explorer + audit log for the connected chain. Shared by all projects. */
(function () {
  const blockCache = new Map();

  async function getBlock(n) {
    const key = `${Chain.address}:${n}`;
    if (!blockCache.has(key)) blockCache.set(key, await Chain.provider.getBlock(n, true));
    return blockCache.get(key);
  }

  function fmtValue(v, type) {
    if (type === "address") return Chain.label(v);
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "string" && v.startsWith("0x") && v.length > 20) return UI.short(v);
    if (typeof v === "string" && v.length > 80) return v.slice(0, 77) + "…"; // e.g. public keys
    if (typeof v === "boolean") return v ? "yes" : "no";
    if (Array.isArray(v)) return `[${v.length} items]`;
    return String(v);
  }

  function genericArgs(fragment, args) {
    return fragment.inputs.map((inp, i) => `${inp.name}: ${fmtValue(args[i], inp.type)}`).join(" · ");
  }

  /** All contract events, oldest first, with block time attached. */
  async function events() {
    if (!Chain.contract) return [];
    const logs = await Chain.contract.queryFilter("*", 0, "latest");
    const out = [];
    for (const l of logs) {
      if (!l.fragment) continue;
      const b = await getBlock(l.blockNumber);
      out.push({
        name: l.fragment.name,
        fragment: l.fragment,
        args: l.args,
        blockNumber: l.blockNumber,
        txHash: l.transactionHash,
        time: b.timestamp,
      });
    }
    return out;
  }

  function describeTx(tx) {
    if (!tx.to) return { name: "Contract deployment", detail: "" };
    try {
      const parsed = Chain.contract.interface.parseTransaction({ data: tx.data, value: tx.value });
      if (parsed) return { name: parsed.name, detail: genericArgs(parsed.fragment, parsed.args) };
    } catch {}
    return { name: "Transaction", detail: "" };
  }

  async function render(el, opts = {}) {
    const max = opts.blocks || 20;
    const formatEvent = opts.formatEvent || ((e) => genericArgs(e.fragment, e.args));
    el.innerHTML = `<div class="card"><p class="muted">Reading the blockchain…</p></div>`;

    const latest = await Chain.blockNumber();
    const from = Math.max(0, latest - max + 1);
    const blocks = [];
    for (let n = latest; n >= from; n--) blocks.push(await getBlock(n));
    const prevOfLast = from > 0 ? await getBlock(from - 1) : null;

    const blockHtml = [];
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      const prev = i + 1 < blocks.length ? blocks[i + 1] : prevOfLast;
      const linked = b.number === 0 ? null : prev ? prev.hash === b.parentHash : null;
      const txs = b.prefetchedTransactions || [];
      const txHtml = [];
      for (const tx of txs) {
        const r = await Chain.provider.getTransactionReceipt(tx.hash);
        const d = describeTx(tx);
        txHtml.push(`<div class="tx">
            <div class="tx-main"><span class="chip ${r && r.status === 1 ? "chip-ok" : "chip-bad"}">${r && r.status === 1 ? "success" : "failed"}</span>
            <strong>${UI.esc(d.name)}</strong> <span class="muted">by ${UI.esc(Chain.label(tx.from))}</span></div>
            ${d.detail ? `<div class="tx-detail">${UI.esc(d.detail)}</div>` : ""}
            <div class="tx-meta"><code title="${UI.esc(tx.hash)}">tx ${UI.esc(UI.short(tx.hash))}</code> · gas ${r ? Number(r.gasUsed).toLocaleString() : "-"}</div>
          </div>`);
      }
      blockHtml.push(`<li class="block">
          <div class="block-no">#${b.number}</div>
          <div class="block-body">
            <div class="kv"><span>Block hash</span><code title="${UI.esc(b.hash)}">${UI.esc(UI.short(b.hash, 8))}</code></div>
            <div class="kv"><span>Previous hash</span><code title="${UI.esc(b.parentHash)}">${UI.esc(UI.short(b.parentHash, 8))}</code>
              ${linked === true ? `<span class="chip chip-ok">linked to #${b.number - 1}</span>` : linked === false ? `<span class="chip chip-bad">broken link</span>` : b.number === 0 ? `<span class="chip">genesis</span>` : ""}</div>
            <div class="kv"><span>Time</span><span>${UI.fmtTime(b.timestamp)}</span></div>
            ${txHtml.length ? txHtml.join("") : `<div class="muted small">No transactions (empty block)</div>`}
          </div>
        </li>`);
    }

    const evs = (await events()).reverse();
    const rows = evs
      .map(
        (e) => `<tr>
          <td data-label="Time" class="nowrap" title="${UI.esc(UI.fmtTime(e.time))}">${UI.fmtClock(e.time)}</td>
          <td data-label="Block">#${e.blockNumber}</td>
          <td data-label="Event"><span class="chip chip-accent">${UI.esc(e.name)}</span></td>
          <td data-label="Details">${UI.esc(formatEvent(e))}</td>
          <td data-label="Tx"><code title="${UI.esc(e.txHash)}">${UI.esc(UI.short(e.txHash, 4))}</code></td>
        </tr>`
      )
      .join("");

    el.innerHTML = `
      <div class="grid-2 explorer">
        <section class="card">
          <div class="card-head"><h2>Blocks</h2><span class="muted small">Latest ${blocks.length} of ${latest + 1}. Each block stores the hash of the block before it.</span></div>
          <ol class="chain">${blockHtml.join("")}</ol>
        </section>
        <section class="card">
          <div class="card-head"><h2>Audit log</h2><span class="muted small">${evs.length} events emitted by the smart contract at <code>${UI.esc(UI.short(Chain.address, 4))}</code></span></div>
          ${
            evs.length
              ? `<div class="table-wrap"><table class="table"><thead><tr><th>Time</th><th>Block</th><th>Event</th><th>Details</th><th>Tx</th></tr></thead><tbody>${rows}</tbody></table></div>`
              : `<p class="muted">No events yet.</p>`
          }
        </section>
      </div>`;
  }

  window.Explorer = { render, events, getBlock };
})();
