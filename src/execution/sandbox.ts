import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { ToolCall } from '../runtime/contracts.js';
import type { ExecutionResult, Executor, SandboxOptions } from './contracts.js';

export function sandboxCapability(): { sandbox: boolean; reason?: string; platform: string } {
  if (process.platform !== 'darwin') return { sandbox: false, platform: process.platform, reason: 'Execution currently requires macOS sandbox-exec; other platforms fail closed' };
  const probe = spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1) (deny default) (allow process-exec) (allow file-read*)', '/usr/bin/true'], { encoding: 'utf8', timeout: 5_000 });
  return { sandbox: probe.status === 0, platform: process.platform, ...(probe.status === 0 ? {} : { reason: 'macOS sandbox-exec is unavailable or denied by the enclosing environment' }) };
}
const quote = (value: string) => JSON.stringify(value);
function profile(workdir: string, temp: string, helper: string, protectedPaths: string[], network: boolean): string {
  const executable = realpathSync(process.execPath);
  const reads = ['/System', '/usr', '/bin', '/sbin', '/Library/Apple', '/opt/homebrew/Cellar', '/opt/homebrew/opt', '/opt/homebrew/bin', '/opt/homebrew/lib', '/usr/local/lib', '/private/var/db/dyld', dirname(executable), workdir, temp];
  const appContents = executable.indexOf('.app/Contents/');
  if (appContents >= 0) reads.push(executable.slice(0, appContents + '.app/Contents'.length));
  const ancestors = new Set<string>([workdir]);
  const denied = protectedPaths.map(path => {
    const candidate = resolve(workdir, path);
    if (candidate !== workdir && (relative(workdir, candidate).startsWith('..') || isAbsolute(relative(workdir, candidate)))) throw new Error('Protected path must be within the worktree');
    for (let parent = dirname(candidate); parent === workdir || (parent.startsWith(workdir + '/')); parent = dirname(parent)) { ancestors.add(parent); if (parent === workdir) break; }
    return `(subpath ${quote(candidate)})`;
  });
  return `(version 1)\n(deny default)\n(allow process-exec process-fork sysctl-read)\n(allow process-info* (target same-sandbox))\n(allow signal (target same-sandbox))\n(allow mach-lookup (global-name "com.apple.system.logger") (global-name "com.apple.system.notification_center"))\n(allow file-read-metadata)\n(allow file-read* ${reads.map(path => `(subpath ${quote(path)})`).join(' ')} (literal ${quote(helper)}) (literal "/") (literal "/dev/zero") (subpath "/dev/fd") (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random") (literal "/private/etc/localtime") (literal "/private/etc/hosts") (literal "/private/etc/resolv.conf"))\n(allow file-write* (subpath ${quote(workdir)}) (subpath ${quote(temp)}) (literal "/dev/null"))\n(deny file-write* (regex #"(^|/)\\.git(/|$)") ${denied.join(' ')})\n(deny file-write-unlink file-write-create ${[...ancestors].map(path => `(literal ${quote(path)})`).join(' ')})\n${network ? '(allow network-outbound (remote unix-socket (literal "/private/var/run/mDNSResponder"))) (allow network-outbound (remote ip)) (allow network-inbound (local ip)) (allow network-bind (local ip))' : '(deny network*)'}\n`;
}

/** Every effect, including reads, happens in a sanitized child with OS-enforced scope. */
export class SandboxExecutor implements Executor {
  async execute(call: ToolCall, options: SandboxOptions, signal: AbortSignal): Promise<ExecutionResult> {
    if (signal.aborted) return { text: 'Execution cancelled', isError: true };
    const capability = sandboxCapability();
    if (!capability.sandbox) throw new Error(capability.reason);
    const workdir = realpathSync(options.workdir);
    const temp = realpathSync(mkdtempSync(join(tmpdir(), 'knotrail-exec-')));
    const bundled = fileURLToPath(new URL('./helper.mjs', import.meta.url));
    if (!existsSync(bundled)) throw new Error('Sandbox helper missing');
    const helper = realpathSync(bundled);
    const policy = profile(workdir, temp, helper, options.protectedPaths, options.allowNetwork);
    const child = spawn('/usr/bin/sandbox-exec', ['-p', policy, process.execPath, helper], {
      cwd: workdir, detached: true,
      env: { PATH: `${dirname(process.execPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: temp, TMPDIR: temp, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', OPENSSL_CONF: '/dev/null', ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe', 'ignore', options.lockFd],
    });
    let result: ExecutionResult | undefined, stderr = '', cancelled = false, settled = false;
    return new Promise((resolveResult, reject) => {
      let terminationSubmitted = false, childClosed = false;
      let terminationError: unknown;
      let closeCode: number | null = null, closeSignal: NodeJS.Signals | null = null;
      const maybeFinish = () => {
        if (settled || !childClosed || !terminationSubmitted) return;
        clearTimeout(timer); signal.removeEventListener('abort', abort); rmSync(temp, { recursive: true, force: true }); settled = true;
        if (terminationError) { reject(terminationError); return; }
        resolveResult(cancelled ? { text: 'Execution cancelled or timed out', isError: true } : result || { text: stderr || `Sandbox helper exited without a result (${closeCode ?? closeSignal})`, isError: true });
      };
      const killGroup = () => {
        if (!child.pid) terminationSubmitted = true;
        else if (!terminationSubmitted) {
          try { process.kill(-child.pid, 'SIGKILL'); terminationSubmitted = true; }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') terminationSubmitted = true;
            else { terminationError ??= error; }
          }
        }
        maybeFinish();
      };
      const abort = () => { cancelled = true; killGroup(); };
      const timer = setTimeout(abort, options.timeoutMs);
      signal.addEventListener('abort', abort, { once: true });
      child.stderr?.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8_000); });
      let protocol = '';
      child.stdout?.on('data', chunk => { protocol += chunk.toString(); const end = protocol.indexOf('\n'); if (end >= 0) { try { result = JSON.parse(protocol.slice(0, end)) as ExecutionResult; } catch { result = { text: 'Invalid sandbox helper response', isError: true }; } killGroup(); } });
      child.stdin?.on('error', () => {});
      child.stdin?.write(JSON.stringify({ call, workdir, temp, protectedPaths: options.protectedPaths, timeoutMs: options.timeoutMs }) + '\n');
      child.once('error', error => { terminationError ??= error; killGroup(); });
      child.once('close', (code, exitSignal) => {
        childClosed = true; closeCode = code; closeSignal = exitSignal;
        // Closed helper pipes alone do not prove that same-group background descendants stopped.
        killGroup();
      });
    });
  }
}
