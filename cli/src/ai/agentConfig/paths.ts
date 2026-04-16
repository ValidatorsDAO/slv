import { resolveHome } from '/lib/getApiKeyFromYml.ts'

/**
 * Centralized filesystem path helpers for agent configuration.
 * All callers should go through these helpers rather than string-building
 * `${home}/.slv/...` inline, so paths can be overridden for tests and
 * stay consistent with `resolveHome()` (which handles sudo-invoked shells).
 */

export const resolveSlvDir = (home: string = resolveHome()): string =>
  `${home}/.slv`

export const resolveAgentDir = (home: string = resolveHome()): string =>
  `${resolveSlvDir(home)}/agent`

export const resolveSkillsDir = (home: string = resolveHome()): string =>
  `${resolveSlvDir(home)}/skills`

export const resolveApiYmlPath = (home: string = resolveHome()): string =>
  `${resolveSlvDir(home)}/api.yml`

export const resolveAgentConfigPath = (home: string = resolveHome()): string =>
  `${resolveAgentDir(home)}/config.yml`

export const resolveSoulMdPath = (home: string = resolveHome()): string =>
  `${resolveAgentDir(home)}/SOUL.md`

export const resolveUserMdPath = (home: string = resolveHome()): string =>
  `${resolveAgentDir(home)}/USER.md`

export const resolveMemoryMdPath = (home: string = resolveHome()): string =>
  `${resolveAgentDir(home)}/MEMORY.md`

export const resolveSkillMdPath = (
  skillName: string,
  home: string = resolveHome(),
): string => `${resolveSkillsDir(home)}/${skillName}/SKILL.md`

export const resolveAgentMdPath = (
  skillName: string,
  home: string = resolveHome(),
): string => `${resolveSkillsDir(home)}/${skillName}/AGENT.md`
