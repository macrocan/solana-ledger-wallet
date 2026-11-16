import { test } from "node:test";
import assert from "node:assert/strict";
import * as C from "../src/core.js";

// ---------- amounts ----------
test("parseAmount: decimals, zero, u64 bound, garbage", () => {
  assert.equal(C.parseAmount("1.25", 6), 1250000n);
  assert.equal(C.parseAmount("0.000000001", 9), 1n);
  assert.equal(C.parseAmount("18446744073709.551615", 6), C.U64_MAX);
  assert.throws(() => C.parseAmount("18446744073709.551616", 6), /u64/);
  assert.throws(() => C.parseAmount("0", 9), /大于 0/);
  assert.throws(() => C.parseAmount("1e5", 9), /格式/);
  assert.throws(() => C.parseAmount("1,000", 9), /格式/);
  assert.throws(() => C.parseAmount("1.1234567891", 9), /小数位/);
  assert.throws(() => C.parseAmount("1".repeat(40), 9), /过长/);
  assert.throws(() => C.parseAmount("<img src=x>", 9), /格式/);
});

test("formatAmount round-trips and never uses scientific notation", () => {
  assert.equal(C.formatAmount(1250000n, 6), "1.25");
  assert.equal(C.formatAmount(1n, 9), "0.000000001");
  assert.equal(C.formatAmount(5000000000n, 9), "5");
  assert.equal(C.formatAmount(123n, 0), "123");
  assert.equal(C.formatAmount(C.U64_MAX, 0), "18446744073709551615");
  for (const s of ["0.1", "1", "99999.999999"]) assert.equal(C.formatAmount(C.parseAmount(s, 6), 6), s);
});

// ---------- network ----------
test("checkNetwork: custom RPC pointing at the wrong cluster is refused", () => {
  assert.equal(C.checkNetwork("devnet", C.GENESIS.devnet).ok, true);
  const r = C.checkNetwork("devnet", C.GENESIS["mainnet-beta"]);
  assert.equal(r.ok, false);
  assert.equal(r.cluster, "mainnet-beta");
  assert.match(r.reason, /实际是 mainnet-beta/);
  assert.equal(C.checkNetwork("devnet", "notahash").ok, false);
});

test("explorerTxUrl validates signature shape", () => {
  const sig = "5".repeat(88);
  assert.equal(C.explorerTxUrl(sig, "mainnet-beta"), `https://solscan.io/tx/${sig}`);
  assert.equal(C.explorerTxUrl(sig, "devnet"), `https://solscan.io/tx/${sig}?cluster=devnet`);
  assert.throws(() => C.explorerTxUrl('"><script>', "devnet"));
  assert.throws(() => C.explorerTxUrl("abc", "devnet"));
});

// ---------- assets ----------
const MINT_A = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MINT_B = "So11111111111111111111111111111111111111112";
const ACC_1 = "9wFFyRfZBsuAha4YcuxcXLKwMxJR43S7fPfQLusDBzvT";
const ACC_2 = "7UX2i7SucgLMQcfZ75s3VXmZZY4YRUyJN9X1RgfMoDUi";

test("buildTokenList: keyed, atomic, excludes zero and marks Token-2022 non-sendable", () => {
  const m = C.buildTokenList([
    { programId: C.TOKEN_PROGRAM, account: ACC_1, mint: MINT_A, amount: "1500000", decimals: 6 },
    { programId: C.TOKEN_PROGRAM, account: ACC_2, mint: MINT_B, amount: "0", decimals: 9 },
    { programId: C.TOKEN_2022_PROGRAM, account: ACC_2, mint: MINT_B, amount: "7", decimals: 0 },
  ]);
  assert.equal(m.size, 2);
  const a = m.get(C.assetKey(C.TOKEN_PROGRAM, MINT_A, ACC_1));
  assert.equal(a.display, "1.5"); assert.equal(a.sendable, true);
  const b = m.get(C.assetKey(C.TOKEN_2022_PROGRAM, MINT_B, ACC_2));
  assert.equal(b.sendable, false);
});

test("buildTokenList: a bad RPC entry throws instead of producing a partial list", () => {
  assert.throws(() => C.buildTokenList([
    { programId: C.TOKEN_PROGRAM, account: ACC_1, mint: MINT_A, amount: "1", decimals: 6 },
    { programId: C.TOKEN_PROGRAM, account: ACC_2, mint: "<b>x</b>", amount: "1", decimals: 6 },
  ]), /地址/);
  assert.throws(() => C.buildTokenList([{ programId: C.TOKEN_PROGRAM, account: ACC_1, mint: MINT_A, amount: "1e3", decimals: 6 }]), /余额/);
});

test("regression (review #1): asset selection survives a refresh that reorders tokens", () => {
  // Old code resolved the <select> value as an array index. With keys, the same
  // option value always resolves to the same position regardless of order.
  const before = C.buildTokenList([
    { programId: C.TOKEN_PROGRAM, account: ACC_1, mint: MINT_A, amount: "10", decimals: 0 },
    { programId: C.TOKEN_PROGRAM, account: ACC_2, mint: MINT_B, amount: "20", decimals: 0 },
  ]);
  const selected = [...before.keys()][0]; // user picked "A"
  const after = C.buildTokenList([
    { programId: C.TOKEN_PROGRAM, account: ACC_2, mint: MINT_B, amount: "20", decimals: 0 },
    { programId: C.TOKEN_PROGRAM, account: ACC_1, mint: MINT_A, amount: "10", decimals: 0 },
  ]);
  assert.equal(after.get(selected).mint, MINT_A);
  const gone = C.buildTokenList([{ programId: C.TOKEN_PROGRAM, account: ACC_2, mint: MINT_B, amount: "20", decimals: 0 }]);
  assert.equal(gone.get(selected), undefined); // main.js refuses to send when the key is missing
});

// ---------- recipient / budget ----------
test("checkRecipient rejects PDAs, programs and token accounts", () => {
  assert.equal(C.checkRecipient({ onCurve: false, info: null }).ok, false);
  assert.equal(C.checkRecipient({ onCurve: true, info: null }).ok, true);
  assert.equal(C.checkRecipient({ onCurve: true, info: { ownerProgram: C.SYSTEM_PROGRAM, executable: false } }).ok, true);
  assert.match(C.checkRecipient({ onCurve: true, info: { ownerProgram: C.TOKEN_PROGRAM, executable: false } }).reason, /代币账户/);
  assert.match(C.checkRecipient({ onCurve: true, info: { ownerProgram: "BPFLoaderUpgradeab1e11111111111111111111111", executable: true } }).reason, /程序/);
});

test("checkSolBudget: fee + rent + rent-exempt minimum for new accounts", () => {
  const fee = 5000n, rentMin = 890880n, ataRent = 2039280n;
  assert.equal(C.checkSolBudget({ kind: "SOL", solBalance: 10_000_000n, amountLamports: 1_000_000n, fee, recipientExists: true, rentExemptMin: rentMin }).ok, true);
  assert.match(C.checkSolBudget({ kind: "SOL", solBalance: 10_000_000n, amountLamports: 1000n, fee, recipientExists: false, rentExemptMin: rentMin }).reason, /免租/);
  assert.match(C.checkSolBudget({ kind: "SOL", solBalance: 1_000_000n, amountLamports: 1_000_000n, fee, recipientExists: true, rentExemptMin: rentMin }).reason, /余额不足/);
  // token transfer with plenty of tokens but no SOL for the ATA
  const r = C.checkSolBudget({ kind: "TOKEN", solBalance: 1_000_000n, fee, ataRent, rentExemptMin: rentMin });
  assert.equal(r.ok, false); assert.match(r.reason, /租金/);
  assert.equal(C.checkSolBudget({ kind: "TOKEN", solBalance: 3_000_000n, fee, ataRent, rentExemptMin: rentMin }).ok, true);
});

// ---------- ledger errors ----------
test("classifyLedgerError maps status codes without guessing blind-signing", () => {
  assert.equal(C.classifyLedgerError({ statusCode: 0x6985 }).kind, "rejected");
  assert.equal(C.classifyLedgerError({ statusCode: 0x5515 }).kind, "locked");
  assert.equal(C.classifyLedgerError({ statusCode: 0x6e01 }).kind, "wrong-app");
  const u = C.classifyLedgerError({ statusCode: 0x6a81, message: "x" });
  assert.equal(u.kind, "unparsable"); assert.match(u.text, /0x6a81/);
  assert.equal(C.classifyLedgerError({ message: "The device was disconnected" }).kind, "disconnected");
  assert.equal(C.classifyLedgerError(new Error("blind something")).kind, "unknown");
});

// ---------- state machine ----------
test("state machine: happy path and illegal jumps", () => {
  const j = C.createJob();
  for (const s of ["BUILDING", "REVIEW", "SIGNING", "BROADCASTING", "PENDING", "CONFIRMED", "IDLE"]) C.transition(j, s);
  assert.equal(j.state, "IDLE");
  assert.throws(() => C.transition(C.createJob(), "SIGNING"), /非法/);
  const k = C.createJob(); C.transition(k, "BUILDING"); C.transition(k, "REVIEW"); C.transition(k, "SIGNING");
  assert.throws(() => C.transition(k, "IDLE"), /非法/); // cannot abandon a tx mid-signing silently
});

test("regression (review #3): a new send is never allowed while a tx is pending or unknown", () => {
  for (const s of ["BUILDING", "REVIEW", "SIGNING", "BROADCASTING", "PENDING", "UNKNOWN"]) {
    assert.equal(C.canStartNewSend(s), false, s);
    assert.equal(C.mustLockSession(s), true, s);
  }
  for (const s of ["IDLE", "CONFIRMED", "FAILED_ONCHAIN", "EXPIRED", "PRESEND_FAILED"]) assert.equal(C.canStartNewSend(s), true, s);
});

test("classifyBroadcastError: only preflight rejections count as 'never sent'", () => {
  assert.equal(C.classifyBroadcastError(new Error("Transaction simulation failed: Blockhash not found")), "PRESEND_FAILED");
  assert.equal(C.classifyBroadcastError(new Error("failed to send transaction: signature verification failed")), "PRESEND_FAILED");
  assert.equal(C.classifyBroadcastError(new Error("Failed to fetch")), "UNKNOWN");
  assert.equal(C.classifyBroadcastError(new Error("503 Service Unavailable")), "UNKNOWN");
  assert.equal(C.classifyBroadcastError(new Error("network timeout")), "UNKNOWN");
});

test("decideStatus: confirmed / failed / expired / still pending", () => {
  const lv = 1000;
  assert.equal(C.decideStatus({ status: { confirmationStatus: "confirmed", err: null }, blockHeight: 900, lastValidBlockHeight: lv }), "CONFIRMED");
  assert.equal(C.decideStatus({ status: { confirmationStatus: "finalized", err: null }, blockHeight: 2000, lastValidBlockHeight: lv }), "CONFIRMED");
  assert.equal(C.decideStatus({ status: { confirmationStatus: "confirmed", err: { InstructionError: [0, "Custom"] } }, blockHeight: 900, lastValidBlockHeight: lv }), "FAILED_ONCHAIN");
  assert.equal(C.decideStatus({ status: { confirmationStatus: "processed", err: null }, blockHeight: 2000, lastValidBlockHeight: lv }), "PENDING");
  assert.equal(C.decideStatus({ status: null, blockHeight: 1000, lastValidBlockHeight: lv }), "PENDING");
  assert.equal(C.decideStatus({ status: null, blockHeight: 1001, lastValidBlockHeight: lv }), "EXPIRED");
});

test("regression (review #3): simulated 'RPC accepted but response lost' resolves to CONFIRMED via original signature, no re-sign", () => {
  // Simulate main.js's broadcast(): sendRawTransaction throws a network error
  // after the RPC actually accepted the tx. Then polling sees it confirmed.
  const j = C.createJob();
  for (const s of ["BUILDING", "REVIEW", "SIGNING", "BROADCASTING"]) C.transition(j, s);
  const next = C.classifyBroadcastError(new Error("Failed to fetch"));
  C.transition(j, next);
  assert.equal(j.state, "UNKNOWN");
  assert.equal(C.canStartNewSend(j.state), false);
  const found = C.decideStatus({ status: { confirmationStatus: "confirmed", err: null }, blockHeight: 10, lastValidBlockHeight: 100 });
  C.transition(j, found);
  assert.equal(j.state, "CONFIRMED");
});

// ---------- persistence ----------
test("job record round-trips and rejects tampered / cross-network records", () => {
  const rec = { signature: "5".repeat(88), rawTxB64: "AAAA", blockhash: "h", lastValidBlockHeight: 42, cluster: "devnet", genesisHash: C.GENESIS.devnet, owner: MINT_A, summary: {}, createdAt: 1 };
  const json = C.serializeJobRecord(rec);
  assert.deepEqual(C.parseJobRecord(json), rec);
  assert.equal(C.parseJobRecord(JSON.stringify({ ...rec, genesisHash: C.GENESIS["mainnet-beta"] })), null);
  assert.equal(C.parseJobRecord(JSON.stringify({ ...rec, signature: "<x>" })), null);
  assert.equal(C.parseJobRecord("not json"), null);
  assert.throws(() => C.serializeJobRecord({ ...rec, rawTxB64: undefined }), /缺少/);
});

// ---------- base58 ----------
test("base58Encode matches known vectors", () => {
  assert.equal(C.base58Encode(new Uint8Array(32)), "1".repeat(32));
  assert.equal(C.base58Encode(Uint8Array.from([0x00, 0x00, 0x01])), "112");
  assert.equal(C.base58Encode(Uint8Array.from([0xff])), "5Q");
  assert.equal(C.base58Encode(Buffer.from("hello world")), "StV1DL6CwTryKyV");
});

test("checkSolBudget: sender may not be left with a dust balance below rent-exempt minimum", () => {
  const fee = 5000n, rentMin = 890_880n;
  // 10 SOL-ish balance, send everything minus fee -> leftover 0: ok
  assert.equal(C.checkSolBudget({ kind: "SOL", solBalance: 10_000_000n, amountLamports: 9_995_000n, fee, recipientExists: true, rentExemptMin: rentMin }).ok, true);
  // leftover 100_000 lamports (< rentMin): rejected
  const r = C.checkSolBudget({ kind: "SOL", solBalance: 10_000_000n, amountLamports: 9_895_000n, fee, recipientExists: true, rentExemptMin: rentMin });
  assert.equal(r.ok, false); assert.match(r.reason, /低于免租最低额/);
  // leftover exactly rentMin: ok
  assert.equal(C.checkSolBudget({ kind: "SOL", solBalance: 10_000_000n, amountLamports: 10_000_000n - fee - rentMin, fee, recipientExists: true, rentExemptMin: rentMin }).ok, true);
});

test("decideStatus: a processed-level error is not final (block may be rolled back)", () => {
  assert.equal(C.decideStatus({ status: { confirmationStatus: "processed", err: { InstructionError: [0, "Custom"] } }, blockHeight: 1, lastValidBlockHeight: 100 }), "PENDING");
  assert.equal(C.decideStatus({ status: { confirmationStatus: "processed", err: null }, blockHeight: 1, lastValidBlockHeight: 100 }), "PENDING");
});

test("jobStorageKey: one slot per cluster+owner, rejects bad input", () => {
  const a = C.jobStorageKey("mainnet-beta", "11111111111111111111111111111111");
  const b = C.jobStorageKey("devnet", "11111111111111111111111111111111");
  assert.notEqual(a, b);
  assert.ok(a.startsWith(C.JOB_STORAGE_PREFIX + ":"));
  assert.throws(() => C.jobStorageKey("mainnet", "11111111111111111111111111111111"));
  assert.throws(() => C.jobStorageKey("devnet", "0OIl"));
});

test("priority fee: parse + ceil division", () => {
  assert.equal(C.parseMicroLamports(""), 0n);
  assert.equal(C.parseMicroLamports(" 1000 "), 1000n);
  assert.throws(() => C.parseMicroLamports("1.5"));
  assert.throws(() => C.parseMicroLamports("-1"));
  assert.equal(C.priorityFeeLamports(450, 0n), 0n);
  assert.equal(C.priorityFeeLamports(60_000, 10_000n), 600n);
  assert.equal(C.priorityFeeLamports(450, 1n), 1n); // rounds up
});

test("PUBLIC_RPC mainnet is not the official endpoint (it blocks browsers)", () => {
  assert.notEqual(C.PUBLIC_RPC["mainnet-beta"], "https://api.mainnet-beta.solana.com");
  for (const u of Object.values(C.PUBLIC_RPC)) assert.match(u, /^https:\/\//);
});
