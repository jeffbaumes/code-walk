#!/usr/bin/env node
// Builds a small demo repo (main + feature branch + staged/unstaged edits) and a walk that
// exercises every block type, then serves it. Usage: npm run demo [-- <dir>] [--no-serve]
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server.js';

const args = process.argv.slice(2);
const noServe = args.includes('--no-serve');
const dir = path.resolve(args.find((a) => !a.startsWith('--')) || path.join(os.tmpdir(), 'code-walk-demo'));
const repo = path.join(dir, 'gateway');

rmSync(dir, { recursive: true, force: true });
mkdirSync(path.join(repo, 'src'), { recursive: true });

const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' }).toString().trim();
const write = (f, s) => { mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); writeFileSync(path.join(repo, f), s); };
const commit = (msg, date) => {
  git('add', '-A');
  execFileSync('git', ['commit', '-q', '-m', msg], {
    cwd: repo,
    env: { ...process.env, GIT_AUTHOR_NAME: 'Ada Lovelace', GIT_AUTHOR_EMAIL: 'ada@example.com', GIT_COMMITTER_NAME: 'Ada Lovelace', GIT_COMMITTER_EMAIL: 'ada@example.com', GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
};

git('init', '-q', '-b', 'main');

write('src/router.ts', `import { Request, Response } from './http';

export type Handler = (req: Request) => Promise<Response>;

const routes = new Map<string, Handler>();

export function register(path: string, handler: Handler) {
  routes.set(path, handler);
}

export async function route(req: Request): Promise<Response> {
  const handler = routes.get(req.path);
  if (!handler) {
    return { status: 404, body: 'Not found' };
  }
  return handler(req);
}
`);
write('src/http.ts', `export interface Request {
  path: string;
  clientId: string;
  headers: Record<string, string>;
}

export interface Response {
  status: number;
  body: string;
  headers?: Record<string, string>;
}
`);
write('README.md', '# gateway\n\nA tiny API gateway.\n');
commit('Initial gateway with a simple router', '2026-09-01T10:00:00Z');

git('checkout', '-q', '-b', 'feature/rate-limit');

write('src/limiter.ts', `export interface LimiterOptions {
  /** Maximum tokens a client can accumulate. */
  capacity: number;
  /** Tokens added per second. */
  refillPerSecond: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(private readonly opts: LimiterOptions, private readonly now = () => Date.now()) {}

  /** Try to spend one token for \`clientId\`. Returns false when the client is over its limit. */
  take(clientId: string): boolean {
    const bucket = this.refill(clientId);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  private refill(clientId: string): Bucket {
    const now = this.now();
    const bucket = this.buckets.get(clientId) ?? { tokens: this.opts.capacity, updatedAt: now };
    const elapsed = (now - bucket.updatedAt) / 1000;
    bucket.tokens = Math.min(this.opts.capacity, bucket.tokens + elapsed * this.opts.refillPerSecond);
    bucket.updatedAt = now;
    this.buckets.set(clientId, bucket);
    return bucket;
  }
}
`);
commit('Add token bucket rate limiter', '2026-09-02T09:30:00Z');

write('src/router.ts', `import { Request, Response } from './http';
import { RateLimiter } from './limiter';

export type Handler = (req: Request) => Promise<Response>;

const routes = new Map<string, Handler>();
const limiter = new RateLimiter({ capacity: 20, refillPerSecond: 5 });

export function register(path: string, handler: Handler) {
  routes.set(path, handler);
}

export async function route(req: Request): Promise<Response> {
  if (!limiter.take(req.clientId)) {
    return { status: 429, body: 'Too many requests', headers: { 'retry-after': '1' } };
  }
  const handler = routes.get(req.path);
  if (!handler) {
    return { status: 404, body: \`No route for \${req.path}\` };
  }
  return handler(req);
}
`);
write('README.md', '# gateway\n\nA tiny API gateway with per-client rate limiting.\n');
commit('Rate limit requests in the router', '2026-09-03T14:12:00Z');

// Staged + unstaged edits for the non-commit block types.
write('src/limiter.ts', git('show', 'HEAD:src/limiter.ts').replace('  capacity: number;', '  capacity: number;\n  /** Optional name used in logs. */\n  name?: string;') + '\n');
git('add', 'src/limiter.ts');
write('src/limiter.ts', git('show', ':src/limiter.ts').replace('if (bucket.tokens < 1) return false;', 'if (bucket.tokens < 1) {\n      console.warn(`[${this.opts.name ?? \'limiter\'}] throttled ${clientId}`);\n      return false;\n    }'));

writeFileSync(path.join(dir, 'rate-limit.md'), `---
title: Per-client rate limiting
repos:
  gateway: ./gateway
---

This branch adds a **token bucket** rate limiter and puts it in front of the router. Each client gets a bucket that refills at a steady rate; a request spends one token or gets a \`429\`.

\`\`\`diff --stat main...feature/rate-limit
- group: Rate limiting
  note: The limiter and where it's enforced
  files:
    src/limiter.ts: New token bucket
    src/router.ts: 429 before route lookup
- group: Docs
  files: README.md
\`\`\`

\`\`\`mermaid
flowchart LR
  req([Request]) --> take{"limiter.take(clientId)"}
  take -- token available --> route[Route lookup] --> handler[Handler]
  take -- bucket empty --> r429([429 Too many requests])
\`\`\`

## The limiter

The whole feature lives in one new file. Here's the core: \`take\` spends a token, and \`refill\` lazily tops the bucket up based on elapsed time, so there's no timer per client.

\`\`\`show feature/rate-limit:src/limiter.ts L19-36
highlight: 29-30
\`\`\`

Refill is computed on demand. The highlighted lines are the whole algorithm: elapsed seconds times the refill rate, capped at capacity.

## Wiring it into the router

The router checks the limiter before looking up a handler, so throttled clients never reach handler code.

\`\`\`diff main...feature/rate-limit -- src/router.ts
\`\`\`

Just the rejection path:

\`\`\`diff main...feature/rate-limit -- src/router.ts R14-16
\`\`\`

## Commit by commit

\`\`\`show HEAD~1
\`\`\`

## Work in progress

Staged: an optional \`name\` for log messages.

\`\`\`diff --cached -- src/limiter.ts
\`\`\`

Not yet staged: logging when a client is throttled.

\`\`\`diff -- src/limiter.ts
\`\`\`

## Everything else

\`\`\`diff main...feature/rate-limit -- README.md
\`\`\`
`);

console.log(`Demo repo: ${repo}\nDemo walk: ${path.join(dir, 'rate-limit.md')}`);
if (!noServe) {
  startServer({ target: path.join(dir, 'rate-limit.md'), port: 4747, onListen: ({ url }) => console.log(`Serving at ${url}`) });
}
