import { closeSync, constants, mkdirSync, openSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { OwnerLock } from './contracts.js';

/** A kernel lock; inherited descriptors keep the lease while an old helper is alive. */
export function acquireOwnerLock(dataDir: string): OwnerLock {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const canonical = realpathSync(dataDir);
  const fd = openSync(join(canonical, 'owner.lock'), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  // BSD flock belongs to the shared open file description: the parent fd keeps it after Perl exits.
  const locked = spawnSync('/usr/bin/perl', ['-MFcntl=:flock', '-e', 'open(my $fd, "+<&=3") or exit 2; flock($fd, LOCK_EX | LOCK_NB) or exit 1;'], { env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'ignore', 'pipe', fd], timeout: 5_000 });
  if (locked.status !== 0) { closeSync(fd); throw new Error(locked.status === 1 ? 'This data directory already has an active owner or execution helper' : 'Kernel ownership lock is unavailable; system Perl is required on macOS'); }
  let released = false;
  // Do not LOCK_UN: a child can still own the inherited open file description.
  return { fd, release() { if (!released) { closeSync(fd); released = true; } } };
}
