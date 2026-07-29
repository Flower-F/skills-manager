# Removal and self-Update

## Managed removal

1. Resolve the exact Skill identity and scope through public `npx skills list --json` output and obtain approval for the upstream removal selection.
2. Run the ordinary upstream command, retaining its scope and target-Agent interaction:

   ```sh
   npx skills remove <skill-name>
   npx skills remove <skill-name> --global
   ```

3. After success, run public listing again for the selected scope. If the Installation still has any target Agent, retain its Intent document. If its final target disappeared, delete that scope's Intent document.
4. Leave the other scope untouched. Explicit independent copies remain upstream-owned.

Managed removal is complete when public listing proves whether the selected Installation remains, its document lifecycle matches that result, and the other scope is unchanged. Limit cleanup and reconciliation to operations completed through this guided branch.

## Skills Manager self-Update

Run the ordinary upstream command:

```sh
npx skills update skills-manager
```

After success, end the current management workflow immediately and ask the user to start a new Agent session. Self-Update is complete when the upstream command succeeded and the new session is the next Skills Manager action.
