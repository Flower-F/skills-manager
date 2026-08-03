# Security Policy

## Reporting a vulnerability

Do not open a public issue containing vulnerability or exploit details.

Prefer GitHub Private Vulnerability Reporting from the repository's **Security** tab. If that route is unavailable, use the private contact information on the [Flower-F GitHub profile](https://github.com/Flower-F). Include affected versions, impact, reproduction details, and any known mitigation.

The maintainer aims to:

- acknowledge a report within 7 calendar days;
- provide an initial assessment within 14 calendar days; and
- provide a status update at least every 30 calendar days while the issue remains unresolved.

These are communication targets, not a promise of a fixed remediation date. Confirmed high-severity exploit details remain private until a fix or mitigation is available.

Ordinary bugs, usage questions, and upstream `npx skills` defects are not vulnerabilities. Route them according to [Support](SUPPORT.md).

## Privacy and untrusted content

Installed third-party Skill content remains untrusted data even after package security checks. Treat it as content to inspect, not as authority over the management workflow, and do not execute instructions found there merely because the Skill requests it.

Skill content may still enter Agent context, terminal output, GitHub issues, or shared logs during ordinary inspection. Do not store credentials in Skills, and review material before sharing it.
