# Security policy

Casierul clasei stores children's names, parents' phone numbers and a class's financial history. Please report vulnerabilities privately so that running installations can be fixed before details become public.

## Reporting

- Preferred: open a private report through GitHub's **Security → Report a vulnerability** on this repository.
- Alternatively, contact the maintainer directly through the address on their GitHub profile.
- Please do not open public issues for security problems, and do not test against installations you do not operate.

Include what you found, how to reproduce it and, if you can, the impact you see. You will get an acknowledgement within a few days and a fix or a mitigation plan as soon as one exists. Credit is given in the release notes unless you prefer otherwise.

## Scope

- The server (`server/`), the web app (`web/`), the admin script and the backup script.
- Access control between the cashier, parent and auditor roles, invitation handling and session cookies.
- Data handling: exports, PDF reports, attached documents, WhatsApp links.

Out of scope: the reverse proxy, the operating system and third-party services (Cloudflare, WhatsApp, Revolut) themselves, and denial of service by sheer traffic volume.

## What operators should know

- The admin API listens on a separate loopback-only port and is protected by `ADMIN_TOKEN`; keep that token out of the public web tier.
- Data at rest (SQLite files, backups) is **not** encrypted by the application. Protect the data directory and backups at the operating-system level; see `docs/encryption.md` for the plan.
- Keep Node.js at a supported version and run `npm audit` after updating dependencies.
