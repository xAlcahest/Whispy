import { spawnSync } from 'node:child_process'

export const commandExists = (command: string): boolean => {
  const lookupCommand = process.platform === 'win32' ? 'where' : 'which'
  const probe = spawnSync(lookupCommand, [command], {
    encoding: 'utf8',
    timeout: 1500,
    windowsHide: true,
  })

  return probe.status === 0
}

export const resolveCommandPath = (command: string): string | null => {
  const lookupCommand = process.platform === 'win32' ? 'where' : 'which'
  const probe = spawnSync(lookupCommand, [command], {
    encoding: 'utf8',
    timeout: 1500,
    windowsHide: true,
  })

  if (probe.status !== 0) {
    return null
  }

  const resolved = probe.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)

  return resolved ?? null
}
