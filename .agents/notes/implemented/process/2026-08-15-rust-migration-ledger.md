# Agent Note: Generated Rust migration ledger

Status: implemented

English | [中文](2026-08-15-rust-migration-ledger.zh.md)

## Problem

The [Rust capability-provider plan](../../proposed/architecture/2026-08-15-rust-host-replacement.md) replaces Service Providers, not Service Definitions, but every DSH package still has to be accounted for: which crate implements it, which phase owns it, whether a facade may load it, and which TypeScript packages a default-Rust row still depends on. A hand-maintained table of two hundred packages drifts the moment a package is added. The native-dsh boundary gate already refuses a half-created pair (`native/dsh/migration/package-map.json` without `docs/rust-migration-matrix.md`, or the reverse), so the first default-Rust leaf cannot land until both artifacts exist and stay generated from the same inventory.

## Decision

[`scripts/gen-rust-migration-ledger.ts`](../../../../scripts/gen-rust-migration-ledger.ts) inventories every `@deepseek-ai/dsh-*` `package.json`, its in-repo peer-dependency edges, capability roles from [`scripts/service-roles.ts`](../../../../scripts/service-roles.ts), shipped Cordis composition rows, and `packages/bundle/*/cordis.patch.yml` references. Maintainers edit only [`native/dsh/migration/overrides.json`](../../../../native/dsh/migration/overrides.json) for disposition, phase, status, target crate, fixtures, placement, and `removeAfter`. The generator writes [`native/dsh/migration/package-map.json`](../../../../native/dsh/migration/package-map.json) and [`docs/rust-migration-matrix.md`](../../../../docs/rust-migration-matrix.md) together. `pnpm run verify-rust-migration-ledger` (`--check`) runs in `doc-sync`. The generator fails when the overlay names an unknown package, when a `prototype` / `facade` / `migrated` row omits `targetCrate`, or when a `migrated` row depends on a package that is not in the ledger.

Status values are `unmigrated` (TypeScript remains the implementation), `prototype` (the crate lives only in `native/dsh`), `facade` (a TypeScript coordinator may call it after the facade is allow-listed), and `migrated` (the shipped default provider is Rust; the TypeScript provider stays mountable). Group defaults mark `client`, `examples`, and `test-support` as `retain-typescript`. P2 leaf prototypes (`dsh-primitives`, `dsh-session-store`) are recorded as `prototype` and do not appear in any shipped profile. `removeAfter` is not a Node-removal schedule.

## Alternatives considered

**Hand-write `package-map.json` and generate only the matrix.** Rejected: the ledger would become a second inventory that misses new packages. The generator discovers packages from `package.json` the same way `gen-module-graph` does.

**Keep the pair absent until the first facade lands.** Rejected: the boundary gate already requires the pair as soon as either file exists, and a migrated leaf without a ledger cannot prove its Node dependency closure is recorded.

**Tier the ledger through a pre-commit regenerator, like third-party notices.** Rejected for this artifact: the overlay is an explicit maintainer input, and `doc-sync` freshness matches every other generated catalog.

## Consequences

- Adding a DSH package updates the ledger on the next generator run; omitting it from the overlay is valid and yields an `unmigrated` / `replace` row.
- A half-created pair still fails the boundary gate. A stale pair fails `verify-rust-migration-ledger`.
- Marking a row `migrated` before its dependency closure is inventoried fails the generator; shipped profiles still cannot reference Rust crates until a facade is allow-listed. A `migrated` row does not delete the TypeScript provider.
