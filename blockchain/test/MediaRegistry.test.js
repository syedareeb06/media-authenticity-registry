const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const Role = { None: 0, Publisher: 1, FactChecker: 2 };
// SHA3-256 / dHash values are opaque to the contract; any 32-byte / 8-byte values work here.
const sha3Of = (text) => ethers.keccak256(ethers.toUtf8Bytes(text));
const PHASH = "0x0f1e2d3c4b5a6978";
const N = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141"); // secp256k1 order

/** Signs (sha3, pHash) for `registry` exactly like the web app does (EIP-191 personal message). */
async function sign(signer, registry, sha3, pHash = PHASH) {
  const { chainId } = await ethers.provider.getNetwork();
  const digest = ethers.solidityPackedKeccak256(
    ["string", "uint256", "address", "bytes32", "bytes8"],
    ["TrueFrame", chainId, await registry.getAddress(), sha3, pHash]
  );
  return signer.signMessage(ethers.getBytes(digest));
}

describe("MediaRegistry", function () {
  async function deployFixture() {
    const [council, ledger, metro, campus, checker, outsider] = await ethers.getSigners();
    const registry = await ethers.deployContract("MediaRegistry", [], council);
    await registry.registerPublisher(ledger.address, "The Daily Ledger");
    await registry.registerPublisher(metro.address, "Metro News Network");
    await registry.registerPublisher(campus.address, "Campus Times");
    await registry.registerFactChecker(checker.address, "Northbridge Fact-Check Desk");
    return { registry, council, ledger, metro, campus, checker, outsider };
  }

  async function registeredFixture() {
    const f = await deployFixture();
    const sha3 = sha3Of("harbour-at-sunrise.jpg");
    const sig = await sign(f.ledger, f.registry, sha3);
    const capturedAt = (await time.latest()) - 3600;
    await f.registry.connect(f.ledger).registerMedia(sha3, PHASH, "Harbour at sunrise", "Fishing boats return", capturedAt, sig);
    return { ...f, sha3, sig, capturedAt };
  }

  describe("Consortium membership", function () {
    it("makes the deployer the Press Council and lists every member", async function () {
      const { registry, council, ledger, metro, campus, checker } = await loadFixture(deployFixture);
      expect(await registry.pressCouncil()).to.equal(council.address);
      const [accounts, info] = await registry.getMembers();
      expect(accounts).to.deep.equal([ledger.address, metro.address, campus.address, checker.address]);
      expect(info[0].name).to.equal("The Daily Ledger");
      expect(info[0].role).to.equal(Role.Publisher);
      expect(info[3].role).to.equal(Role.FactChecker);
      expect(info[3].active).to.equal(true);
    });

    it("only the Press Council can admit, suspend or re-activate members", async function () {
      const { registry, ledger, outsider } = await loadFixture(deployFixture);
      await expect(registry.connect(outsider).registerPublisher(outsider.address, "Fake News Daily"))
        .to.be.revertedWithCustomError(registry, "NotPressCouncil");
      await expect(registry.connect(ledger).registerFactChecker(outsider.address, "Fake Checker"))
        .to.be.revertedWithCustomError(registry, "NotPressCouncil");
      await expect(registry.connect(ledger).setMemberActive(ledger.address, false))
        .to.be.revertedWithCustomError(registry, "NotPressCouncil");
    });

    it("rejects invalid and duplicate members", async function () {
      const { registry, ledger, outsider } = await loadFixture(deployFixture);
      await expect(registry.registerPublisher(ethers.ZeroAddress, "Nobody"))
        .to.be.revertedWithCustomError(registry, "InvalidMember");
      await expect(registry.registerPublisher(outsider.address, ""))
        .to.be.revertedWithCustomError(registry, "InvalidMember");
      await expect(registry.setMemberActive(outsider.address, false))
        .to.be.revertedWithCustomError(registry, "InvalidMember");
      await expect(registry.registerFactChecker(ledger.address, "Again"))
        .to.be.revertedWithCustomError(registry, "AlreadyMember")
        .withArgs(ledger.address);
    });

    it("emits events when members join or change status", async function () {
      const { registry, metro, outsider } = await loadFixture(deployFixture);
      await expect(registry.registerPublisher(outsider.address, "Valley Gazette"))
        .to.emit(registry, "MemberRegistered")
        .withArgs(outsider.address, Role.Publisher, "Valley Gazette");
      await expect(registry.setMemberActive(metro.address, false))
        .to.emit(registry, "MemberStatusChanged")
        .withArgs(metro.address, false);
      expect((await registry.members(metro.address)).active).to.equal(false);
    });
  });

  describe("Registering media", function () {
    it("stores the hashes, signature and block time of a signed original", async function () {
      const { registry, ledger, sha3, sig, capturedAt } = await loadFixture(registeredFixture);
      const m = await registry.getMedia(0);
      expect(m.sha3Hash).to.equal(sha3);
      expect(m.pHash).to.equal(PHASH);
      expect(m.publisher).to.equal(ledger.address);
      expect(m.capturedAt).to.equal(capturedAt);
      expect(m.registeredAt).to.equal(await time.latest());
      expect(m.signature).to.equal(sig);
      expect(m.revoked).to.equal(false);
      expect(await registry.mediaCount()).to.equal(1);
      expect(await registry.getAllPHashes()).to.deep.equal([PHASH]);
      expect(await registry.getPublisherMedia(ledger.address)).to.deep.equal([0n]);
      const [found, id] = await registry.findBySha3(sha3);
      expect(found).to.equal(true);
      expect(id).to.equal(0);
      const [missing] = await registry.findBySha3(sha3Of("unknown.jpg"));
      expect(missing).to.equal(false);
    });

    it("emits MediaRegistered", async function () {
      const { registry, metro } = await loadFixture(deployFixture);
      const sha3 = sha3Of("skyline.jpg");
      const sig = await sign(metro, registry, sha3);
      await expect(registry.connect(metro).registerMedia(sha3, PHASH, "Skyline", "", 0, sig))
        .to.emit(registry, "MediaRegistered")
        .withArgs(0, metro.address, sha3, PHASH, "Skyline");
    });

    it("only active publishers can register (outsiders and fact-checkers cannot)", async function () {
      const { registry, checker, outsider } = await loadFixture(deployFixture);
      const sha3 = sha3Of("fake.jpg");
      await expect(registry.connect(outsider).registerMedia(sha3, PHASH, "Fake", "", 0, await sign(outsider, registry, sha3)))
        .to.be.revertedWithCustomError(registry, "NotActivePublisher");
      await expect(registry.connect(checker).registerMedia(sha3, PHASH, "Fake", "", 0, await sign(checker, registry, sha3)))
        .to.be.revertedWithCustomError(registry, "NotActivePublisher");
    });

    it("a suspended publisher is blocked until re-activated", async function () {
      const { registry, campus } = await loadFixture(deployFixture);
      const sha3 = sha3Of("clock-tower.jpg");
      const sig = await sign(campus, registry, sha3);
      await registry.setMemberActive(campus.address, false);
      await expect(registry.connect(campus).registerMedia(sha3, PHASH, "Clock tower", "", 0, sig))
        .to.be.revertedWithCustomError(registry, "NotActivePublisher");
      await registry.setMemberActive(campus.address, true);
      await expect(registry.connect(campus).registerMedia(sha3, PHASH, "Clock tower", "", 0, sig)).to.emit(registry, "MediaRegistered");
    });

    it("rejects an image that is already registered, even by another publisher", async function () {
      const { registry, metro, sha3 } = await loadFixture(registeredFixture);
      const sig = await sign(metro, registry, sha3);
      await expect(registry.connect(metro).registerMedia(sha3, PHASH, "Copy", "", 0, sig))
        .to.be.revertedWithCustomError(registry, "DuplicateMedia")
        .withArgs(0);
    });

    it("rejects an empty title or a zero hash", async function () {
      const { registry, ledger } = await loadFixture(deployFixture);
      const sha3 = sha3Of("x.jpg");
      await expect(registry.connect(ledger).registerMedia(sha3, PHASH, "", "", 0, await sign(ledger, registry, sha3)))
        .to.be.revertedWithCustomError(registry, "InvalidMedia");
      await expect(registry.connect(ledger).registerMedia(ethers.ZeroHash, PHASH, "T", "", 0, await sign(ledger, registry, ethers.ZeroHash)))
        .to.be.revertedWithCustomError(registry, "InvalidMedia");
    });

    it("rejects a capture time in the future and accepts it once that time has passed", async function () {
      const { registry, ledger } = await loadFixture(deployFixture);
      const sha3 = sha3Of("future.jpg");
      const sig = await sign(ledger, registry, sha3);
      const later = (await time.latest()) + 3600;
      await expect(registry.connect(ledger).registerMedia(sha3, PHASH, "Future", "", later, sig))
        .to.be.revertedWithCustomError(registry, "CaptureTimeInFuture");
      await time.increase(3600);
      await registry.connect(ledger).registerMedia(sha3, PHASH, "Future", "", later, sig);
      expect((await registry.getMedia(0)).registeredAt).to.be.gte(later);
    });
  });

  describe("ECDSA signature checks (ecrecover)", function () {
    it("messageHash and recoverSigner match the off-chain computation", async function () {
      const { registry, ledger, sha3, sig } = await loadFixture(registeredFixture);
      const { chainId } = await ethers.provider.getNetwork();
      const expected = ethers.solidityPackedKeccak256(
        ["string", "uint256", "address", "bytes32", "bytes8"],
        ["TrueFrame", chainId, await registry.getAddress(), sha3, PHASH]
      );
      expect(await registry.messageHash(sha3, PHASH)).to.equal(expected);
      expect(await registry.recoverSigner(sha3, PHASH, sig)).to.equal(ledger.address);
      expect(ethers.verifyMessage(ethers.getBytes(expected), sig)).to.equal(ledger.address);
    });

    it("rejects a signature made by another publisher", async function () {
      const { registry, ledger, metro } = await loadFixture(deployFixture);
      const sha3 = sha3Of("stolen.jpg");
      const ledgerSig = await sign(ledger, registry, sha3);
      await expect(registry.connect(metro).registerMedia(sha3, PHASH, "Stolen", "", 0, ledgerSig))
        .to.be.revertedWithCustomError(registry, "SignerMismatch")
        .withArgs(ledger.address, metro.address);
    });

    it("rejects a signature when the perceptual hash was changed after signing", async function () {
      const { registry, ledger } = await loadFixture(deployFixture);
      const sha3 = sha3Of("tampered.jpg");
      const sig = await sign(ledger, registry, sha3, PHASH);
      await expect(registry.connect(ledger).registerMedia(sha3, "0x1111111111111111", "Tampered", "", 0, sig))
        .to.be.revertedWithCustomError(registry, "SignerMismatch");
    });

    it("rejects a signature made for a different registry contract (replay)", async function () {
      const { registry, council, ledger } = await loadFixture(deployFixture);
      const other = await ethers.deployContract("MediaRegistry", [], council);
      const sha3 = sha3Of("replay.jpg");
      const sigForOther = await sign(ledger, other, sha3);
      await expect(registry.connect(ledger).registerMedia(sha3, PHASH, "Replay", "", 0, sigForOther))
        .to.be.revertedWithCustomError(registry, "SignerMismatch");
    });

    it("rejects signatures with a wrong length or an invalid v", async function () {
      const { registry, ledger } = await loadFixture(deployFixture);
      const sha3 = sha3Of("bad-sig.jpg");
      const sig = await sign(ledger, registry, sha3);
      await expect(registry.connect(ledger).registerMedia(sha3, PHASH, "T", "", 0, ethers.dataSlice(sig, 0, 64)))
        .to.be.revertedWithCustomError(registry, "InvalidSignatureLength")
        .withArgs(64);
      const badV = ethers.concat([ethers.dataSlice(sig, 0, 64), "0x1d"]); // v = 29
      await expect(registry.connect(ledger).registerMedia(sha3, PHASH, "T", "", 0, badV))
        .to.be.revertedWithCustomError(registry, "InvalidSignatureV")
        .withArgs(29);
    });

    it("rejects malleable (high-s) signatures but accepts v as 0/1", async function () {
      const { registry, ledger } = await loadFixture(deployFixture);
      const sha3 = sha3Of("malleable.jpg");
      const sig = ethers.Signature.from(await sign(ledger, registry, sha3));
      // (r, n - s, flipped v) is the "twin" signature that also recovers to the same key.
      const highS = ethers.toBeHex(N - BigInt(sig.s), 32);
      const twin = ethers.concat([sig.r, highS, sig.v === 27 ? "0x1c" : "0x1b"]);
      await expect(registry.connect(ledger).registerMedia(sha3, PHASH, "T", "", 0, twin))
        .to.be.revertedWithCustomError(registry, "MalleableSignature");
      const zeroOneV = ethers.concat([sig.r, sig.s, sig.v === 27 ? "0x00" : "0x01"]);
      expect(await registry.recoverSigner(sha3, PHASH, zeroOneV)).to.equal(ledger.address);
    });

    it("rejects a signature that recovers to no address", async function () {
      const { registry, ledger } = await loadFixture(deployFixture);
      const sha3 = sha3Of("zero.jpg");
      const empty = ethers.concat([ethers.ZeroHash, ethers.ZeroHash, "0x1b"]);
      await expect(registry.connect(ledger).registerMedia(sha3, PHASH, "T", "", 0, empty))
        .to.be.revertedWithCustomError(registry, "InvalidSignature");
    });
  });

  describe("Revocation and fact-checking", function () {
    it("the publisher can revoke its own record once, with a reason", async function () {
      const { registry, ledger } = await loadFixture(registeredFixture);
      await expect(registry.connect(ledger).revokeMedia(0, ""))
        .to.be.revertedWithCustomError(registry, "ReasonRequired");
      await expect(registry.connect(ledger).revokeMedia(0, "Wrong location in caption"))
        .to.emit(registry, "MediaRevoked")
        .withArgs(0, ledger.address, "Wrong location in caption");
      const m = await registry.getMedia(0);
      expect(m.revoked).to.equal(true);
      expect(m.revokeReason).to.equal("Wrong location in caption");
      await expect(registry.connect(ledger).revokeMedia(0, "again"))
        .to.be.revertedWithCustomError(registry, "AlreadyRevoked")
        .withArgs(0);
    });

    it("nobody else can revoke a publisher's record and unknown ids are rejected", async function () {
      const { registry, council, metro } = await loadFixture(registeredFixture);
      await expect(registry.connect(metro).revokeMedia(0, "not mine"))
        .to.be.revertedWithCustomError(registry, "NotMediaPublisher")
        .withArgs(0);
      await expect(registry.connect(council).revokeMedia(0, "council"))
        .to.be.revertedWithCustomError(registry, "NotMediaPublisher");
      await expect(registry.revokeMedia(7, "x")).to.be.revertedWithCustomError(registry, "UnknownMedia").withArgs(7);
      await expect(registry.getMedia(7)).to.be.revertedWithCustomError(registry, "UnknownMedia");
    });

    it("a fact-checker can dispute a record once", async function () {
      const { registry, checker } = await loadFixture(registeredFixture);
      await expect(registry.connect(checker).flagMedia(0, "Photo is from 2019, caption says today"))
        .to.emit(registry, "MediaFlagged")
        .withArgs(0, checker.address, "Photo is from 2019, caption says today");
      const m = await registry.getMedia(0);
      expect(m.flagged).to.equal(true);
      expect(m.flaggedBy).to.equal(checker.address);
      await expect(registry.connect(checker).flagMedia(0, "again"))
        .to.be.revertedWithCustomError(registry, "AlreadyFlagged");
    });

    it("only active fact-checkers can dispute, and only records that are not revoked", async function () {
      const { registry, ledger, metro, checker } = await loadFixture(registeredFixture);
      await expect(registry.connect(metro).flagMedia(0, "rival"))
        .to.be.revertedWithCustomError(registry, "NotActiveFactChecker");
      await expect(registry.connect(checker).flagMedia(0, ""))
        .to.be.revertedWithCustomError(registry, "ReasonRequired");
      await registry.setMemberActive(checker.address, false);
      await expect(registry.connect(checker).flagMedia(0, "misleading"))
        .to.be.revertedWithCustomError(registry, "NotActiveFactChecker");
      await registry.setMemberActive(checker.address, true);
      await registry.connect(ledger).revokeMedia(0, "withdrawn");
      await expect(registry.connect(checker).flagMedia(0, "misleading"))
        .to.be.revertedWithCustomError(registry, "AlreadyRevoked");
    });

    it("lists the perceptual hashes of all records in id order for the similarity scan", async function () {
      const { registry, metro, campus } = await loadFixture(registeredFixture);
      const a = sha3Of("a.jpg");
      const b = sha3Of("b.jpg");
      await registry.connect(metro).registerMedia(a, "0xaaaaaaaaaaaaaaaa", "A", "", 0, await sign(metro, registry, a, "0xaaaaaaaaaaaaaaaa"));
      await registry.connect(campus).registerMedia(b, "0xbbbbbbbbbbbbbbbb", "B", "", 0, await sign(campus, registry, b, "0xbbbbbbbbbbbbbbbb"));
      expect(await registry.getAllPHashes()).to.deep.equal([PHASH, "0xaaaaaaaaaaaaaaaa", "0xbbbbbbbbbbbbbbbb"]);
      expect(await registry.getPublisherMedia(campus.address)).to.deep.equal([2n]);
    });
  });
});
