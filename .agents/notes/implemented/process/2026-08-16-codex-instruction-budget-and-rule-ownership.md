# Agent Note: Codex instruction budget and rule ownership

Status: implemented

English | [中文](2026-08-16-codex-instruction-budget-and-rule-ownership.zh.md)

## Problem

Codex builds one project-instruction chain from the global file through the current working directory and limits that chain to 32 KiB by default. The global and repository-root instructions already consume most of that budget, so starting Codex under `docs/` or `packages/client/` can truncate the nearest instructions. The root file also carried package-only runtime and TypeScript rules, making every repository task pay for guidance that applies only below `packages/`.

## Decision

The repository checks in `.codex/config.toml` with `project_doc_max_bytes = 65536`. This repo-scoped setting raises only the project-document budget and takes effect when the repository is trusted; provider, authentication, MCP, telemetry, and permission settings remain user-owned.

The root `AGENTS.md` owns rules that apply across repository areas and explicitly routes package work to `packages/AGENTS.md`. The package instruction file retains hard entry checks and routes contributors to `packages/RULE.md`, which owns package naming, ESM execution, plugin lifecycle, event logging, package boundaries, tool presentation, and package coverage policy. Nested instruction files remain authoritative for their directories; the larger budget prevents a direct subdirectory launch from dropping the nearest file.

## Alternatives considered

**Raise the limit in the global Codex config.** Rejected because the pressure is evidenced by this repository's instruction tree, while a global increase would enlarge the available prompt budget for unrelated repositories without their consent.

**Keep every rule at the root and only raise the limit.** Rejected because root-only tasks would continue paying for package contracts and future package additions would grow the broadest instruction layer.

**Put every package rule directly in `packages/AGENTS.md`.** Rejected because the subtree instruction has a deliberately small word budget. A short entry file plus a linked policy preserves automatic guardrails while loading full detail only for package work.

**Rely on agents to read nested files manually.** Rejected because Codex also supports launching directly in a nested directory, where the automatic chain must fit without truncating the most specific instructions.

## Consequences

Root-started sessions receive a smaller always-on project document. Package work receives concise entry checks automatically and the complete policy through `packages/RULE.md`; direct starts in the longest current nested scopes fit within the explicit 64 KiB budget. Maintainers must keep cross-repository Codex settings out of `.codex/config.toml` and place new rules at the narrowest directory that owns them.

## Verification

`verify-doc-budgets`, `verify-agent-note-format`, translation pairing, Markdown links, Markdown wrapping, Mermaid parsing, package-path references, and `git diff --check` cover the repository artifacts, including `packages/RULE.md`. A fresh Codex session in the repository root, `docs/`, and `packages/client/` verifies the runtime instruction sources and effective budget.
