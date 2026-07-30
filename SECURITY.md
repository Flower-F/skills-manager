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

Installed Skill content is untrusted data. The Intent-application helper produces a raw Intent application patch and does not automatically redact secrets or private data. Skill content may enter terminal output, Agent conversations, model context, GitHub issues, and shared logs. Do not store credentials in Skills, and review output before sharing it.
