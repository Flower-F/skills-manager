# Use native Node ESM without a build step

Repository checks use native Node ESM `.mjs` files and the built-in `node:test` runner. The distributed Skill requires no runtime script. The project has no TypeScript compilation, runtime loader, Python dependency, or third-party package dependency.

Skills Manager deliberately supports Node 22 and later. This is the project's tested support boundary rather than a requirement inherited from `npx skills`; CI covers Node 22 as the minimum and Node 24 as the other supported LTS line. Native execution keeps repository checks small and avoids carrying generated JavaScript or `node_modules` into runtime installations.

If code is later contributed upstream to a TypeScript codebase, conversion happens at that contribution boundary rather than introducing a build system here.
