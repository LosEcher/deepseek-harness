# Agent Note: Generated Rust migration ledger

Status: implemented

[English](2026-08-15-rust-migration-ledger.md) | 中文

## Problem

[Rust 能力 Provider 计划](../../proposed/architecture/2026-08-15-rust-host-replacement.md) 替换的是 Service Provider，而不是 Service Definition，但每个 DSH 包仍必须被记账：由哪个 crate 实现、由哪个 phase 负责、facade 是否可以加载，以及默认 Rust 行仍依赖哪些 TypeScript 包。一份手写的两百行表格会在新包加入时立即漂移。native-dsh 边界检查已经拒绝残缺配对（只有 `native/dsh/migration/package-map.json` 没有 `docs/rust-migration-matrix.md`，或相反），因此第一片默认 Rust 叶子在两份产物同时存在、并由同一份清单生成之前不能落地。

## Decision

[`scripts/gen-rust-migration-ledger.ts`](../../../../scripts/gen-rust-migration-ledger.ts) 盘点每个 `@deepseek-ai/dsh-*` `package.json`、其仓库内 peer-dependency 边、来自 [`scripts/service-roles.ts`](../../../../scripts/service-roles.ts) 的 capability role、已出厂 Cordis composition 行，以及 `packages/bundle/*/cordis.patch.yml` 引用。维护者只编辑 [`native/dsh/migration/overrides.json`](../../../../native/dsh/migration/overrides.json) 来填写 disposition、phase、status、target crate、fixture、placement 与 `removeAfter`。生成器同时写入 [`native/dsh/migration/package-map.json`](../../../../native/dsh/migration/package-map.json) 和 [`docs/rust-migration-matrix.md`](../../../../docs/rust-migration-matrix.md)。`pnpm run verify-rust-migration-ledger`（`--check`）在 `doc-sync` 中运行。当 overlay 点名未知包、`prototype` / `facade` / `migrated` 行缺少 `targetCrate`、或 `migrated` 行依赖 ledger 中不存在的包时，生成器失败。

status 取值为 `unmigrated`（TypeScript 仍是实现）、`prototype`（crate 只存在于 `native/dsh`）、`facade`（在 facade 被列入允许名单后，TypeScript 协调器可以调用它）和 `migrated`（已出厂的默认 Provider 是 Rust；TypeScript Provider 仍可挂载）。组默认值将 `client`、`examples` 和 `test-support` 标为 `retain-typescript`。P2 叶子原型（`dsh-primitives`、`dsh-session-store`）记录为 `prototype`，不会出现在任何已出厂 profile 中。`removeAfter` 不是移除 Node 的时间表。

## Alternatives considered

**手写 `package-map.json`，只生成 matrix。** 否决：ledger 会变成第二份清单，新包会漏记。生成器与 `gen-module-graph` 一样从 `package.json` 发现包。

**在第一个 facade 落地之前保持配对缺失。** 否决：边界检查在任一文件出现时就要求成对存在，没有 ledger 的已迁移叶子无法证明其 Node 依赖闭包已被记录。

**像第三方声明那样用 pre-commit 再生成来分层维护。** 对本产物否决：overlay 是显式维护者输入，`doc-sync` 新鲜度检查与其他生成目录一致。

## Consequences

- 新增 DSH 包会在下一次生成时进入 ledger；不写 overlay 是合法的，会得到 `unmigrated` / `replace` 行。
- 残缺配对仍会失败于边界检查。过期配对会失败于 `verify-rust-migration-ledger`。
- 在依赖闭包被盘点之前把一行标为 `migrated` 会使生成器失败；在 facade 被列入允许名单之前，已出厂 profile 仍然不能引用 Rust crate。`migrated` 行不删除 TypeScript Provider。
