/* Cryptography used by TrueFrame (everything runs in the browser):
 *  - SHA3-256 (FIPS 202, the real SHA-3, not Ethereum's keccak256) of the exact file bytes
 *  - dHash: a 64-bit perceptual "difference hash" computed from the pixels on a <canvas>
 *  - Hamming distance between two perceptual hashes
 *  - ECDSA (secp256k1) signature by the publisher over both hashes, EIP-191 personal-message format
 */
(function () {
  // ---------------- SHA3-256 ----------------
  // vendor/sha3.min.js (js-sha3, MIT) implements Keccak-f[1600]. SHA3-256 and keccak256
  // differ only in the padding byte (0x06 vs 0x01), which gives completely different digests.
  const SHA3_ABC = "0x3a985da74fe225b2045c172d6bd390bd855f086e3e9d525b46bfe24511431532";

  const sha3 = (data) => "0x" + window.sha3_256(UI.toBytes(data));
  const selfTest = () => sha3("abc") === SHA3_ABC && ethers.keccak256(ethers.toUtf8Bytes("abc")) !== SHA3_ABC;

  // ---------------- dHash (perceptual hash) ----------------
  // 1. Draw the picture onto a 144 x 128 canvas (aspect ratio is ignored on purpose).
  // 2. Convert to grayscale and average 16 x 16 blocks -> a 9 x 8 grid of brightness values.
  // 3. For each row compare neighbours: bit = 1 if the left cell is brighter than the right one.
  //    8 comparisons x 8 rows = 64 bits.
  // Small edits (resize, recompression, brightness, a banner) change few bits; different
  // pictures differ in about half of the 64 bits.
  const GRID_W = 9;
  const GRID_H = 8;
  const CELL = 16;

  function grayGrid(source) {
    const canvas = document.createElement("canvas");
    canvas.width = GRID_W * CELL;
    canvas.height = GRID_H * CELL;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.fillStyle = "#fff"; // transparent pixels count as white
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const grid = new Float64Array(GRID_W * GRID_H);
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        const i = (y * canvas.width + x) * 4;
        const luma = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
        grid[Math.floor(y / CELL) * GRID_W + Math.floor(x / CELL)] += luma;
      }
    }
    for (let i = 0; i < grid.length; i++) grid[i] /= CELL * CELL;
    return grid;
  }

  /** @returns {string} 0x + 16 hex chars (bytes8) */
  function dHash(source) {
    const g = grayGrid(source);
    let bits = 0n;
    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W - 1; x++) {
        bits = (bits << 1n) | (g[y * GRID_W + x] > g[y * GRID_W + x + 1] ? 1n : 0n);
      }
    }
    return "0x" + bits.toString(16).padStart(16, "0");
  }

  /** Number of differing bits between two 64-bit hashes (0 = identical, 64 = all different). */
  function hamming(a, b) {
    let x = BigInt(a) ^ BigInt(b);
    let n = 0;
    while (x) {
      n += Number(x & 1n);
      x >>= 1n;
    }
    return n;
  }

  /** The 64 bits as an array of 0/1, first bit = top-left comparison. */
  const bits = (hex) => BigInt(hex).toString(2).padStart(64, "0").split("").map(Number);

  /** Count how many hex characters differ (to show the avalanche effect of SHA-3). */
  function hexDiff(a, b) {
    let n = 0;
    for (let i = 2; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) n++;
    return n;
  }

  // ---------------- ECDSA signature ----------------
  /** Must match MediaRegistry.messageHash(): binds both hashes to this contract and chain. */
  const messageHash = (sha3Hash, pHash) =>
    ethers.solidityPackedKeccak256(
      ["string", "uint256", "address", "bytes32", "bytes8"],
      ["TrueFrame", Chain.chainId, Chain.address, sha3Hash, pHash]
    );

  let personalSign = true;
  /** The publisher signs with its own account key (wallet "personal_sign", EIP-191). */
  async function sign(address, sha3Hash, pHash) {
    const msg = ethers.getBytes(messageHash(sha3Hash, pHash));
    if (personalSign) {
      try {
        return await (await Chain.provider.getSigner(address)).signMessage(msg);
      } catch (e) {
        if (e.code !== "UNSUPPORTED_OPERATION" && !/personal_sign/.test(e.message || "")) throw e;
        personalSign = false; // the in-browser chain (Ganache) only has eth_sign, which applies the same EIP-191 prefix
      }
    }
    return Chain.provider.send("eth_sign", [address, ethers.hexlify(msg)]);
  }

  /** Recover the signer locally (the same maths as ecrecover in the contract). */
  const recover = (sha3Hash, pHash, signature) => ethers.verifyMessage(ethers.getBytes(messageHash(sha3Hash, pHash)), signature);

  window.TrueFrameCrypto = { sha3, selfTest, SHA3_ABC, dHash, hamming, bits, hexDiff, messageHash, sign, recover };
})();
