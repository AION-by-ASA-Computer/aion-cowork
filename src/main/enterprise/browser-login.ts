/**
 * Desktop browser login (PKCE + loopback callback), see docs/enterprise-api-contract.md
 * ("Login desktop via browser"). The system browser shows the server web login page; the
 * server redirects to http://127.0.0.1:<port>/callback?code=...&state=... which this module
 * receives, validates and turns into {code, codeVerifier} for POST /auth/desktop/exchange.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { EnterpriseError } from '../../shared/enterprise-types';
import { EnterpriseHttpError } from './auth';

export const BROWSER_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

export class BrowserLoginError extends EnterpriseHttpError {
  constructor(code: string, message: string) {
    super(0, { code, message });
    this.name = 'BrowserLoginError';
  }
}

export interface BrowserLoginOptions {
  /** Normalized API endpoint (informational; the browser URL is built from loginUrl). */
  endpoint: string;
  /** Web login page of the server. */
  loginUrl: string;
  /** Opens a URL in the system browser (index.ts passes shell.openExternal). */
  openExternal: (url: string) => Promise<void> | void;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface BrowserLoginResult {
  code: string;
  codeVerifier: string;
}

export function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}

export function createPkce(): { codeVerifier: string; challenge: string; state: string } {
  const codeVerifier = base64url(randomBytes(48));
  const challenge = base64url(createHash('sha256').update(codeVerifier).digest());
  const state = base64url(randomBytes(24));
  return { codeVerifier, challenge, state };
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function buildBrowserUrl(
  loginUrl: string,
  params: { state: string; challenge: string; redirect: string }
): string {
  const url = new URL(loginUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BrowserLoginError('invalid_login_url', 'Login URL must use http or https');
  }
  url.searchParams.set('desktop', '1');
  url.searchParams.set('state', params.state);
  url.searchParams.set('challenge', params.challenge);
  url.searchParams.set('redirect', params.redirect);
  return url.toString();
}

function page(ok: boolean, title: string, text: string): string {
  const color = ok ? '#16a34a' : '#dc2626';
  return `<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AION Cowork</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f6f7f9;color:#1f2937;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}main{max-width:420px;margin:24px;padding:32px;background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.08);text-align:center}h1{font-size:20px;margin:0 0 12px;color:${color}}p{margin:0;font-size:15px;line-height:1.5;color:#4b5563}small{display:block;margin-top:20px;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#9ca3af}</style></head><body><main><h1>${title}</h1><p>${text}</p><small>AION Cowork</small></main></body></html>`;
}

const PAGE_OK = page(true, 'Accesso completato', 'Accesso completato. Puoi tornare ad AION Cowork.');
const PAGE_MISMATCH = page(
  false,
  'Accesso non riuscito',
  'La richiesta di accesso non è valida o è scaduta. Torna ad AION Cowork e riprova.'
);
const PAGE_ERROR = page(
  false,
  'Accesso non riuscito',
  "Il server ha segnalato un errore durante l'accesso. Torna ad AION Cowork e riprova."
);

let activeCancel: (() => void) | null = null;

/** Cancels the login in progress (if any); the pending promise rejects with login_cancelled. */
export function cancelBrowserLogin(): void {
  activeCancel?.();
}

export function startBrowserLogin(options: BrowserLoginOptions): Promise<BrowserLoginResult> {
  // Only one login at a time: a new one supersedes the previous.
  activeCancel?.();

  const { codeVerifier, challenge, state } = createPkce();
  const timeoutMs = options.timeoutMs ?? BROWSER_LOGIN_TIMEOUT_MS;

  return new Promise<BrowserLoginResult>((resolve, reject) => {
    let settled = false;
    let handled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const server = http.createServer();

    const cleanup = (done: () => void) => {
      if (timer) clearTimeout(timer);
      timer = null;
      options.signal?.removeEventListener('abort', onAbort);
      if (activeCancel === cancel) activeCancel = null;
      let called = false;
      const finishOnce = () => {
        if (!called) {
          called = true;
          done();
        }
      };
      if (!server.listening) return finishOnce();
      server.close(finishOnce);
      server.closeIdleConnections?.();
    };

    const settle = (outcome: { ok: BrowserLoginResult } | { err: EnterpriseError }) => {
      if (settled) return;
      settled = true;
      cleanup(() => {
        if ('ok' in outcome) resolve(outcome.ok);
        else reject(new BrowserLoginError(outcome.err.code, outcome.err.message));
      });
    };

    const cancel = () =>
      settle({ err: { code: 'login_cancelled', message: 'Login cancelled' } });
    const onAbort = () => cancel();

    activeCancel = cancel;
    if (options.signal?.aborted) {
      cancel();
      return;
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });

    server.on('request', (req, res) => {
      let url: URL;
      try {
        url = new URL(req.url ?? '/', 'http://127.0.0.1');
      } catch {
        res.writeHead(404, { Connection: 'close' }).end();
        return;
      }
      if (req.method !== 'GET' || url.pathname !== '/callback' || settled || handled) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' });
        res.end('Not found');
        return;
      }
      const gotState = url.searchParams.get('state') ?? '';
      const code = url.searchParams.get('code');
      const errorParam = url.searchParams.get('error');

      let outcome: { ok: BrowserLoginResult } | { err: EnterpriseError };
      let html: string;
      let status = 200;
      if (!safeEqual(gotState, state)) {
        outcome = { err: { code: 'state_mismatch', message: 'Login state mismatch' } };
        html = PAGE_MISMATCH;
        status = 400;
      } else if (errorParam) {
        // Do not reflect the value into the page; pass a bounded token to the app only.
        outcome = {
          err: { code: 'exchange_failed', message: `Login failed: ${errorParam.slice(0, 80)}` },
        };
        html = PAGE_ERROR;
        status = 400;
      } else if (!code) {
        outcome = { err: { code: 'exchange_failed', message: 'Callback did not include a code' } };
        html = PAGE_ERROR;
        status = 400;
      } else {
        outcome = { ok: { code, codeVerifier } };
        html = PAGE_OK;
      }
      handled = true;
      res.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'close',
      });
      res.end(html, () => settle(outcome));
    });

    server.on('error', (err) => {
      settle({ err: { code: 'callback_server_failed', message: err.message } });
    });

    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      let browserUrl: string;
      try {
        browserUrl = buildBrowserUrl(options.loginUrl, {
          state,
          challenge,
          redirect: `http://127.0.0.1:${port}/callback`,
        });
      } catch (err) {
        const e = err as BrowserLoginError;
        settle({ err: { code: e.error?.code ?? 'invalid_login_url', message: e.message } });
        return;
      }
      timer = setTimeout(
        () => settle({ err: { code: 'login_timeout', message: 'Login timed out' } }),
        timeoutMs
      );
      if (typeof timer === 'object' && 'unref' in timer) timer.unref();
      Promise.resolve()
        .then(() => options.openExternal(browserUrl))
        .catch((err) =>
          settle({
            err: {
              code: 'browser_open_failed',
              message: `Cannot open the browser: ${err instanceof Error ? err.message : String(err)}`,
            },
          })
        );
    });
  });
}
