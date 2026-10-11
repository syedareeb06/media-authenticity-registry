/* Chain - connects the web app to a blockchain. Shared by all projects.
 *
 * Two modes:
 *  - "browser": a real Ethereum chain (Ganache) running inside this web page.
 *    Nothing to install. State is kept in localStorage and rebuilt on reload by
 *    replaying the recorded transactions.
 *  - "local":   a Hardhat node on your computer (cd blockchain && npm run node).
 *
 * Both modes run the exact same compiled Solidity contract.
 */
(function () {
  const RPC_URL = "http://127.0.0.1:8545";
  const listeners = new Set();
  const state = {
    cfg: null,
    mode: null,
    provider: null,
    contract: null,
    accounts: [],
    address: null,
    chainId: null,
    instance: null, // identifies this chain instance, so off-chain data never mixes between chains
    offset: 0, // chainTime - wallClock (seconds)
    replaying: false,
    names: {},
  };

  // ---------- storage helpers (bigint-safe JSON) ----------
  const toJson = (v) => JSON.stringify(v, (k, x) => (typeof x === "bigint" ? { $big: x.toString() } : x));
  const fromJson = (s) => JSON.parse(s, (k, x) => (x && typeof x === "object" && "$big" in x ? BigInt(x.$big) : x));
  const lsGet = (k, d) => {
    try {
      const v = localStorage.getItem(k);
      return v == null ? d : fromJson(v);
    } catch {
      return d;
    }
  };
  const lsSet = (k, v) => {
    try {
      localStorage.setItem(k, toJson(v));
    } catch (e) {
      console.warn("localStorage write failed", e);
    }
  };
  const lsDel = (k) => {
    try {
      localStorage.removeItem(k);
    } catch {}
  };
  const modeKey = (suffix) => `${state.cfg.storageKey}:${state.mode}:${suffix}`;
  const storeKey = () => `${state.cfg.storageKey}:${state.mode}:${state.instance}:${state.address}:store`;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error("Could not load " + src));
      document.head.appendChild(s);
    });
  }

  // ---------- init ----------
  function getSavedMode(storageKey) {
    const fromUrl = new URLSearchParams(location.search).get("mode");
    if (fromUrl === "local" || fromUrl === "browser") return fromUrl;
    return lsGet(`${storageKey}:mode`, "browser");
  }

  async function init(cfg, mode) {
    state.cfg = cfg;
    state.mode = mode;
    lsSet(`${cfg.storageKey}:mode`, mode);
    if (mode === "browser") await initBrowser();
    else await initLocal();
    state.instance =
      mode === "browser" ? String(lsGet(modeKey("genesis"), 0)) : (await state.provider.getBlock(0)).hash.slice(0, 12);
    const latest = await state.provider.getBlock("latest");
    state.offset = latest.timestamp - Date.now() / 1000;
    emit();
  }

  async function initBrowser() {
    if (!window.Ganache) await loadScript("vendor/ganache.min.js");
    let genesis = lsGet(modeKey("genesis"), null);
    if (!genesis) {
      genesis = Math.floor(Date.now() / 1000);
      lsSet(modeKey("genesis"), genesis);
    }
    const ganache = window.Ganache.provider({
      wallet: { deterministic: true, totalAccounts: 10, defaultBalance: 1000 },
      chain: { hardfork: "shanghai", chainId: 1337, time: new Date(genesis * 1000) },
      miner: { blockGasLimit: 30000000 },
      logging: { quiet: true },
    });
    state.provider = new ethers.BrowserProvider(ganache);
    state.provider.pollingInterval = 250;
    state.chainId = 1337;
    state.accounts = await state.provider.send("eth_accounts", []);

    await deployAndSeed();

    // Rebuild previous state by replaying the recorded transactions.
    const log = lsGet(modeKey("txlog"), []);
    state.replaying = true;
    try {
      for (const entry of log) {
        await state.provider.send("evm_setTime", [entry.ts * 1000]);
        if (entry.t === "time") {
          await state.provider.send("evm_mine", []);
        } else {
          try {
            await rawSend(entry.from, entry.method, entry.args);
          } catch (e) {
            console.warn("Replay skipped a transaction", entry, e);
          }
        }
      }
    } finally {
      state.replaying = false;
    }
  }

  async function initLocal() {
    let chainIdHex;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2500);
      const res = await fetch(RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      chainIdHex = (await res.json()).result;
    } catch {
      throw new Error(
        "Local Hardhat node is not running at " + RPC_URL + '. Open a terminal in the "blockchain" folder and run: npm run node'
      );
    }
    state.chainId = Number(chainIdHex);
    state.provider = new ethers.JsonRpcProvider(RPC_URL, ethers.Network.from(state.chainId), {
      staticNetwork: ethers.Network.from(state.chainId),
      pollingInterval: 300,
    });
    state.accounts = (await state.provider.send("eth_accounts", [])).slice(0, 10);

    const abi = state.cfg.artifact.abi;
    const candidates = [];
    const dep = window.LOCAL_DEPLOYMENT;
    if (dep && dep.address && Number(dep.chainId) === state.chainId) candidates.push(dep.address);
    const saved = lsGet(modeKey("address"), null);
    if (saved) candidates.push(saved);

    for (const addr of candidates) {
      if ((await state.provider.getCode(addr)) !== "0x") {
        state.address = addr;
        state.contract = new ethers.Contract(addr, abi, state.provider);
        try {
          if (!(await state.cfg.isSeeded(api))) await state.cfg.seed(api);
          return;
        } catch (e) {
          console.warn("Saved contract is not usable, deploying a new one", e);
        }
      }
    }
    await deployAndSeed();
    // Hardhat block times follow the wall clock; mine once so "now" is fresh.
    await state.provider.send("evm_mine", []);
  }

  async function deployAndSeed() {
    const { abi, bytecode } = state.cfg.artifact;
    const signer = await state.provider.getSigner(state.accounts[0]);
    const deployed = await new ethers.ContractFactory(abi, bytecode, signer).deploy();
    await deployed.waitForDeployment();
    state.address = await deployed.getAddress();
    state.contract = new ethers.Contract(state.address, abi, state.provider);
    if (state.mode === "local") lsSet(modeKey("address"), state.address);
    const wasReplaying = state.replaying;
    state.replaying = true; // seed transactions are re-run on every load, never logged
    try {
      await state.cfg.seed(api);
    } finally {
      state.replaying = wasReplaying;
    }
  }

  // ---------- transactions ----------
  async function rawSend(from, method, args) {
    const signer = await state.provider.getSigner(from);
    const tx = await state.contract.connect(signer)[method](...args);
    return tx.wait();
  }

  /** Send a transaction as `from`. Returns { receipt, block, events }. Throws a friendly Error. */
  async function send(from, method, args = []) {
    let receipt;
    try {
      receipt = await rawSend(from, method, args);
    } catch (e) {
      let cause = e;
      if (!revertOf(e)) {
        // Some nodes hide the revert reason during gas estimation; a dry-run call reveals it.
        try {
          const signer = await state.provider.getSigner(from);
          await state.contract.connect(signer)[method].staticCall(...args);
        } catch (e2) {
          if (revertOf(e2)) cause = e2;
        }
      }
      const err = new Error(explain(cause));
      err.revert = revertOf(cause);
      throw err;
    }
    const block = await state.provider.getBlock(receipt.blockNumber);
    state.offset = block.timestamp - Date.now() / 1000;
    if (state.mode === "browser" && !state.replaying) {
      const log = lsGet(modeKey("txlog"), []);
      log.push({ t: "tx", from, method, args, ts: block.timestamp });
      lsSet(modeKey("txlog"), log);
    }
    const events = [];
    for (const l of receipt.logs) {
      try {
        const parsed = state.contract.interface.parseLog(l);
        if (parsed) events.push(parsed);
      } catch {}
    }
    if (!state.replaying) emit();
    return { receipt, block, events };
  }

  function revertOf(e) {
    if (e && e.revert && e.revert.name) return e.revert;
    const candidates = [
      e?.data,
      e?.info?.error?.data,
      e?.info?.error?.data?.data,
      e?.info?.error?.data?.result, // Ganache puts revert data here
      e?.error?.data,
      e?.error?.data?.data,
    ];
    for (const d of candidates) {
      if (typeof d === "string" && d.startsWith("0x") && d.length >= 10) {
        try {
          const parsed = state.contract.interface.parseError(d);
          if (parsed) return parsed;
        } catch {}
      }
    }
    return null;
  }

  function explain(e) {
    const rev = revertOf(e);
    if (rev) {
      const fn = state.cfg.errors && state.cfg.errors[rev.name];
      return "Blocked by smart contract: " + (fn ? fn(...rev.args) : rev.name);
    }
    if (e?.code === "ACTION_REJECTED") return "Transaction rejected.";
    return e?.shortMessage || e?.message || String(e);
  }

  /** Latest block number, read fresh from the node (ethers caches getBlockNumber for a short time). */
  const blockNumber = async () => Number(await state.provider.send("eth_blockNumber", []));

  // ---------- time ----------
  const now = () => Math.floor(Date.now() / 1000 + state.offset);

  async function fastForward(seconds) {
    await state.provider.send("evm_increaseTime", [Math.floor(seconds)]);
    await state.provider.send("evm_mine", []);
    const block = await state.provider.getBlock("latest");
    state.offset = block.timestamp - Date.now() / 1000;
    if (state.mode === "browser") {
      const log = lsGet(modeKey("txlog"), []);
      log.push({ t: "time", ts: block.timestamp });
      lsSet(modeKey("txlog"), log);
    }
    emit();
  }

  // ---------- reset ----------
  async function reset() {
    if (state.mode === "browser") {
      lsDel(storeKey());
      lsDel(modeKey("txlog"));
      lsDel(modeKey("genesis"));
      location.reload();
      return;
    }
    lsDel(storeKey());
    lsDel(modeKey("address"));
    window.LOCAL_DEPLOYMENT = null;
    await deployAndSeed();
    emit();
  }

  // ---------- off-chain store (simulates file servers / private vaults) ----------
  const store = {
    get(name, fallback) {
      const all = lsGet(storeKey(), {});
      return name in all ? all[name] : fallback;
    },
    set(name, value) {
      const all = lsGet(storeKey(), {});
      all[name] = value;
      lsSet(storeKey(), all);
    },
  };

  // ---------- events ----------
  function onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }
  function emit() {
    for (const fn of listeners) {
      try {
        fn();
      } catch (e) {
        console.error(e);
      }
    }
  }

  function label(addr) {
    if (!addr) return "-";
    const n = state.names[addr.toLowerCase()];
    return n || addr.slice(0, 6) + "…" + addr.slice(-4);
  }
  function setName(addr, name) {
    state.names[addr.toLowerCase()] = name;
  }

  const api = {
    getSavedMode,
    init,
    send,
    explain,
    now,
    blockNumber,
    fastForward,
    reset,
    store,
    onChange,
    label,
    setName,
    get mode() {
      return state.mode;
    },
    get provider() {
      return state.provider;
    },
    get contract() {
      return state.contract;
    },
    get accounts() {
      return state.accounts;
    },
    get address() {
      return state.address;
    },
    get chainId() {
      return state.chainId;
    },
    get replaying() {
      return state.replaying;
    },
  };
  window.Chain = api;
})();
