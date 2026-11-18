// The process shell around the forge: everything here is the conversation
// with the trial env, and nothing here serves a single forge request (that
// is app.ts's job, reached through createApp below — this file's only
// import, by design).
//
// The env's wire contract fixes the shape of this conversation:
//
//   * MAKEFUN_ENV_URL names the env's origin. No origin, no trial: the
//     process says so on stderr and exits 1 before building anything.
//   * The server binds port 0, so the kernel picks a free port. Port 8080
//     belongs to the env and is never requested.
//   * The bound port is announced with POST <env>/register, body
//     {"port": N}. The env takes the announcement's peer address, pairs it
//     with N, and dials that base URL for the rest of the trial. Only the
//     first announcement counts — a 409 answer means another process won
//     the race, which is not a failure for this one.
//   * GET <env>/done is then polled. The env replies immediately each time
//     ({"done": false} while its suite runs, {"done": true} once its
//     export is written), so the poll is a loop of short requests, never
//     one long-held request, and no error along the way ends the process.
//   * On done, the server is closed and the process exits 0. Any contract
//     error before that point exits 1 with the reason on stderr.
//
// Each env call gets 30 seconds. A step that fails is retried after a wait
// that opens at 250 ms, doubles after every failure, and is capped at
// 2 s; each phase (announce, then wait) keeps its own wait, so a slow
// start does not drag on the polling that follows.

import { createApp } from './app.ts';

/** Milliseconds one register or done call may run before it is given up on and retried. */
const CALL_BUDGET_MS = 30_000;
/** The wait after the first failure of a phase, and the ceiling the doubling stops at. */
const FIRST_WAIT_MS = 250;
const LONGEST_WAIT_MS = 2_000;

/** A promise that settles once `ms` milliseconds have passed. */
function pause(ms: number): Promise<void> {
  return new Promise((settle) => {
    setTimeout(settle, ms);
  });
}

/** An abort signal armed with the per-call budget, fresh for every call. */
function freshDeadline(): AbortSignal {
  return AbortSignal.timeout(CALL_BUDGET_MS);
}

/** The env's origin: MAKEFUN_ENV_URL with any trailing slashes shaved off, '' when unset. */
function readEnvOrigin(): string {
  const given = process.env.MAKEFUN_ENV_URL ?? '';
  let trimmed = given;
  while (trimmed.endsWith('/')) trimmed = trimmed.slice(0, -1);
  return trimmed;
}

/** The text a thrown value contributes to the process's one stderr line. */
function describeFailure(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

/**
 * The two calls the entry ever makes to the env, each with its own retry
 * loop: announce this process's port, then ask until the env is done.
 */
class EnvConversation {
  readonly #origin: string;

  constructor(origin: string) {
    this.#origin = origin;
  }

  /**
   * POST the register body until the env accepts it. A 200 means this
   * process is the entry; a 409 means the first announcement already won
   * and this process simply carries on waiting like any other. A 400 or
   * 405 is the env rejecting the contract itself, so it is thrown and
   * ends the process; every other outcome — the env still starting, a
   * dropped call, an unexpected status — is retried after the wait.
   */
  async announce(port: number): Promise<void> {
    let waitMs = FIRST_WAIT_MS;
    for (;;) {
      const outcome = await this.#tryRegister(port);
      if (outcome === 'registered' || outcome === 'superseded') return;
      if (outcome instanceof Error) throw outcome;
      await pause(waitMs);
      waitMs = Math.min(LONGEST_WAIT_MS, waitMs * 2);
    }
  }

  /** A single register attempt, classified: success, lost race, fatal refusal, or worth retrying. */
  async #tryRegister(port: number): Promise<'registered' | 'superseded' | Error | null> {
    let reply: Response;
    try {
      reply = await fetch(`${this.#origin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: freshDeadline(),
      });
    } catch {
      return null;
    }
    if (reply.status === 200) return 'registered';
    if (reply.status === 409) return 'superseded';
    if (reply.status === 400 || reply.status === 405) {
      let detail = '';
      try {
        detail = await reply.text();
      } catch {
        detail = '';
      }
      return new Error(`the env refused the register call, HTTP ${reply.status}: ${detail}`);
    }
    return null;
  }

  /** Poll /done until the env's answer says the trial is over; return only then. */
  async holdUntilDone(): Promise<void> {
    let waitMs = FIRST_WAIT_MS;
    while (!(await this.#askIfDone())) {
      await pause(waitMs);
      waitMs = Math.min(LONGEST_WAIT_MS, waitMs * 2);
    }
  }

  /** One /done poll: true only for a healthy answer whose JSON body carries done set to true. */
  async #askIfDone(): Promise<boolean> {
    try {
      const reply = await fetch(`${this.#origin}/done`, { signal: freshDeadline() });
      if (!reply.ok) return false;
      const body: unknown = await reply.json();
      if (typeof body !== 'object' || body === null) return false;
      return (body as { done?: unknown }).done === true;
    } catch {
      return false;
    }
  }
}

/**
 * Listen on a kernel-chosen port and hand back the number chosen. A bind
 * failure rejects, as does a listener that somehow has no TCP address.
 */
function bindToAnyPort(server: ReturnType<typeof createApp>): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      const bound = server.address();
      if (bound === null || typeof bound === 'string') {
        reject(new Error('the listener came up without an ephemeral TCP port'));
        return;
      }
      resolve(bound.port);
    });
  });
}

/** The whole life of the process, in order: find the env, serve, announce, wait, close. */
async function live(): Promise<void> {
  const origin = readEnvOrigin();
  if (origin === '') {
    throw new Error('MAKEFUN_ENV_URL is unset: there is no env to register with');
  }
  const env = new EnvConversation(origin);

  const server = createApp();
  const port = await bindToAnyPort(server);
  process.stdout.write(`[entry] listening on port ${port}\n`);

  await env.announce(port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await env.holdUntilDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await live();
  process.exit(0);
} catch (thrown) {
  process.stderr.write(`[entry] ${describeFailure(thrown)}\n`);
  process.exit(1);
}
