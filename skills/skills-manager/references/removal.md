# Removal and self-Update

## Installation removal

1. Resolve the exact Skill identity and scope through public `npx skills list --json` output. Locate the matching Patch document as defined in [Patches](patches.md).
2. Present the exact removal selection for approval. If Active Patches exist, explain that removing the Installation's final target also removes those durable customizations.
3. Run the ordinary package operation, preserving its scope and target-Agent interaction:

   ```sh
   npx skills remove <skill-name>
   npx skills remove <skill-name> --global
   ```

4. After success, list the selected scope again. If the Installation still has a target Agent, retain its Patch document. If its final target disappeared, delete the document. Leave the other scope untouched and never retain an orphan document.

Removal is complete when the listing proves whether the Installation remains and the Patch document lifecycle matches that result.

## Skills Manager self-Update

1. Before mutation, resolve the exact Skills Manager Installation and its Patch document using the normal Update checks.
2. If it has any Active Patch, reject self-Update before running the package command. Explain that preserving customized management instructions across the session boundary is unsupported; leave the Installation and document unchanged.
3. If no Patch document exists, run the ordinary Update with the resolved scope:

   ```sh
   npx skills update skills-manager --project
   npx skills update skills-manager --global
   ```

4. If it succeeds, end Skills Manager work immediately and ask the user to start a new Agent session so the new instructions are loaded. If it fails, follow the ordinary uncertain-mutation boundary and do not retry automatically.
