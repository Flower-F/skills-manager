# CLI owns the security assessment boundary

The Agent does not call the upstream audit endpoint, inspect its raw JSON, or parse the formatted terminal table printed by `npx skills`. A `skills-manager` security adapter calls the same audit service used by the supported `skills` version, validates and normalizes the response, and exposes only stable structured status and a human-readable summary.

An explicitly safe assessment may proceed to Agent inspection. A warning, missing result, request failure, or unknown schema returns `needs_confirmation` before the skill is read by the Agent or published. When repository discovery is required, the adapter may run and fully capture `npx skills add --list` in isolation before assessment because the skill names are needed to request it; raw output and downloaded content remain hidden from the Agent. After the user confirms, the Agent records that decision through an explicit `skills-manager continue --work-dir <path> --accept-risk` call. A generic `--yes` never represents security acceptance.

The audit endpoint is an internal upstream interface and may change. Compatibility is therefore versioned with the `skills` adapter, and any unrecognized behavior fails closed to user confirmation rather than being interpreted heuristically.

Automatic continuation requires every available Gen and Snyk rating to be `safe` or `low`, every Socket result to contain zero alerts, and no required result to be missing. `medium`, `high`, or `critical` ratings, one or more Socket alerts, missing fields, request failure, timeout, or unknown values require user confirmation.
