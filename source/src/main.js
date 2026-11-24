// main.js — wires core.js to web3.js, spl-token and the Ledger transport.
// Rules enforced here:
//   * network is verified by genesis hash and frozen into the session at connect time
//   * tokens are keyed, replaced atomically, and marked stale on any failure
//   * the send flow is a state machine; a signed tx is persisted before broadcast
//   * nothing from RPC is ever written with innerHTML

import { Buffer } from "buffer";
import {
  Connection, PublicKey, Transaction, SystemProgram, SystemInstruction, ComputeBudgetProgram, ComputeBudgetInstruction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, ACCOUNT_SIZE,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction, decodeTransferCheckedInstruction,
} from "@solana/spl-token";
import TransportWebHID from "@ledgerhq/hw-transport-webhid";
import Solana from "@ledgerhq/hw-app-solana";
import * as C from "./core.js";

if (!globalThis.Buffer) globalThis.Buffer = Buffer;

// ---------- tiny DOM helpers (textContent only) ----------
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); };
function log(msg, cls = "") {
  const box = $("log");
  const line = el("div", cls, `[${new Date().toLocaleTimeString()}] ${msg}`);
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}
function linkTo(url, text) { const a = el("a", "", text ?? url); a.href = url; a.target = "_blank"; a.rel = "noopener noreferrer"; return a; }

// ---------- session: frozen after connect ----------
let session = null;      // { transport, ledger, owner(PublicKey), ownerB58, path, cluster, genesisHash, rpcUrl, connection }
let tokens = null;       // Map<assetKey, token> | null when stale/unknown
let solLamports = null;  // bigint | null when stale
let tokenListError = null; // RPC 不支持代币索引时的提示；此时只允许 SOL 转账与手动添加的代币
let manualMints = new Set(); // 用户按 mint 手动添加的代币（节点不支持索引查询时）
let refreshSeq = 0;
let job = C.createJob(); // send state machine
let draft = null;        // { tx, summary, blockhash, lastValidBlockHeight, assetKey } between REVIEW and SIGNING
let active = null;       // persisted job record of the in-flight tx
let pollTimer = null;
let pollGen = 0;         // bumping this cancels any in-flight polling loop
let deviceGone = false;  // transport reported disconnect while a tx was in flight

// ---------- UI locking ----------
function applyLocks() {
  const connected = !!session;
  const locked = C.mustLockSession(job.state);
  $("cluster").disabled = connected;
  $("rpc").disabled = connected;
  $("path").disabled = connected;
  $("btnConnect").disabled = connected;
  $("btnDisconnect").disabled = !connected || locked;
  $("btnRefresh").disabled = !connected || locked;
  const sendable = connected && !locked && tokens !== null && solLamports !== null;
  $("btnBuild").disabled = !sendable;
  $("asset").disabled = !sendable;
  $("to").disabled = !sendable;
  $("amount").disabled = !sendable;
  $("cardReview").hidden = job.state !== C.S.REVIEW;
}

function setState(next) {
  C.transition(job, next);
  renderJob();
  applyLocks();
}

// ---------- connect / disconnect ----------
async function connect() {
  $("btnConnect").disabled = true;
  $("netStatus").textContent = "";
  let transport = null;
  try {
    if (!navigator.hid) throw new Error("当前浏览器不支持 WebHID，请用 Chrome / Edge 桌面版");
    const cluster = $("cluster").value;
    const rpcUrl = $("rpc").value.trim() || C.PUBLIC_RPC[cluster];
    if (!/^https:\/\//.test(rpcUrl)) throw new Error("RPC 地址必须是 https://");
    const path = $("path").value.trim();
    if (!/^44'\/501'(\/\d+')*$/.test(path)) throw new Error("派生路径格式不正确，例如 44'/501'/0'/0'");

    // 1. verify the network BEFORE touching the device
    const connection = new Connection(rpcUrl, { commitment: "confirmed" });
    log(`校验 RPC 网络：${rpcUrl}`);
    const genesisHash = await connection.getGenesisHash();
    const net = C.checkNetwork(cluster, genesisHash);
    if (!net.ok) throw new Error(net.reason);
    $("netStatus").textContent = `✓ RPC 创世哈希与 ${cluster} 一致`;

    // 2. open the device and ask it to display the address for the user to verify
    transport = await TransportWebHID.create();
    const ledger = new Solana(transport);
    log(`读取地址（路径 ${path}），请在 Ledger 屏幕上核对并确认…`);
    const { address } = await ledger.getAddress(path, true);
    const owner = new PublicKey(address);

    session = Object.freeze({ transport, ledger, owner, ownerB58: owner.toBase58(), path, cluster, genesisHash, rpcUrl, connection });
    deviceGone = false;
    transport.on("disconnect", () => {
      deviceGone = true;
      if (C.mustLockSession(job.state)) { log("Ledger 已断开。链上状态查询不受影响；本笔结束后需要重新连接", "warn"); return; }
      log("Ledger 已断开", "warn"); disconnect(true);
    });

    $("address").textContent = session.ownerB58;
    $("netLabel").textContent = `${cluster} · ${rpcUrl}`;
    $("cardAccount").hidden = false;
    $("cardSend").hidden = false;
    log(`已连接：${session.ownerB58}`, "ok");
    applyLocks();
    await refresh();
    recoverPendingJob();
  } catch (e) {
    const info = C.classifyLedgerError(e);
    log(`连接失败：${info.text}`, "err");
    session = null;
    try { await transport?.close(); } catch {}
  } finally {
    applyLocks();
  }
}

async function disconnect(silent = false) {
  if (C.mustLockSession(job.state) && !silent) { log("有交易在进行中，不能断开", "err"); return; }
  stopPolling();
  try { await session?.transport?.close(); } catch {}
  session = null; tokens = null; solLamports = null; draft = null;
  $("cardAccount").hidden = true; $("cardSend").hidden = true; $("cardReview").hidden = true;
  $("address").textContent = ""; $("sol").textContent = "–"; clear($("tokens")); clear($("asset"));
  $("netStatus").textContent = "";
  if (!silent) log("已断开");
  applyLocks();
}

// ---------- balances: fetch everything into locals, replace atomically ----------
async function refresh() {
  if (!session) return;
  const seq = ++refreshSeq;
  const s = session;
  $("refreshStatus").textContent = "刷新中…";
  // mark stale immediately: no send may use old data while a refresh is in flight
  tokens = null; solLamports = null; applyLocks();
  try {
    const lamports = BigInt(await s.connection.getBalance(s.owner, "confirmed"));
    const entries = [];
    let listErr = null;
    try {
      for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
        const res = await s.connection.getParsedTokenAccountsByOwner(s.owner, { programId }, "confirmed");
        for (const { pubkey, account } of res.value) {
          const info = account?.data?.parsed?.info;
          if (!info?.tokenAmount) throw new Error("RPC 返回了无法解析的代币账户");
          entries.push({ programId: programId.toBase58(), account: pubkey.toBase58(), mint: String(info.mint), amount: String(info.tokenAmount.amount), decimals: Number(info.tokenAmount.decimals) });
        }
      }
    } catch (e) {
      // 公共节点（如 publicnode）不提供按 owner 的索引查询：不阻塞 SOL 转账，代币改为按 mint 手动添加
      listErr = `该节点不支持代币列表查询（${String(e?.message || e).slice(0, 80)}）。SOL 可正常转账；代币请在下方按 mint 添加`;
    }
    // 手动添加的 mint：直接读 owner 的 ATA（getAccountInfo 不需要索引）
    for (const mint of manualMints) {
      const ata = getAssociatedTokenAddressSync(new PublicKey(mint), s.owner, false, TOKEN_PROGRAM_ID);
      const ai = await s.connection.getParsedAccountInfo(ata, "confirmed");
      const info = ai.value?.data?.parsed?.info;
      if (!info?.tokenAmount) continue; // 没有这个代币账户
      if (!entries.some((x) => x.account === ata.toBase58()))
        entries.push({ programId: TOKEN_PROGRAM_ID.toBase58(), account: ata.toBase58(), mint, amount: String(info.tokenAmount.amount), decimals: Number(info.tokenAmount.decimals) });
    }
    const next = C.buildTokenList(entries);
    tokenListError = listErr;
    if (seq !== refreshSeq || session !== s) return; // a newer refresh or a disconnect superseded us

    solLamports = lamports; tokens = next;
    $("sol").textContent = C.formatAmount(lamports, 9);
    renderTokens();
    $("refreshStatus").textContent = `已更新 ${new Date().toLocaleTimeString()}`;
    log("余额已刷新");
  } catch (e) {
    if (seq !== refreshSeq) return;
    tokens = null; solLamports = null;
    $("refreshStatus").textContent = "刷新失败，余额已标记为过期，请重试";
    clear($("tokens")); clear($("asset"));
    log(`读取余额失败：${e?.message || e}`, "err");
  } finally {
    applyLocks();
  }
}

function renderTokens() {
  const list = $("tokens"); clear(list);
  const sel = $("asset"); clear(sel);
  const solOpt = el("option", "", `SOL · 余额 ${C.formatAmount(solLamports, 9)}`); solOpt.value = "SOL"; sel.appendChild(solOpt);
  if (tokenListError) list.appendChild(el("div", "hint warn", tokenListError));
  if (tokens.size === 0) { list.appendChild(el("div", "hint", tokenListError ? "（手动添加的 mint 若没有余额也不会显示）" : "没有代币余额")); return; }
  for (const t of tokens.values()) {
    const row = el("div", "tok");
    row.appendChild(el("span", "m", `mint ${t.mint}`));
    row.appendChild(el("span", "amt", t.display));
    row.appendChild(el("span", "m", `账户 ${t.account}`));
    row.appendChild(el("span", "tag", t.sendable ? "" : "Token-2022 · 本版本暂不支持转出"));
    list.appendChild(row);
    if (t.sendable) {
      const o = el("option", "", `${t.mint.slice(0, 6)}…${t.mint.slice(-6)} · 余额 ${t.display} · 账户 …${t.account.slice(-6)}`);
      o.value = t.key; sel.appendChild(o);
    }
  }
}

// ---------- build + review ----------
async function build() {
  if (!session || !C.canStartNewSend(job.state)) return;
  if (job.state !== C.S.IDLE) setState(C.S.IDLE);
  if (tokens === null || solLamports === null) return log("余额已过期，请先刷新", "err");
  const s = session, snapTokens = tokens, snapSol = solLamports;
  setState(C.S.BUILDING);
  try {
    const toStr = $("to").value.trim();
    let to;
    try { to = new PublicKey(toStr); } catch { throw new Error("收款地址格式不正确"); }
    if (to.equals(s.owner)) throw new Error("收款地址不能是自己");
    const toInfo = await s.connection.getAccountInfo(to, "confirmed");
    const rc = C.checkRecipient({
      onCurve: PublicKey.isOnCurve(to.toBytes()),
      info: toInfo ? { ownerProgram: toInfo.owner.toBase58(), executable: toInfo.executable, lamports: toInfo.lamports } : null,
    });
    if (!rc.ok) throw new Error(`收款地址不合适：${rc.reason}`);

    const assetSel = $("asset").value;
    const tx = new Transaction();
    const summary = { kind: null, from: s.ownerB58, to: to.toBase58(), cluster: s.cluster };
    let amountLamports = 0n, ataRent = 0n;

    if (assetSel === "SOL") {
      amountLamports = C.parseAmount($("amount").value, 9);
      tx.add(SystemProgram.transfer({ fromPubkey: s.owner, toPubkey: to, lamports: amountLamports }));
      summary.kind = "SOL";
    } else {
      const t = snapTokens.get(assetSel);
      if (!t || !t.sendable) throw new Error("所选资产已不在当前余额列表中，请刷新后重选");
      const amount = C.parseAmount($("amount").value, t.decimals);
      if (amount > t.raw) throw new Error(`余额不足：该账户余额 ${t.display}`);
      const mint = new PublicKey(t.mint), source = new PublicKey(t.account);
      const destAta = getAssociatedTokenAddressSync(mint, to, false, TOKEN_PROGRAM_ID);
      const destInfo = await s.connection.getAccountInfo(destAta, "confirmed");
      // 存在但不是 Token Program 的账户（例如有人往 ATA 地址转过 SOL）仍需用 idempotent 指令创建
      if (!destInfo || !destInfo.owner.equals(TOKEN_PROGRAM_ID)) {
        tx.add(createAssociatedTokenAccountIdempotentInstruction(s.owner, destAta, to, mint, TOKEN_PROGRAM_ID));
        ataRent = BigInt(await s.connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE));
      }
      tx.add(createTransferCheckedInstruction(source, mint, destAta, s.owner, amount, t.decimals, [], TOKEN_PROGRAM_ID));
      summary.kind = "TOKEN";
    }

    // 优先费（可选）：ComputeBudget 两条指令放最前；Ledger Solana App 1.4+ 可明文显示
    const microLamports = C.parseMicroLamports($("priority").value);
    const cuLimit = C.DEFAULT_CU_LIMIT[summary.kind];
    let priorityFee = 0n;
    if (microLamports > 0n) {
      tx.instructions.unshift(
        ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
      );
      priorityFee = C.priorityFeeLamports(cuLimit, microLamports);
    }

    const { blockhash, lastValidBlockHeight } = await s.connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash; tx.feePayer = s.owner;
    const feeRes = await s.connection.getFeeForMessage(tx.compileMessage(), "confirmed");
    if (feeRes.value == null) throw new Error("无法估算手续费（blockhash 可能已过期），请重试");
    // getFeeForMessage 在不同节点版本上可能含/不含优先费；按"基础费 + 优先费"保守预算
    const fee = BigInt(feeRes.value) + priorityFee;
    const rentExemptMin = BigInt(await s.connection.getMinimumBalanceForRentExemption(0));
    const budget = C.checkSolBudget({ kind: summary.kind, solBalance: snapSol, amountLamports, fee, ataRent, recipientExists: rc.exists, rentExemptMin });
    if (!budget.ok) throw new Error(budget.reason);

    // Decode what we actually built, from the Transaction object, not from the inputs.
    const decoded = decodeForReview(tx, s.owner);
    Object.assign(summary, decoded, { fee: C.formatAmount(fee, 9), ataRent: ataRent ? C.formatAmount(ataRent, 9) : null, priority: priorityFee ? `${microLamports} microLamports/CU，上限 ${cuLimit} CU，最多 ${C.formatAmount(priorityFee, 9)} SOL` : null });
    if (decoded.asset === "SOL" && decoded.to !== to.toBase58()) throw new Error("内部校验失败：解析出的收款地址与输入不一致");
    if (decoded.asset === "TOKEN") {
      // the ATA inside the real instruction must derive from the wallet address we display
      const expect = getAssociatedTokenAddressSync(new PublicKey(decoded.mint), to, false, TOKEN_PROGRAM_ID).toBase58();
      if (decoded.destAta !== expect) throw new Error("内部校验失败：代币收款账户不是该钱包的关联账户");
      summary.to = to.toBase58();
    }

    // Freeze the reviewed summary so post-confirm tampering can't silently rewrite what the user saw.
    // The real defence is in sign(): it re-decodes the tx it is about to sign and compares against
    // this frozen summary. (draft/tx stay mutable — sign() refreshes blockhash fields before signing.)
    const reviewed = Object.freeze({ ...summary });
    draft = { tx, summary: reviewed, blockhash, lastValidBlockHeight };
    renderReview(reviewed);
    setState(C.S.REVIEW);
  } catch (e) {
    draft = null;
    log(`构建失败：${e?.message || e}`, "err");
    setState(C.S.IDLE);
  }
}

/** Walk the real instructions and extract what the user must verify. */
function decodeForReview(tx, owner) {
  const out = { ataCreate: null };
  for (const ix of tx.instructions) {
    const pid = ix.programId;
    if (pid.equals(SystemProgram.programId)) {
      const d = SystemInstruction.decodeTransfer(ix);
      if (!d.fromPubkey.equals(owner)) throw new Error("内部校验失败：SOL 转出方不是当前账户");
      out.to = d.toPubkey.toBase58(); out.amount = C.formatAmount(BigInt(d.lamports), 9); out.asset = "SOL";
    } else if (pid.equals(TOKEN_PROGRAM_ID)) {
      const d = decodeTransferCheckedInstruction(ix, TOKEN_PROGRAM_ID);
      if (!d.keys.owner.pubkey.equals(owner)) throw new Error("内部校验失败：代币转出方不是当前账户");
      out.mint = d.keys.mint.pubkey.toBase58();
      out.amount = C.formatAmount(d.data.amount, d.data.decimals);
      out.destAta = d.keys.destination.pubkey.toBase58();
      out.sourceAccount = d.keys.source.pubkey.toBase58();
      out.asset = "TOKEN";
    } else if (pid.equals(ComputeBudgetProgram.programId)) {
      const t = ComputeBudgetInstruction.decodeInstructionType(ix);
      if (t !== "SetComputeUnitLimit" && t !== "SetComputeUnitPrice") throw new Error(`内部校验失败：预期外的 ComputeBudget 指令 ${t}`);
      if (t === "SetComputeUnitPrice") out.priorityMicroLamports = String(ComputeBudgetInstruction.decodeSetComputeUnitPrice(ix).microLamports);
    } else if (pid.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
      // keys: [payer, ata, owner, mint, system, token]
      if (!ix.keys[0].pubkey.equals(owner)) throw new Error("内部校验失败：ATA 付款方不是当前账户");
      out.ataCreate = { ata: ix.keys[1].pubkey.toBase58(), owner: ix.keys[2].pubkey.toBase58(), mint: ix.keys[3].pubkey.toBase58() };
    } else {
      throw new Error(`内部校验失败：交易中出现了预期外的程序 ${pid.toBase58()}`);
    }
  }
  if (out.asset === "TOKEN") {
    // the token destination must be the ATA of the wallet address we are reviewing
    const walletTo = out.ataCreate?.owner ?? null;
    if (walletTo) {
      const expect = getAssociatedTokenAddressSync(new PublicKey(out.mint), new PublicKey(walletTo), false, TOKEN_PROGRAM_ID).toBase58();
      if (expect !== out.destAta || out.ataCreate.mint !== out.mint) throw new Error("内部校验失败：ATA 与收款方不匹配");
      out.to = walletTo;
    }
  }
  return out;
}

function renderReview(sm) {
  const body = $("reviewBody"); clear(body);
  const notice = el("div", "review-warn", "⚠ 本页面应只来自你自行构建或官方发布的 index.html 文件。若你是从他人发来的链接打开，请先关掉、改用可信来源的同一文件。最终以 Ledger 屏幕显示为准。");
  body.appendChild(notice);
  const row = (k, v, big = false) => { const r = el("div", "review-row"); r.appendChild(el("span", "k", k)); r.appendChild(el("span", big ? "v big" : "v", v)); body.appendChild(r); };
  row("网络", sm.cluster);
  row("从", sm.from);
  row("到（钱包）", sm.to, true);
  if (sm.asset === "SOL") row("数量", `${sm.amount} SOL`, true);
  else { row("代币 mint", sm.mint); row("数量", sm.amount, true); row("转出账户", sm.sourceAccount); row("收款代币账户", sm.destAta); }
  if (sm.ataCreate) row("自动创建 ATA", `是，租金约 ${sm.ataRent} SOL（你支付）`);
  row("手续费（含优先费上限）", `${sm.fee} SOL`);
  if (sm.priority) row("优先费", sm.priority);
  row("请核对", "Ledger 屏幕上显示的收款地址和数量必须与上面一致。");
}

function cancelReview() { draft = null; setState(C.S.IDLE); log("已取消"); }

// ---------- sign + broadcast ----------
async function sign() {
  if (job.state !== C.S.REVIEW || !draft || !session) return;
  const s = session, d = draft; draft = null;
  setState(C.S.SIGNING);
  let record;
  try {
    // Re-decode the exact tx we are about to sign and compare against what the user confirmed on the
    // review page. Catches any post-confirm tampering that swapped instructions before we hand it to
    // the Ledger. Falls closed: a mismatch aborts signing and never reaches the device.
    let decodedNow;
    try { decodedNow = decodeForReview(d.tx, s.owner); } catch (e) { throw new Error(`签名前复核失败：${e?.message || e}`); }
    const match = C.summariesMatch(d.summary, decodedNow);
    if (!match.ok) throw new Error(match.reason);
    log("请在 Ledger 上核对并确认交易…");
    // 核对可能花几分钟，签名前重新取 blockhash，减少"签完就过期"；交易内容不变
    const fresh = await s.connection.getLatestBlockhash("confirmed");
    d.tx.recentBlockhash = fresh.blockhash; d.blockhash = fresh.blockhash; d.lastValidBlockHeight = fresh.lastValidBlockHeight;
    const message = d.tx.serializeMessage();
    const { signature } = await s.ledger.signTransaction(s.path, message);
    d.tx.addSignature(s.owner, Buffer.from(signature));
    const raw = d.tx.serialize(); // verifies the signature; throws if it doesn't match owner
    const sig = C.base58Encode(Uint8Array.from(signature));
    record = {
      signature: sig, rawTxB64: Buffer.from(raw).toString("base64"),
      blockhash: d.blockhash, lastValidBlockHeight: d.lastValidBlockHeight,
      cluster: s.cluster, genesisHash: s.genesisHash, owner: s.ownerB58,
      summary: d.summary, createdAt: Date.now(),
    };
    // Persist BEFORE broadcast: if the tab dies mid-send we can still find this tx.
    localStorage.setItem(C.jobStorageKey(s.cluster, s.ownerB58), C.serializeJobRecord(record));
    active = record;
    log(`签名完成：${sig}`);
  } catch (e) {
    const info = C.classifyLedgerError(e);
    log(`签名失败：${info.text}`, "err");
    setState(C.S.PRESEND_FAILED);
    return;
  }
  setState(C.S.BROADCASTING);
  await broadcast(record, true);
}

async function broadcast(record, first) {
  const s = session;
  try {
    const sig = await s.connection.sendRawTransaction(Buffer.from(record.rawTxB64, "base64"), { skipPreflight: !first, preflightCommitment: "confirmed", maxRetries: 0 });
    if (sig !== record.signature) throw new Error(`RPC 返回的签名 ${sig} 与本地签名不一致`);
    log(first ? `已广播：${sig}` : `已重发：${sig}`);
    if (job.state !== C.S.PENDING) setState(C.S.PENDING);
  } catch (e) {
    const next = C.classifyBroadcastError(e);
    if (next === C.S.PRESEND_FAILED && first) {
      log(`广播被拒（交易未进入网络）：${e?.message || e}`, "err");
      localStorage.removeItem(C.jobStorageKey(record.cluster, record.owner)); active = null;
      setState(C.S.PRESEND_FAILED);
      return;
    }
    log(`广播结果未知：${e?.message || e}。交易可能已发出，正在查询链上状态…`, "warn");
    if (job.state !== C.S.UNKNOWN) setState(C.S.UNKNOWN);
  }
  startPolling(record);
}

// ---------- status polling: never declares failure without evidence ----------
function stopPolling() { pollGen++; if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; } }

function startPolling(record) {
  stopPolling();
  const gen = ++pollGen;
  let tick = 0;
  let expiryStreak = 0; // consecutive "signature missing AND height past expiry" observations
  const loop = async () => {
    pollTimer = null;
    if (!session || active !== record || gen !== pollGen) return;
    try {
      // 先读区块高度，再查签名状态（同单节点内先高度后状态可避免"先查空后超期"的误判）。
      // 但跨节点（LB）仍可能高度领先、状态落后，所以 EXPIRED 还要经 shouldDeclareExpired 二次确认。
      const height = await session.connection.getBlockHeight("confirmed");
      const st = await session.connection.getSignatureStatuses([record.signature], { searchTransactionHistory: true });
      if (gen !== pollGen) return;
      const status = st.value[0] ? { confirmationStatus: st.value[0].confirmationStatus, err: st.value[0].err } : null;
      const next = C.decideStatus({ status, blockHeight: height, lastValidBlockHeight: record.lastValidBlockHeight });
      if (next === C.S.CONFIRMED) { finish(C.S.CONFIRMED, "交易已确认 ✅"); return; }
      if (next === C.S.FAILED_ONCHAIN) { finish(C.S.FAILED_ONCHAIN, `链上执行失败：${JSON.stringify(status.err)}`); return; }
      if (next === C.S.EXPIRED) {
        expiryStreak++;
        // 连续足够多次都查不到，才认定过期；否则继续轮询（宁可多等，也不误导重签）
        if (C.shouldDeclareExpired({ blockHeight: height, lastValidBlockHeight: record.lastValidBlockHeight, streak: expiryStreak })) {
          finish(C.S.EXPIRED, "blockhash 已过期且链上未见该签名，这笔交易不会再被打包。可以安全地重新构建一笔新交易。");
          return;
        }
      } else if (status) {
        expiryStreak = 0; // 一旦看到签名，重置过期计数
      }
      if (job.state === C.S.UNKNOWN) setState(C.S.PENDING);
      // still pending: rebroadcast the SAME signed bytes every few ticks (idempotent)
      if (!status && tick > 0 && tick % 3 === 0) { try { await session.connection.sendRawTransaction(Buffer.from(record.rawTxB64, "base64"), { skipPreflight: true, maxRetries: 0 }); } catch {} }
    } catch (e) {
      if (gen !== pollGen) return;
      log(`查询状态失败，稍后重试：${e?.message || e}`, "warn");
      if (job.state !== C.S.UNKNOWN) setState(C.S.UNKNOWN);
    }
    if (gen !== pollGen) return;
    tick++;
    pollTimer = setTimeout(loop, Math.min(2000 + tick * 500, 8000));
  };
  loop();
}

function finish(state, msg) {
  stopPolling();
  log(msg, state === C.S.CONFIRMED ? "ok" : "err");
  if (active) localStorage.removeItem(C.jobStorageKey(active.cluster, active.owner));
  setState(state);
  if (state === C.S.CONFIRMED) refresh();
}

// ---------- pending job recovery after reload ----------
function recoverPendingJob() {
  // 其它 (cluster, owner) 的未完结记录只提示，不处理，也不会被本账户的发送覆盖
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(C.JOB_STORAGE_PREFIX + ":") && k !== C.jobStorageKey(session.cluster, session.ownerB58))
      log(`另有未完结交易记录：${k.slice(C.JOB_STORAGE_PREFIX.length + 1)}，切到对应网络/账户后会继续查询`, "warn");
  }
  const rec = C.parseJobRecord(localStorage.getItem(C.jobStorageKey(session.cluster, session.ownerB58)) || "");
  if (!rec) return;
  active = rec;
  log(`发现上次未完结的交易 ${rec.signature}，先查询其状态再允许新的转账`, "warn");
  C.restoreState(job, C.S.UNKNOWN); renderJob(); applyLocks();
  startPolling(rec);
}

// ---------- job panel ----------
const STATE_TEXT = {
  IDLE: ["", ""], BUILDING: ["构建中", "warn"], REVIEW: ["等待你核对", "warn"], SIGNING: ["等待 Ledger 签名", "warn"],
  BROADCASTING: ["广播中", "warn"], PENDING: ["待确认（已广播）", "warn"], UNKNOWN: ["状态未知，正在查询链上记录", "warn"],
  CONFIRMED: ["已确认", "ok"], FAILED_ONCHAIN: ["链上执行失败", "err"], EXPIRED: ["已过期（未上链）", "err"], PRESEND_FAILED: ["签名前/广播前失败（未上链）", "err"],
};
function renderJob() {
  const card = $("cardJob");
  const show = job.state !== C.S.IDLE && job.state !== C.S.BUILDING && job.state !== C.S.REVIEW;
  card.hidden = !show;
  if (!show) return;
  const [text, cls] = STATE_TEXT[job.state];
  const st = $("jobState"); st.textContent = text; st.className = `state ${cls}`;
  $("jobSig").textContent = active?.signature || "（尚未签名）";
  const link = $("jobLink"); clear(link);
  if (active?.signature) { try { link.appendChild(linkTo(C.explorerTxUrl(active.signature, active.cluster), "在 Solscan 查看")); } catch {} }
  const hints = {
    PENDING: "页面会自动轮询并在有效期内重发同一份已签名交易。不要重新发起新的转账。",
    UNKNOWN: "与 RPC 的通信中断过。交易可能已经上链，正在用原签名查询；在确认结果前不要重新签名。",
    CONFIRMED: "可以发起新的转账。",
    FAILED_ONCHAIN: "交易已被打包但执行失败，资金未转出（手续费已扣）。",
    EXPIRED: "这笔签名已失效，不会再上链。",
    PRESEND_FAILED: "交易没有进入网络，可以直接重试。",
  };
  $("jobHint").textContent = hints[job.state] || "";
  $("btnCheck").hidden = !(job.state === C.S.UNKNOWN || job.state === C.S.PENDING);
  $("btnResend").hidden = !(job.state === C.S.UNKNOWN || job.state === C.S.PENDING);
  $("btnDone").hidden = !C.canStartNewSend(job.state) || job.state === C.S.IDLE;
}

// ---------- wire up ----------
$("btnConnect").onclick = connect;
$("btnDisconnect").onclick = () => disconnect(false);
$("btnRefresh").onclick = refresh;
$("btnAddMint").onclick = () => {
  const v = $("mintInput").value.trim();
  try { new PublicKey(v); } catch { return log("mint 地址格式不正确", "err"); }
  if (!C.isBase58(v)) return log("mint 地址格式不正确", "err");
  manualMints.add(v); $("mintInput").value = "";
  log(`已添加 mint ${v}，刷新余额后出现在列表（只支持经典 SPL 代币）`);
  if (session && !C.mustLockSession(job.state)) refresh();
};
$("btnBuild").onclick = build;
$("btnSign").onclick = sign;
$("btnCancel").onclick = cancelReview;
$("btnCheck").onclick = () => { if (active) startPolling(active); };
$("btnResend").onclick = () => { if (active) broadcast(active, false); };
$("btnDone").onclick = () => { active = null; setState(C.S.IDLE); if (deviceGone) disconnect(true); };
window.addEventListener("beforeunload", (e) => { if (C.mustLockSession(job.state)) { e.preventDefault(); e.returnValue = ""; } });

applyLocks();
renderJob();
log("就绪。选择网络后连接 Ledger。");
