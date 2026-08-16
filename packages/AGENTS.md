# AGENTS.md — Harness Packages

Read the complete [package rules](RULE.md) before changing package code. These entry checks supplement the repo-wide [conventions](../AGENTS.md#conventions); `RULE.md` owns the full wording and rationale links.

- **Plugin exports:** service packages default-export their service class; function plugins named-export `name` / `inject` / `Config` / `apply` and have no default export.
- **Optional services use `ctx.get(name)`.** Reserve `ctx.<name>` for declared injections.
- **Registrations are effects.** Contributions use `ctx.effect()` / `ctx.on()`; registry `register()` methods return a disposer, and tests prove disposal removes the contribution.
- **Product-visible plugins require a non-unit REAL-composition test.** Boot a test `cordis.yml` through the Loader and app or process, then assert model-visible, durable, or user-visible output.
- **Model-visible ⟺ logged.** Every model request input is reconstructable from session events.
- **Every package owns `./invariant`.** Assert an owned event or mutable-data relationship, or export an explained empty installer beginning with `No runtime invariant:`.
- Package `tsconfig.json` files use the documented aggregate, source and output directories, and workspace references; tests live under package-level `tests/`.
- Changed behavior updates the package README and JSDoc together, including the canonical Model Experience and durable limitations sections.
