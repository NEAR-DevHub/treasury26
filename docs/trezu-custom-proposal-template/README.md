# trezu custom-proposal-template skill

A portable AI **skill** that helps you build a custom proposal template for
[trezu](https://trezu.app) (a SputnikDAO treasury UI on NEAR) by describing what you
want in plain English. The assistant produces the template **manifest** (JSON) you paste
into trezu — no coding.

Everything the assistant needs is in [`SKILL.md`](SKILL.md); it's self-contained, so it
works without access to the trezu codebase.

## Install / use it

**Claude Code**
- Copy this folder into your skills directory:
  - all projects: `~/.claude/skills/trezu-custom-proposal-template/`
  - one project: `<project>/.claude/skills/trezu-custom-proposal-template/`
- Then just ask: *"Build a trezu custom proposal template that pays USDC to a recipient
  each month."* Claude matches the skill by its description and follows it.

**Claude.ai / Claude in your workspace (Skills)**
- Where Skills can be uploaded, add this folder (or `SKILL.md`) as a custom skill, then
  ask the same way.

**Claude chat (no Skills feature) / Codex / other assistants**
- Paste the contents of `SKILL.md` into the chat (or your assistant's custom-instructions
  / system-prompt slot), then describe the proposal you want. The file is plain Markdown
  and works as a self-contained prompt anywhere.

## What you'll get, and what to do with it

The assistant asks for the contract + method, which arguments are fixed vs member-filled,
and the deposit/gas — then returns a manifest like:

```json
{ "version": 1, "id": "usdc-payout", "title": "USDC Payout", "...": "..." }
```

In trezu: open your DAO → **Custom → New template → Code tab**, paste the manifest, and
**Save** (use the **Visual** tab to review it as a form first). Authoring a template
requires your DAO's `ChangePolicy` permission — if you don't have it, hand the manifest
to a member who does.
