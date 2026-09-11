# cdp2cli (methodology reference CLI)

Packs the general method for "turning web-stack desktop apps (CEF/Electron/WebView2) into CLIs" — the method,
forensic recipes, build SOP, sample contracts — into a zero-dependency binary that agents read over a shell,
**without needing access to the cdp2cli repository**.

Content comes from cdp2cli's `PLAYBOOK.md` and `contracts/`, packed with `go:embed`; after a method upgrade, run
`make install` again.

## Install

```bash
make install      # sync PLAYBOOK/contracts → build → install to ~/.local/bin/cdp2cli
```

## Usage

```bash
cdp2cli help                  # usage
cdp2cli skill                 # full methodology (PLAYBOOK)
cdp2cli skill attach          # runtime detection and CDP attachment
cdp2cli skill explore         # five-stage loop + copy-paste CDP forensic recipes (endpoint sweep / capture / replay / contracts / DOM)
cdp2cli skill contract        # contract schema
cdp2cli skill build           # build SOP for spinning a standalone CLI off contracts
cdp2cli skill safety          # known pitfalls and safety notes
cdp2cli contracts             # list embedded sample contracts
cdp2cli contracts <name>      # print a contract's JSON (e.g. ssh-list)
```

How an agent reads it: start with `cdp2cli skill build` to know what to produce, `cdp2cli skill explore` to know how
to gather evidence, `cdp2cli skill attach` to know how to connect; for the contract format see
`cdp2cli contracts <name>`.
