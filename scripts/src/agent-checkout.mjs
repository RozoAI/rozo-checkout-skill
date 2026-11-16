/**
 * Agent Checkout flows (beta, off unless ROZO_AGENT_CHECKOUT_BETA=1).
 *
 * Each run* returns a JSON-safe payload or throws a coded SkillError. None of
 * them ever returns the full credential or the bind code.
 */

import { SkillError } from './lib/output.mjs';
import {
  acApi,
  acBase,
  maskCredential,
  prepareCredentialWrite,
  readCredential,
  validateBindCode,
  resolveIdempotencyKey,
  readIdempotencyRecord,
  writeIdempotencyRecord,
  summarizeRequest,
  BINDING_TEXT,
  CREDENTIAL_RE,
  FINGERPRINT_RE,
} from './lib/agent-checkout.mjs';

export const CONFIRM_NOTE = 'Ask your owner to confirm this agent in Discord. The credential works only after they confirm.';
export const NOTHING_PAID_NOTE =
  'Nothing is paid until your owner approves this request in Discord. This agent never pays and never sees a pay link.';

/** Read all of stdin (piped bind code). */
export async function readAllStdin(stream = process.stdin) {
  let data = '';
  for await (const chunk of stream) {
    data += chunk;
    if (data.length > 4096) break;
  }
  return data;
}

export async function runBind(opts, { readCode, fetchImpl, env = process.env } = {}) {
  acBase(env); // refuse an untrusted router before the code is even read
  // Prepare the write before the claim: the bind code is single use, so a
  // claim whose credential cannot be saved would be lost. This creates and
  // checks the private dir, refuses an existing file (unless --force), and
  // opens an exclusive 0600 temp file.
  const writer = prepareCredentialWrite({ force: Boolean(opts.force), env });
  try {
    const fromArgv = opts.bindCodeArg && opts.bindCodeArg !== '-';
    const raw = fromArgv ? opts.bindCodeArg : await readCode();
    const bindCode = validateBindCode(raw);

    const { json } = await acApi('POST', '/bind-requests/claim', {
      body: { bindCode, displayName: opts.displayName },
      fetchImpl,
      env,
    });
    if (!CREDENTIAL_RE.test(json?.credential || '')) {
      throw new SkillError('CREDENTIAL_INVALID', 'The router returned a credential in an unexpected format; nothing was saved.');
    }
    const fingerprint = FINGERPRINT_RE.test(json.fingerprint || '') ? json.fingerprint : null;
    const bindRequestId = typeof json.bindRequestId === 'string' && /^[0-9a-f-]{36}$/i.test(json.bindRequestId) ? json.bindRequestId : null;
    const file = writer.commit({ credential: json.credential, fingerprint, bindRequestId, claimedAt: new Date().toISOString() });
    return {
      success: true,
      status: ['claimed', 'pending_confirm'].includes(json.status) ? json.status : 'claimed',
      credentialMasked: maskCredential(json.credential),
      fingerprint,
      bindRequestId,
      confirmExpiresAt: typeof json.confirmExpiresAt === 'string' && !Number.isNaN(Date.parse(json.confirmExpiresAt)) ? json.confirmExpiresAt : null,
      storedAt: file,
      note: CONFIRM_NOTE,
      ...(fromArgv ? { tip: 'Next time pipe the code in (rozo-checkout bind -) to keep it out of shell history.' } : {}),
    };
  } finally {
    writer.abort(); // no-op after a successful commit
  }
}

export async function runBindingStatus(_opts, { fetchImpl, env = process.env } = {}) {
  acBase(env); // refuse an untrusted router before the credential is read
  const rec = readCredential(env);
  const { json } = await acApi('GET', '/binding', { credential: rec.credential, fetchImpl, env });
  const status = typeof json.status === 'string' ? json.status : null;
  return {
    success: true,
    status,
    statusText: BINDING_TEXT[status] ?? null,
    fingerprint: FINGERPRINT_RE.test(json.fingerprint || '') ? json.fingerprint : rec.fingerprint ?? null,
    credentialMasked: maskCredential(rec.credential),
  };
}

export async function runRequest(opts, { fetchImpl, env = process.env } = {}) {
  acBase(env); // refuse an untrusted router before the credential is read
  const rec = readCredential(env);
  const { key, reused, generated } = resolveIdempotencyKey({
    invoiceId: opts.invoice.invoiceId,
    explicit: opts.idempotencyKey,
    fingerprint: rec.fingerprint ?? null,
    env,
  });
  const body = {
    invoice: opts.invoice.url,
    context: opts.context,
    entry: 'cli',
    ...(opts.fundingPreference ? { fundingPreference: opts.fundingPreference } : {}),
  };
  let res;
  try {
    res = await acApi('POST', '/requests', { body, credential: rec.credential, idempotencyKey: key, fetchImpl, env });
  } catch (err) {
    if (err instanceof SkillError) err.details = { ...(err.details || {}), idempotencyKey: key };
    throw err;
  }
  const request = summarizeRequest(res.json.request);
  if (request?.spendRequestId) {
    const saved = readIdempotencyRecord(opts.invoice.invoiceId, env);
    writeIdempotencyRecord(
      opts.invoice.invoiceId,
      { ...(saved || {}), idempotencyKey: key, fingerprint: rec.fingerprint ?? null, spendRequestId: request.spendRequestId },
      env,
    );
  }
  const pendingQuote = res.status === 202;
  return {
    success: true,
    httpStatus: res.status,
    replay: Boolean(res.json.replay),
    pendingQuote,
    ...(res.json.quoteError ? { quoteError: String(res.json.quoteError) } : {}),
    idempotencyKey: key,
    idempotencyKeyReused: reused,
    idempotencyKeyGenerated: generated,
    request,
    note: pendingQuote
      ? 'The quote is not ready yet. Rerun this same command later; it reuses the same idempotency key. ' + NOTHING_PAID_NOTE
      : NOTHING_PAID_NOTE,
  };
}

export async function runRequestStatus(opts, { fetchImpl, env = process.env } = {}) {
  acBase(env); // refuse an untrusted router before the credential is read
  const rec = readCredential(env);
  const { json } = await acApi('GET', `/requests/${encodeURIComponent(opts.spendRequestId)}`, {
    credential: rec.credential,
    fetchImpl,
    env,
  });
  return { success: true, request: summarizeRequest(json.request) };
}
