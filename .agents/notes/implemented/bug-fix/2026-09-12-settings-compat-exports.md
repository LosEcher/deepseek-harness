# Agent Note: Restore settingsNamespace and installSettingsSection exports

Status: implemented

English | [中文](2026-09-12-settings-compat-exports.zh.md)

## Problem

Third-party profile plugins import `settingsNamespace` and `installSettingsSection` from `@deepseek-ai/dsh-settings`. Origin 0.1.5-rc.2 moved that wiring onto `SettingsProvider.installSection` and stopped exporting the two helpers, so a source-launch against this tree failed to import `dsh-llm-fallbacks`, `dsh-session-pin`, and `dsh-tool-ocr`.

## Decision

Re-export `settingsNamespace` as the public brand helper over the existing parser, and `installSettingsSection` as the inject wrapper that calls `ctx.settings.installSection`. First-party plugins keep using the method; out-of-tree plugins keep the names they already import.

## Alternatives considered

**Disable the failing profile plugins.** Rejected because they are the operator's installed surface, not a misconfiguration of this tree.

**Ask each plugin to migrate to `installSection`.** Correct for later, but it does not restore a currently broken web profile.

## Consequences

A profile that still imports the 0.1.0 helper names can load on 0.1.5-rc.2. New first-party code should keep calling `SettingsProvider.installSection`.
