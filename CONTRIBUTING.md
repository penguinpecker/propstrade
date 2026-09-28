# Contributing

Issues are welcome: bug reports with a reproduction, and questions about the design. Please report security issues
privately as described in `SECURITY.md`.

Pull requests are accepted by prior agreement only: open an issue first and describe the change. Changes to the vault
program must land in both builds (`programs/props_vault` and `programs-p/props_vault_p`) with a regression test in
`tests/program`, the compare harness at 0 differences and the quick fuzz run clean; `programs-p/props_vault_p/PORTING.md`
explains how.

We cannot offer support for running the stack yourself.
