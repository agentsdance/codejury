import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Tests must not read a developer's global judge or Git configuration.
export function testEnvironment(parent = process.env) {
  const home = mkdtempSync(path.join(tmpdir(), 'jury-test-home-'));
  const gitConfig = path.join(home, '.gitconfig');
  writeFileSync(gitConfig, '[user]\n name = Code Jury Test\n email = test@example.com\n');
  return {
    env: { ...parent, HOME: home, USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, '.config'), GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' },
    dispose: () => rmSync(home, { recursive: true, force: true }),
  };
}
