// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MediaRegistry - TrueFrame, a deepfake-proof media authenticity registry
/// @notice A consortium of trusted news publishers, admitted by a Press Council,
///         registers ORIGINAL images on the blockchain. Every record anchors three things:
///           1. sha3Hash  - SHA3-256 (FIPS 202) of the exact image file. Any change, even
///                          one pixel or a re-save, gives a completely different hash.
///           2. pHash     - a 64-bit perceptual "difference hash" (dHash) of the picture.
///                          Resized, recompressed or lightly edited copies stay within a
///                          small Hamming distance, so edited copies can still be traced.
///           3. signature - the publisher's ECDSA (secp256k1) signature over both hashes.
///                          This contract checks it with ecrecover, so a record can only be
///                          created with the publisher's private key.
///         Anyone can verify an image with free read-only calls. Fact-checkers can dispute a
///         record and publishers can revoke their own records; nothing is ever deleted.
/// @dev Only hashes, short text and the signature are stored on-chain. The image stays off-chain.
contract MediaRegistry {
    enum Role { None, Publisher, FactChecker }

    struct Member {
        Role role;
        string name;
        bool active;
    }

    struct Media {
        bytes32 sha3Hash;      // SHA3-256 of the exact file bytes
        bytes8 pHash;          // 64-bit dHash of the picture
        address publisher;     // who registered (and signed) it
        uint64 capturedAt;     // when the photo was taken (claimed by the publisher)
        uint64 registeredAt;   // block time of registration (proof of prior existence)
        bool revoked;          // withdrawn by its publisher
        bool flagged;          // disputed by a fact-checker
        address flaggedBy;
        string title;
        string caption;
        string revokeReason;
        string flagReason;
        bytes signature;       // 65-byte ECDSA signature (r, s, v)
    }

    /// @dev Half of the secp256k1 curve order. Signatures with a larger `s` are rejected
    ///      because (r, n - s) is a second valid signature for the same message (EIP-2).
    uint256 private constant HALF_CURVE_ORDER = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    address public immutable pressCouncil;

    mapping(address => Member) public members;
    address[] private memberList;

    Media[] private media;
    mapping(bytes32 => uint256) private idPlusOne; // sha3Hash => id + 1 (0 means "not registered")
    mapping(address => uint256[]) private mediaOf;

    event MemberRegistered(address indexed account, Role role, string name);
    event MemberStatusChanged(address indexed account, bool active);
    event MediaRegistered(uint256 indexed id, address indexed publisher, bytes32 sha3Hash, bytes8 pHash, string title);
    event MediaRevoked(uint256 indexed id, address indexed publisher, string reason);
    event MediaFlagged(uint256 indexed id, address indexed factChecker, string reason);

    error NotPressCouncil();
    error InvalidMember();
    error AlreadyMember(address account);
    error NotActivePublisher();
    error NotActiveFactChecker();
    error InvalidMedia();
    error CaptureTimeInFuture(uint256 capturedAt, uint256 nowTime);
    error DuplicateMedia(uint256 existingId);
    error InvalidSignatureLength(uint256 length);
    error InvalidSignatureV(uint8 v);
    error MalleableSignature();
    error InvalidSignature();
    error SignerMismatch(address recovered, address sender);
    error UnknownMedia(uint256 id);
    error NotMediaPublisher(uint256 id);
    error AlreadyRevoked(uint256 id);
    error AlreadyFlagged(uint256 id);
    error ReasonRequired();

    modifier onlyPressCouncil() {
        if (msg.sender != pressCouncil) revert NotPressCouncil();
        _;
    }

    modifier mediaExists(uint256 id) {
        if (id >= media.length) revert UnknownMedia(id);
        _;
    }

    constructor() {
        pressCouncil = msg.sender;
    }

    // ------------------------------------------------------------------
    // Consortium membership (Module IV: permissioned participants)
    // ------------------------------------------------------------------

    function registerPublisher(address account, string calldata name) external onlyPressCouncil {
        _addMember(account, Role.Publisher, name);
    }

    function registerFactChecker(address account, string calldata name) external onlyPressCouncil {
        _addMember(account, Role.FactChecker, name);
    }

    /// @notice Suspend or re-activate a member. A suspended publisher cannot register new
    ///         media and a suspended fact-checker cannot raise disputes.
    function setMemberActive(address account, bool active) external onlyPressCouncil {
        if (members[account].role == Role.None) revert InvalidMember();
        members[account].active = active;
        emit MemberStatusChanged(account, active);
    }

    function _addMember(address account, Role role, string calldata name) private {
        if (account == address(0) || bytes(name).length == 0) revert InvalidMember();
        if (members[account].role != Role.None) revert AlreadyMember(account);
        members[account] = Member(role, name, true);
        memberList.push(account);
        emit MemberRegistered(account, role, name);
    }

    // ------------------------------------------------------------------
    // Media lifecycle
    // ------------------------------------------------------------------

    /// @notice Register an original image. The caller must be an active publisher and
    ///         `signature` must be the caller's own signature over (sha3Hash, pHash).
    /// @param capturedAt unix time the photo was taken; it cannot be later than this block.
    function registerMedia(
        bytes32 sha3Hash,
        bytes8 pHash,
        string calldata title,
        string calldata caption,
        uint64 capturedAt,
        bytes calldata signature
    ) external returns (uint256 id) {
        Member storage m = members[msg.sender];
        if (m.role != Role.Publisher || !m.active) revert NotActivePublisher();
        if (sha3Hash == bytes32(0) || bytes(title).length == 0) revert InvalidMedia();
        if (capturedAt > block.timestamp) revert CaptureTimeInFuture(capturedAt, block.timestamp);
        if (idPlusOne[sha3Hash] != 0) revert DuplicateMedia(idPlusOne[sha3Hash] - 1);

        // Digital signature check (Module III): only the publisher's private key can produce it.
        address signer = recoverSigner(sha3Hash, pHash, signature);
        if (signer != msg.sender) revert SignerMismatch(signer, msg.sender);

        id = media.length;
        Media storage r = media.push();
        r.sha3Hash = sha3Hash;
        r.pHash = pHash;
        r.publisher = msg.sender;
        r.capturedAt = capturedAt;
        r.registeredAt = uint64(block.timestamp);
        r.title = title;
        r.caption = caption;
        r.signature = signature;

        idPlusOne[sha3Hash] = id + 1;
        mediaOf[msg.sender].push(id);
        emit MediaRegistered(id, msg.sender, sha3Hash, pHash, title);
    }

    /// @notice The original publisher withdraws a record (for example a wrong caption).
    ///         The record stays on-chain, marked as revoked, so verifiers are warned.
    function revokeMedia(uint256 id, string calldata reason) external mediaExists(id) {
        Media storage r = media[id];
        if (r.publisher != msg.sender) revert NotMediaPublisher(id);
        if (r.revoked) revert AlreadyRevoked(id);
        if (bytes(reason).length == 0) revert ReasonRequired();
        r.revoked = true;
        r.revokeReason = reason;
        emit MediaRevoked(id, msg.sender, reason);
    }

    /// @notice An active fact-checker disputes a record (for example a misleading caption).
    function flagMedia(uint256 id, string calldata reason) external mediaExists(id) {
        Member storage m = members[msg.sender];
        if (m.role != Role.FactChecker || !m.active) revert NotActiveFactChecker();
        Media storage r = media[id];
        if (r.revoked) revert AlreadyRevoked(id);
        if (r.flagged) revert AlreadyFlagged(id);
        if (bytes(reason).length == 0) revert ReasonRequired();
        r.flagged = true;
        r.flaggedBy = msg.sender;
        r.flagReason = reason;
        emit MediaFlagged(id, msg.sender, reason);
    }

    // ------------------------------------------------------------------
    // Signatures
    // ------------------------------------------------------------------

    /// @notice The message a publisher signs. It binds both hashes to this contract and
    ///         chain, so a signature cannot be replayed for another image or registry.
    function messageHash(bytes32 sha3Hash, bytes8 pHash) public view returns (bytes32) {
        return keccak256(abi.encodePacked("TrueFrame", block.chainid, address(this), sha3Hash, pHash));
    }

    /// @notice Who signed (sha3Hash, pHash)? Uses the EIP-191 "personal message" format that
    ///         wallets apply: keccak256("\x19Ethereum Signed Message:\n32" || messageHash).
    function recoverSigner(bytes32 sha3Hash, bytes8 pHash, bytes calldata signature) public view returns (address) {
        bytes32 digest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash(sha3Hash, pHash)));
        return _recover(digest, signature);
    }

    /// @dev Splits a 65-byte signature into (r, s, v) and calls the ecrecover precompile.
    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address signer) {
        if (sig.length != 65) revert InvalidSignatureLength(sig.length);
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (v < 27) v += 27; // some signers use 0/1 instead of 27/28
        if (v != 27 && v != 28) revert InvalidSignatureV(v);
        if (uint256(s) > HALF_CURVE_ORDER) revert MalleableSignature();
        signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert InvalidSignature();
    }

    // ------------------------------------------------------------------
    // Views (free for anyone: verification needs no account)
    // ------------------------------------------------------------------

    function mediaCount() external view returns (uint256) {
        return media.length;
    }

    function getMedia(uint256 id) external view mediaExists(id) returns (Media memory) {
        return media[id];
    }

    /// @notice Exact-match lookup by SHA3-256.
    function findBySha3(bytes32 sha3Hash) external view returns (bool found, uint256 id) {
        uint256 v = idPlusOne[sha3Hash];
        if (v == 0) return (false, 0);
        return (true, v - 1);
    }

    /// @notice All perceptual hashes, in id order, for the similarity (Hamming distance) scan.
    function getAllPHashes() external view returns (bytes8[] memory hashes) {
        hashes = new bytes8[](media.length);
        for (uint256 i = 0; i < media.length; i++) hashes[i] = media[i].pHash;
    }

    function getPublisherMedia(address publisher) external view returns (uint256[] memory) {
        return mediaOf[publisher];
    }

    function getMembers() external view returns (address[] memory accounts, Member[] memory info) {
        accounts = memberList;
        info = new Member[](memberList.length);
        for (uint256 i = 0; i < memberList.length; i++) info[i] = members[memberList[i]];
    }
}
