# Security

## Reporting a vulnerability

Please report vulnerabilities privately, not in a public issue or pull request:

- GitHub: use "Report a vulnerability" on this repository's Security tab (private vulnerability reporting), or
- email the maintainer at penguinpecker1@gmail.com with "Props.trade security" in the subject.

Include what you found, how to reproduce it, and the commit or deployment you looked at. You will get an
acknowledgement within three working days. Please give us reasonable time to fix an issue before disclosing it.

There is no bug bounty programme at this time.

## Scope

- `programs/props_vault` and `programs-p/props_vault_p` (the vault program; not yet deployed to mainnet)
- `server/` (API, indexer, keeper) and `app/` (the web app) as deployed at https://propstrade.vercel.app
- `packages/*` and `scripts/admin/*`

Out of scope: the exchange's own programs and services, third-party wallets, and denial-of-service against the
public endpoints.

## Supported versions

Only the `main` branch is supported. Fixes ship to the live app and server from `main`.
