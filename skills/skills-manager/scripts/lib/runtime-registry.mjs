// Align runtime mappings with the pinned upstream CLI version.
import { homedir } from 'node:os';
import { join } from 'node:path';

export const RUNTIME_REGISTRY_VERSION = 1;
export const SUPPORTED_SKILLS_CLI_VERSION = '1.5.20';

// Project and global paths verified against skills@1.5.20's src/agents.ts.
const definitions = [
  ['amp', '.agents/skills', ({ configHome }) => join(configHome, 'agents/skills'), '.amp'],
  ['antigravity', '.agents/skills', ({ home }) => join(home, '.gemini/antigravity/skills'), '.gemini/antigravity'],
  ['claude-code', '.claude/skills', ({ claudeHome }) => join(claudeHome, 'skills')],
  ['cline', '.agents/skills', ({ home }) => join(home, '.agents/skills'), '.cline'],
  ['codebuddy', '.codebuddy/skills', ({ home }) => join(home, '.codebuddy/skills')],
  ['codex', '.agents/skills', ({ codexHome }) => join(codexHome, 'skills'), '.codex'],
  ['command-code', '.commandcode/skills', ({ home }) => join(home, '.commandcode/skills')],
  ['cursor', '.agents/skills', ({ home }) => join(home, '.cursor/skills'), '.cursor'],
  ['droid', '.factory/skills', ({ home }) => join(home, '.factory/skills')],
  ['gemini-cli', '.agents/skills', ({ home }) => join(home, '.gemini/skills'), '.gemini'],
  [
    'github-copilot',
    '.agents/skills',
    ({ home }) => join(home, '.copilot/skills'),
    '.github/copilot-instructions.md',
  ],
  ['kiro-cli', '.kiro/skills', ({ home }) => join(home, '.kiro/skills')],
  ['neovate', '.neovate/skills', ({ home }) => join(home, '.neovate/skills')],
  ['opencode', '.agents/skills', ({ configHome }) => join(configHome, 'opencode/skills'), '.opencode'],
  ['openhands', '.openhands/skills', ({ home }) => join(home, '.openhands/skills')],
  ['pi', '.pi/skills', ({ home }) => join(home, '.pi/agent/skills')],
  ['qoder', '.qoder/skills', ({ home }) => join(home, '.qoder/skills')],
  ['roo', '.roo/skills', ({ home }) => join(home, '.roo/skills')],
  ['windsurf', '.windsurf/skills', ({ home }) => join(home, '.codeium/windsurf/skills')],
  ['zencoder', '.zencoder/skills', ({ home }) => join(home, '.zencoder/skills')],
];

function environmentPaths(environment) {
  const home = environment.HOME || homedir();
  const configHome = environment.XDG_CONFIG_HOME || join(home, '.config');
  return {
    home,
    configHome,
    codexHome: environment.CODEX_HOME?.trim() || join(home, '.codex'),
    claudeHome: environment.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude'),
  };
}

export function runtimeRegistry(environment = process.env) {
  const paths = environmentPaths(environment);
  return definitions.map(([id, projectSkillsDirectory, globalDirectory, projectEvidenceDirectory]) => ({
    id,
    projectSkillsDirectory,
    projectEvidenceDirectory: projectEvidenceDirectory || projectSkillsDirectory.split('/')[0],
    globalSkillsDirectory: globalDirectory(paths),
  }));
}
