# AGENTS.md — Agent Working Discipline

This is cdp2cli: the **method and discovery layer** for turning web-stack desktop apps into CLIs (not a shipped CLI).
For the methodology and safety notes see [PLAYBOOK.md](./PLAYBOOK.md); this file governs only how agents work in this
repository.

## What This Repository Is

- **The products are documents and facts**: `PLAYBOOK.md` (general method), `profiles/` (app facts),
  `contracts/` (verified interface contracts), `tools/research/` (forensic .mjs probes + `evidence/` records),
  `docs/` (design and retrospectives).
- **The shipped CLI is not here.** Once an app is established, spin off a standalone project from `contracts/`
  (single app, single binary, e.g. the Go zcodecli). Do not pile product CLI code back into this repository.
- `tools/research/*.mjs` are bare-CDP forensic probes (zero dependencies, Node >= 22) — research instruments, not
  product code.
- `cli/` is the **methodology reference CLI** packing PLAYBOOK + contract samples via go:embed (so agents can read
  the method offline); it is not a product CLI for any app. Product CLIs are still spun off as standalone projects.

## Working Discipline

- **Read before you change**: before changing a conclusion, read the corresponding profile, contract, evidence.
  Endpoints/fields/enums in contracts are measured facts — never change them from memory; if measurement overturns
  them, update them and leave evidence.
- **Never fabricate**: parameters, resource IDs, bot_id, return shapes come only from probe measurements or static
  call sites. Anything not captured by a probe or live-verified is honestly marked `unresolved` or
  `static-contract-only` — never written up as verified.
- **Probing sends read requests only**: write/delete/send/authorize/pairing actions are not really sent while
  establishing contracts; write contracts are fixed from static call sites, packet capture, and read-only
  cross-confirmation. See PLAYBOOK §4.
- **No-op is a legitimate result**: when the conclusion already exists, verify and report "already exists"; do not
  change things just to produce output.
- **No drive-by work**: unrelated cleanup never rides along inside another change.

## Development Standards

From the first commit on, this repository works by the development standards of the williamfzc/skills repository;
everything generated here — commits, docs, probes, evidence records, spun-off projects — follows them too:

- **Commit messages**: Angular Conventional Commits, in English, `type(scope): subject` (scope optional); one commit
  tells one story — if it cannot be summarized in one line, it is two commits.
- **Language**: code, identifiers, comments, commit messages, docs — all English.
- **Durable docs carry YAML frontmatter**: at least `type` / `title` / `description`; `type` is one of `Method` /
  `Playbook` / `Profile` / `Concept` / `Index`.
- **Source files open with a role comment**: two lines on what it is and where it stands in the whole.
- **Generated artifacts follow the same rules**: spun-off product CLI projects, evidence `INDEX.md`, probe output
  documents all follow this section and the documentation discipline below.

## Documentation Discipline (this repo's core disease is concept inflation)

- A concept is defined in exactly one place; the definition is the single source of truth, and everything else links
  instead of restating.
- The bar for a concept entering PLAYBOOK / README is **evidence** (probe measurement or contract). Pure
  design-stage concepts live in `docs/`, marked "not implemented".
- Current status (which apps are established, which contracts verified, which unresolved) is governed by the README
  status list and `contracts/`; no other section may contradict them.
- When docs and measurement disagree, the probe / live app behavior wins — fix the docs, not the words.

## Evidence Archival

Every exploration session archives under `tools/research/evidence/<date>-<app>/`: probe output JSON, an `INDEX.md`
timeline retrospective (what was tried, success/failure, key findings, negative results), screenshots of key states.
Redaction: user content verbatim is not archived — keep structure, counts, key sets; endpoints, resource IDs, and
request shapes are kept. Conventions in [tools/research/README.md](tools/research/README.md).
