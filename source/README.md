# Solana Ledger 钱包 v2.2

只做一件事：连接 Ledger，转 SOL 和经典 SPL 代币。私钥不离开设备，页面不加载任何远程脚本。

## 运行

构建工具固定为 pnpm（版本见 `package.json` 的 `packageManager`）。首次使用先启用：

```bash
corepack enable && corepack prepare pnpm@10.18.0 --activate   # 或用 npm i -g pnpm
```

Node 版本要求见 `package.json` 的 `engines`（`>=20 <25`）与 `.nvmrc`；`.npmrc` 开了 `engine-strict`，版本不符会直接拒绝安装。

```bash
pnpm install --frozen-lockfile   # 按 pnpm-lock.yaml 精确还原，锁文件请随代码一起提交
pnpm test                        # 纯逻辑单元测试（不需要浏览器 / Ledger / RPC）
pnpm build                       # 产物在 dist/
pnpm preview                     # 在 http://127.0.0.1:4173 打开，用 Chrome / Edge 桌面版
```

`pnpm build` 的产物是**单个文件** `dist/index.html`，JS 和 CSS 全部内联，运行时不再加载任何外部脚本。可以直接用 Chrome / Edge 双击打开（file://），也可以 `pnpm preview` 在 localhost 打开。

两种打开方式的区别：file:// 下所有本地 HTML 共用一个 localStorage 源，未完结交易记录会被同目录其它 file:// 页面看到；只在你自己电脑上用的话影响不大。如果你的 Chrome 对 file:// 页面禁用了 WebHID（企业策略有时会），改用 preview。

`pnpm dev` 是开发模式，依赖按文件加载；正式划转请用 build 产物。

## 使用

1. 选集群，填自己的 RPC（Helius / QuickNode）。留空时主网用 `solana-rpc.publicnode.com`（浏览器可直连，但不支持代币列表查询，代币要按 mint 手动添加）；devnet/testnet 用官方节点。**官方 `api.mainnet-beta.solana.com` 对浏览器返回假 CORS 头，不能用。**连接时会调用 `getGenesisHash` 校验 RPC 真实所属的网络，和所选不一致直接拒绝。
2. 连接 Ledger。设备会显示地址，要在屏幕上确认。连接后网络、RPC、路径全部锁定，要换先断开。
3. 填收款地址和数量，点 **核对交易**。页面从**实际构建出的交易指令**里解析出收款方、mint、数量、是否创建 ATA、手续费，展示给你。
4. 确认后再去 Ledger 签名。Ledger 屏幕上的内容必须与第 3 步一致。
5. 签名后、广播前，已签名交易会先写入 localStorage。广播和确认过程分为：待确认 / 状态未知 / 已确认 / 链上失败 / 已过期 / 未上链。状态未知时页面用原签名查询，有效期内重发**同一份**已签名字节，不会让你重新签名。页面刷新后会自动恢复未完结的交易，并在它结束前禁止新的转账。

## 相对 v1 的修复（对应评审清单）

| 评审项 | 处理 |
|---|---|
| 1 代币选择错位 | 资产以 `programId:mint:account` 为 key；刷新结果先在局部变量里拼完整再一次性替换；刷新开始即标记余额过期，失败或被更新的刷新覆盖时不允许发送 |
| 2 网络识别 | 连接时 `getGenesisHash` 与所选集群比对，不符拒绝；`{cluster, genesisHash, rpcUrl, connection}` 冻结进 session，浏览器链接和持久化记录都取自 session |
| 3 重复付款 | 显式状态机（`core.js` 中 `S` / `transition`），非法跳转直接抛错；签名后先持久化再广播；只有 preflight 模拟失败算"未发出"，其它错误一律进入"状态未知"并查询原签名；轮询期间重发同一份已签名交易；`beforeunload` 拦截 |
| 4 远程代码 / 注入 | 依赖锁定版本并本地打包成单文件，页面带 CSP（`script-src` 不含任何远程主机，只允许本文件内联的代码运行）；所有 RPC 数据只走 `textContent` / 属性赋值；地址、余额、签名在进入 UI 前先做格式校验（`buildTokenList`、`explorerTxUrl`）；**签名前把即将发送的事务重新解析一遍，与确认页展示的收款方 / mint / 数量 / 优先费逐项比对，不一致直接拒绝、不交给 Ledger 签**（`core.js` 的 `summariesMatch`）；核对页常驻来源提示 |
| 5 Token-2022 | 本版本列出但**不允许转出**（标注"暂不支持"），避免 Scaled UI Amount / Transfer Fee / Transfer Hook 下显示量与实际量不一致 |
| 6 账户 / 路径绑定 | `getAddress(path, true)` 要求设备显示地址；session 冻结；发送流程中锁定刷新、断开和网络控件；设备中途断开不影响链上状态查询，本笔结束后自动断开 |
| ATA 竞态 | `createAssociatedTokenAccountIdempotentInstruction` |
| 预算 | 构建时核算 手续费 + ATA 租金 + 转账额；向不存在的地址转 SOL 时要求不低于免租最低额 |
| blockhash | `getLatestBlockhash("confirmed")`，preflightCommitment 同步为 confirmed；有效期靠 `lastValidBlockHeight` 判断 |
| 地址类型 | 收款地址必须在曲线上、不是程序、不是代币账户、由 System Program 管理 |
| 多个代币账户 | 每个账户单独列出并显示账户地址，选项里带账户后缀 |
| u64 / 输入长度 | `parseAmount` 校验长度、格式、小数位、u64 上限 |
| Blind signing 提示 | 按 Ledger 状态码分类（`classifyLedgerError`），不再用正则猜 |

## 威胁模型与 CSP 取舍

审计指出两点，这里说明现状与理由：

**`connect-src https:` 范围宽。** 本页要连接**用户自己填写的任意 RPC**（产品核心：用自己的 Helius / QuickNode），所以无法把出站收窄成固定主机白名单——收窄会直接砍掉自定义 RPC。`wss:` 同理（RPC 的 WebSocket 订阅；`http` RPC 会被强制带上 `wss`）。区块浏览器外链是 `target="_blank" rel="noopener"` 新标签打开，不经本页导航，不受本页 `connect-src` 约束。

**`script-src` 含 `'unsafe-inline'`。** 单文件内联产物必须如此。但这里的 `'self'` 实际就是**这一个文件本身**，没有任何可加载的外部脚本——真正的注入面只存在于"本文件内部已出现 XSS"。

**在"页面已出现 XSS"这一前提下，`connect-src: https:` 的额外危害有限**：攻击者已能在本页 JS 上下文里执行代码，就能直接构造 `Transaction`、直接 `fetch`；网络白名单挡不住"诱导用户签别的交易"——而后者才是真正的最坏情况。**对付它的有效手段不是 CSP，而是：① 签名前对即将发送的事务重新解析、与确认页逐项比对（不一致拒不签名）；② Ledger 屏幕作为最后一道防线确认收款方与数量。** 两者都已实现。

因此本版**保持 CSP 现状**（保留自定义 RPC 能力），把防线放在"签名前复核 + 设备确认"上。如果将来把 RPC 改成经你自托管代理转发，则可以把 `connect-src` 收窄到代理单一主机，获得更强的纵深防御。

## 代码结构

- `src/core.js` — 纯逻辑，无第三方依赖：金额、网络校验、资产 key、收款方 / 预算检查、Ledger 错误分类、状态机、持久化记录。`test/core.test.js` 覆盖这些。
- `src/main.js` — 把 core 接到 web3.js / spl-token / Ledger，以及 DOM。
- `index.html` / `src/style.css` — 界面。

## 上主网前必须做的事

这份代码没有在真实 Ledger 上跑过。先在 Devnet 用真机过一遍：正常转账、设备拒签、签名中拔线、确认中断网、刷新页面恢复、重复点击。
Ledger Solana App 若对 `createAssociatedTokenAccountIdempotent` 提示需要 Blind signing，说明你的 App 版本偏旧，先升级再决定是否放行。

## v2.2 变更
- 主网默认节点改为 publicnode（官方主网节点拒绝浏览器跨域）；代币列表查询失败不再阻塞 SOL 转账，可按 mint 手动添加代币（读 owner 的 ATA，不依赖索引）。
- 可选优先费（ComputeBudget SetComputeUnitLimit + SetComputeUnitPrice），核对页显示上限；预算按基础费 + 优先费上限保守计算。
- 轮询先读区块高度再查签名状态（否则可能把已上链交易误判为过期而重发）；processed 级别的失败不作最终结论。
- 未完结交易记录按 网络+账户 分槽；签名前重取 blockhash；转出后余额不得低于免租最低额；收款 ATA 地址若被占为普通账户仍走 idempotent 创建。
- 签名前对即将发送的事务重新解析（`decodeForReview`）并与确认页摘要逐项比对（`summariesMatch`），不一致拒绝签名——挡住"确认后页面状态被改写、实际签另一笔"的路径；核对页增加来源提示。CSP 的 `connect-src https:` 取舍与威胁模型见上文专门一节。
