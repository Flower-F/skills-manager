# Disable upstream skills telemetry

Every `npx skills` subprocess launched by `skills-manager` receives `DISABLE_TELEMETRY=1`. The adapter applies this unconditionally for project and global operations and for public and private sources.

Agent arguments and inherited configuration cannot re-enable telemetry through the managed path. Skill names and content may be private, and telemetry is not required for installation, update, validation, or publication.
