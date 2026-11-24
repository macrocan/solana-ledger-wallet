// core.js — pure logic, zero third-party imports.
// Everything here is unit-tested with `npm test` without a browser, RPC or Ledger.

export const U64_MAX = (1n << 64n) - 1n;
export const MAX_AMOUNT_INPUT_LEN = 32;

// Genesis hashes identify the cluster regardless of which RPC URL was typed in.
export const GENESIS = Object.freeze({
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBA",
  testnet: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY",
});

// 浏览器可直连（CORS 放行）且不需要 key 的公共节点。官方 api.mainnet-beta.solana.com
// 对浏览器请求返回假 CORS 头（backend_traffic），不能用；devnet/testnet 官方节点可以。
// publicnode 不支持 getTokenAccountsByOwner 这类索引查询，代币列表需按 mint 手动添加。
export const PUBLIC_RPC = Object.freeze({
  "mainnet-beta": "https://solana-rpc.publicnode.com",
  devnet: "https://api.devnet.solana.com",
  testnet: "https://api.testnet.solana.com",
});

// ---------- priority fee ----------

export const DEFAULT_CU_LIMIT = { SOL: 450, TOKEN: 60_000 }; // 实测上限的 1.5-2 倍，留余量

// 优先费上限（microLamports / CU）。防止误输多个 0 导致天价手续费。
// 100_000_000 microLamports/CU 时最坏（TOKEN 60_000 CU）手续费约 0.006 SOL，仍是真实拥堵价（通常 1万-100万）的 100 倍以上余量，
// 把原本无天花板（12 位数字可到约 60 SOL）压到有限范围。
export const MAX_PRIORITY_MICROLAMPORTS = 100_000_000n;

/** "0" / "1000" microLamports per CU -> bigint; empty = 0. Throws if over MAX_PRIORITY_MICROLAMPORTS. */
export function parseMicroLamports(str) {
  const s = String(str ?? "").trim();
  if (!s) return 0n;
  if (!/^\d{1,9}$/.test(s)) throw new Error("优先费格式不正确（整数 microLamports/CU）");
  const v = BigInt(s);
  if (v > MAX_PRIORITY_MICROLAMPORTS) throw new Error(`优先费过高（上限 ${MAX_PRIORITY_MICROLAMPORTS} microLamports/CU）`);
  return v;
}

/** Priority fee in lamports, rounded up. */
export function priorityFeeLamports(cuLimit, microLamportsPerCu) {
  const total = BigInt(cuLimit) * BigInt(microLamportsPerCu);
  return (total + 999_999n) / 1_000_000n;
}

export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const SYSTEM_PROGRAM = "11111111111111111111111111111111";

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;

// ---------- amounts ----------

/** "1.25" + decimals 6 -> 1250000n. Throws on bad input, too many decimals, or > u64. */
export function parseAmount(str, decimals) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error("decimals 无效");
  const s = String(str ?? "").trim();
  if (!s) throw new Error("请输入数量");
  if (s.length > MAX_AMOUNT_INPUT_LEN) throw new Error("数量过长");
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error("数量格式不正确（只允许数字和小数点）");
  const [int, frac = ""] = s.split(".");
  if (frac.length > decimals) throw new Error(`小数位最多 ${decimals} 位`);
  const raw = BigInt(int + frac.padEnd(decimals, "0"));
  if (raw <= 0n) throw new Error("数量必须大于 0");
  if (raw > U64_MAX) throw new Error("数量超过 u64 上限");
  return raw;
}

/** 1250000n + decimals 6 -> "1.25" (trailing zeros stripped, never scientific notation). */
export function formatAmount(raw, decimals) {
  const r = BigInt(raw);
  if (decimals === 0) return r.toString();
  const s = r.toString().padStart(decimals + 1, "0");
  const int = s.slice(0, -decimals);
  const frac = s.slice(-decimals).replace(/0+$/, "");
  return frac ? `${int}.${frac}` : int;
}

// ---------- network ----------

/** Map a genesis hash to a cluster name, or null if unknown. */
export function clusterFromGenesis(genesisHash) {
  for (const [name, hash] of Object.entries(GENESIS)) if (hash === genesisHash) return name;
  return null;
}

/**
 * Decide whether the RPC we actually connected to matches what the user selected.
 * Returns { ok, cluster, reason }.
 */
export function checkNetwork(selectedCluster, genesisHash) {
  const actual = clusterFromGenesis(genesisHash);
  if (!actual) return { ok: false, cluster: null, reason: `RPC 返回了未知的创世哈希 ${genesisHash}` };
  if (actual !== selectedCluster)
    return { ok: false, cluster: actual, reason: `你选择了 ${selectedCluster}，但这个 RPC 实际是 ${actual}` };
  return { ok: true, cluster: actual, reason: "" };
}

export function explorerTxUrl(signature, cluster) {
  if (!isBase58(signature) || signature.length < 80 || signature.length > 90) throw new Error("签名格式不正确");
  const q = cluster === "mainnet-beta" ? "" : `?cluster=${cluster}`;
  return `https://solscan.io/tx/${signature}${q}`;
}

export function isBase58(s) {
  return typeof s === "string" && BASE58_RE.test(s);
}

// 核对页展示的关键字段：用户在页面上亲眼确认的就是这几个。签名前会拿"即将签的这笔 tx"
// 重新解析一遍，与这些字段逐项比对；任何一项变了都拒绝签名。这挡住了"确认之后、签名之前
// 页面状态被改写（XSS 或注入）导致实际签的是另一笔交易"的路径。
//
// 不比较 `from`：decodeForReview 不输出 sender（它在解析时直接断言转出方必须是 owner，
// 否则抛错），因此比对 from 只会让每一笔正常交易都被误拦。转出方安全由解码器的断言保证。
const SUMMARY_KEY_FIELDS = ["asset", "to", "amount", "mint", "destAta", "sourceAccount", "priorityMicroLamports"];

/**
 * Compare the review-time summary against the freshly re-decoded summary of the tx about to be signed.
 * Returns { ok, reason }. Strict: any missing/differing key field fails closed.
 * Non-key fields (fee, ataRent, display strings, cluster) are intentionally excluded — fee can't
 * be changed by an attacker without changing the message the user already approved on-screen.
 */
export function summariesMatch(reviewed, decoded) {
  const a = reviewed && reviewed.summary ? reviewed.summary : reviewed;
  if (!a || !decoded) return { ok: false, reason: "摘要缺失" };
  for (const k of SUMMARY_KEY_FIELDS) {
    const av = a[k] ?? null;
    const bv = decoded[k] ?? null;
    if (av !== bv) return { ok: false, reason: `核对内容与即将签名的不一致：${k}` };
  }
  return { ok: true, reason: "" };
}

// ---------- assets ----------

/** Stable identity for a token position. Never use array indexes. */
export function assetKey(programId, mint, account) {
  return `${programId}:${mint}:${account}`;
}

export function parseAssetKey(key) {
  const [programId, mint, account] = String(key).split(":");
  if (!programId || !mint || !account) throw new Error("资产标识无效");
  return { programId, mint, account };
}

/**
 * Turn parsed token accounts (as returned by getParsedTokenAccountsByOwner) into
 * a token list. Input shape per entry: { programId, account, mint, amount(string raw), decimals }.
 * Classic SPL positions are sendable; Token-2022 are listed but not sendable (v2 scope).
 * Returns a Map keyed by assetKey. Pure, so a failed RPC call never produces a partial list.
 */
export function buildTokenList(entries) {
  const map = new Map();
  for (const e of entries) {
    if (!isBase58(e.mint) || !isBase58(e.account)) throw new Error("RPC 返回了格式不正确的地址");
    if (!/^\d+$/.test(e.amount)) throw new Error("RPC 返回了格式不正确的余额");
    if (!Number.isInteger(e.decimals) || e.decimals < 0 || e.decimals > 18) throw new Error("RPC 返回了格式不正确的 decimals");
    const raw = BigInt(e.amount);
    if (raw === 0n) continue;
    const sendable = e.programId === TOKEN_PROGRAM;
    const key = assetKey(e.programId, e.mint, e.account);
    map.set(key, {
      key, programId: e.programId, mint: e.mint, account: e.account,
      raw, decimals: e.decimals, display: formatAmount(raw, e.decimals), sendable,
    });
  }
  return map;
}

// ---------- recipient checks ----------

/**
 * Classify a recipient account for a plain wallet transfer.
 * info: null (does not exist) or { ownerProgram, executable, lamports }.
 * onCurve: whether the address is on the ed25519 curve (PDAs are not).
 */
export function checkRecipient({ info, onCurve }) {
  if (!onCurve) return { ok: false, reason: "这不是普通钱包地址（像是 PDA / 关联代币账户）" };
  if (!info) return { ok: true, exists: false };
  if (info.executable) return { ok: false, reason: "这是一个程序地址，不是钱包" };
  if (info.ownerProgram === TOKEN_PROGRAM || info.ownerProgram === TOKEN_2022_PROGRAM)
    return { ok: false, reason: "这是一个代币账户地址，请填钱包主地址" };
  if (info.ownerProgram !== SYSTEM_PROGRAM)
    return { ok: false, reason: `该地址由程序 ${info.ownerProgram} 管理，不是普通钱包` };
  return { ok: true, exists: true };
}

/**
 * Fee / rent / balance precheck. All values are lamports as BigInt.
 * kind: "SOL" | "TOKEN". Returns { ok, needed, reason }.
 */
export function checkSolBudget({ kind, solBalance, amountLamports = 0n, fee, ataRent = 0n, recipientExists = true, rentExemptMin }) {
  let needed = fee + ataRent;
  if (kind === "SOL") {
    needed += amountLamports;
    if (!recipientExists && amountLamports < rentExemptMin)
      return { ok: false, needed, reason: `收款地址尚不存在，首笔转入至少需要 ${formatAmount(rentExemptMin, 9)} SOL 才能免租` };
  }
  const leftover = solBalance - needed;
  if (leftover > 0n && leftover < rentExemptMin)
    return { ok: false, needed, reason: `转出后账户会剩 ${formatAmount(leftover, 9)} SOL，低于免租最低额 ${formatAmount(rentExemptMin, 9)} SOL，链上会拒绝。请少转一点，或把 SOL 全部转出（剩 0）` };
  if (solBalance < needed)
    return { ok: false, needed, reason: `SOL 余额不足：需要约 ${formatAmount(needed, 9)} SOL（含手续费${ataRent ? "和创建代币账户租金" : ""}），当前 ${formatAmount(solBalance, 9)} SOL` };
  return { ok: true, needed, reason: "" };
}

// ---------- Ledger error classification ----------

export function classifyLedgerError(err) {
  const code = err?.statusCode ?? err?.status;
  const msg = String(err?.message ?? err ?? "");
  const hex = Number.isInteger(code) ? "0x" + code.toString(16).padStart(4, "0") : null;
  if (code === 0x6985) return { kind: "rejected", text: "已在 Ledger 上拒绝签名" };
  if (code === 0x5515) return { kind: "locked", text: "Ledger 已锁定，请先解锁" };
  if (code === 0x6e00 || code === 0x6e01 || code === 0x6d00 || /CLA_NOT_SUPPORTED|INS_NOT_SUPPORTED/i.test(msg))
    return { kind: "wrong-app", text: "请在 Ledger 上打开 Solana App" };
  if (code === 0x6a80 || code === 0x6a81)
    return { kind: "unparsable", text: `Ledger 无法解析这笔交易（状态码 ${hex}）。请把 Solana App 更新到最新版；若设备提示需要 Blind signing，说明当前指令组合无法在设备上明文展示，建议不要盲签大额交易。` };
  if (/disconnected|device was disconnected|TransportOpenUserCancelled|No device selected/i.test(msg))
    return { kind: "disconnected", text: "Ledger 已断开或未选择设备" };
  return { kind: "unknown", text: hex ? `Ledger 返回错误 ${hex}：${msg}` : msg };
}

// ---------- send state machine ----------

export const S = Object.freeze({
  IDLE: "IDLE",
  BUILDING: "BUILDING",           // fetching blockhash / prechecks
  REVIEW: "REVIEW",               // decoded tx shown, waiting for user to confirm in page
  SIGNING: "SIGNING",             // waiting for Ledger
  BROADCASTING: "BROADCASTING",   // sendRawTransaction in flight
  PENDING: "PENDING",             // broadcast accepted (or unknown), polling status
  UNKNOWN: "UNKNOWN",             // lost contact after broadcast may have happened
  CONFIRMED: "CONFIRMED",
  FAILED_ONCHAIN: "FAILED_ONCHAIN",
  EXPIRED: "EXPIRED",             // blockhash expired, tx can no longer land
  PRESEND_FAILED: "PRESEND_FAILED", // definitely never reached the network
});

// Only these transitions are allowed; anything else is a programming error.
const TRANSITIONS = {
  IDLE: ["BUILDING"],
  BUILDING: ["REVIEW", "PRESEND_FAILED", "IDLE"],
  REVIEW: ["SIGNING", "IDLE"],
  SIGNING: ["BROADCASTING", "PRESEND_FAILED"],
  BROADCASTING: ["PENDING", "UNKNOWN", "PRESEND_FAILED"],
  PENDING: ["CONFIRMED", "FAILED_ONCHAIN", "EXPIRED", "UNKNOWN"],
  UNKNOWN: ["PENDING", "CONFIRMED", "FAILED_ONCHAIN", "EXPIRED"],
  CONFIRMED: ["IDLE"],
  FAILED_ONCHAIN: ["IDLE"],
  EXPIRED: ["IDLE"],
  PRESEND_FAILED: ["IDLE"],
};

export function createJob() {
  return { state: S.IDLE, history: [S.IDLE] };
}

export function transition(job, next) {
  const allowed = TRANSITIONS[job.state] || [];
  if (!allowed.includes(next)) throw new Error(`非法状态切换 ${job.state} -> ${next}`);
  job.state = next;
  job.history.push(next);
  return job;
}

/** Used only when recovering a persisted in-flight tx after reload; records that the jump was a restore. */
export function restoreState(job, state) {
  if (!(state in TRANSITIONS)) throw new Error(`未知状态 ${state}`);
  job.state = state;
  job.history.push(`RESTORED:${state}`);
  return job;
}

/** States in which it is safe to build and sign a brand-new transaction. */
export function canStartNewSend(state) {
  return state === S.IDLE || state === S.CONFIRMED || state === S.FAILED_ONCHAIN || state === S.EXPIRED || state === S.PRESEND_FAILED;
}

/** States in which the UI must lock network / account / refresh controls. */
export function mustLockSession(state) {
  return !canStartNewSend(state);
}

/**
 * Decide what a sendRawTransaction error means.
 * Preflight simulation failures are reported by the RPC *before* it forwards the tx,
 * so those are definitely not on the network. Anything else: assume it may have gone out.
 */
export function classifyBroadcastError(err) {
  const msg = String(err?.message ?? err ?? "");
  if (/simulation failed|Transaction simulation failed|Blockhash not found|invalid transaction|signature verification failed/i.test(msg))
    return S.PRESEND_FAILED;
  return S.UNKNOWN;
}

// blockhash 过期判定需要连续观测到的次数。RPC 背后常是负载均衡（Helius / QuickNode），
// getBlockHeight 与 getSignatureStatuses 可能落到进度不同的节点：领先节点报高度已越过有效期，
// 落后节点查不到签名。单次观测就判 EXPIRED 会把"其实已上链"的交易误判为过期，引导用户重签造成重复付款。
// 因此要求连续 EXPIRY_CONFIRMATIONS 次都观测到"签名不存在 且 高度已越过有效期"才认定过期。
export const EXPIRY_CONFIRMATIONS = 2;

/**
 * Decide a pending tx's state from getSignatureStatuses + current block height.
 * status: null | { confirmationStatus, err }
 */
export function decideStatus({ status, blockHeight, lastValidBlockHeight }) {
  if (status) {
    const settled = status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized";
    if (!settled) return S.PENDING; // "processed" 块可能被回滚，成功/失败都不算数
    return status.err ? S.FAILED_ONCHAIN : S.CONFIRMED;
  }
  if (blockHeight > lastValidBlockHeight) return S.EXPIRED;
  return S.PENDING;
}

/**
 * Guard the EXPIRED verdict against cross-node height skew.
 * Returns true only after `streak` consecutive observations of "signature missing AND height past lastValidBlockHeight".
 * streak: how many consecutive such observations (including this one) have been seen.
 * threshold: required confirmations (default EXPIRY_CONFIRMATIONS).
 */
export function shouldDeclareExpired({ blockHeight, lastValidBlockHeight, streak, threshold = EXPIRY_CONFIRMATIONS }) {
  return blockHeight > lastValidBlockHeight && streak >= threshold;
}

// ---------- base58 (tiny encoder so we don't add a dependency just for signatures) ----------

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  let zeros = 0;
  while (zeros < b.length && b[zeros] === 0) zeros++;
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  let out = "";
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  return "1".repeat(zeros) + out;
}

// ---------- persisted job record (survives reload) ----------

export const JOB_STORAGE_PREFIX = "sol-ledger-wallet.pending-job.v2";
/** One slot per (cluster, owner): a devnet send must never overwrite a mainnet in-flight record. */
export function jobStorageKey(cluster, owner) {
  if (!GENESIS[cluster] || !isBase58(owner)) throw new Error("storage key 参数无效");
  return `${JOB_STORAGE_PREFIX}:${cluster}:${owner}`;
}

export function serializeJobRecord(rec) {
  const needed = ["signature", "rawTxB64", "blockhash", "lastValidBlockHeight", "cluster", "genesisHash", "owner", "summary", "createdAt"];
  for (const k of needed) if (rec[k] === undefined || rec[k] === null) throw new Error(`job record 缺少 ${k}`);
  if (!isBase58(rec.signature)) throw new Error("签名格式不正确");
  return JSON.stringify(rec);
}

export function parseJobRecord(json) {
  try {
    const rec = JSON.parse(json);
    if (!rec || typeof rec !== "object") return null;
    if (!isBase58(rec.signature) || !isBase58(rec.owner) || typeof rec.rawTxB64 !== "string") return null;
    if (!Number.isInteger(rec.lastValidBlockHeight)) return null;
    if (!GENESIS[rec.cluster] || rec.genesisHash !== GENESIS[rec.cluster]) return null;
    return rec;
  } catch {
    return null;
  }
}
