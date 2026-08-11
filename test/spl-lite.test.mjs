// spl-lite.mjs must stay byte-identical to what @solana/spl-token produced.
//
// The vectors in spl-lite-vectors.json were generated with
// @solana/spl-token@0.4.9 (getAssociatedTokenAddressSync +
// createTransferCheckedInstruction) at the moment the dependency was removed.
// If any of these fail, the replacement diverges from the reference
// implementation and MUST NOT be shipped — this code signs real transfers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createTransferCheckedInstruction,
  getAccount,
  getMint,
  TOKEN_PROGRAM_ID,
} from '../scripts/src/spl-lite.mjs';

const vectors = JSON.parse(
  readFileSync(new URL('./spl-lite-vectors.json', import.meta.url), 'utf8'),
);

test('ATA derivation matches @solana/spl-token reference vectors', async () => {
  for (const v of vectors) {
    const ata = await getAssociatedTokenAddress(new PublicKey(v.mint), new PublicKey(v.owner));
    assert.equal(ata.toBase58(), v.ata);
  }
});

test('TransferChecked instruction matches reference vectors byte for byte', async () => {
  for (const v of vectors) {
    const ix = createTransferCheckedInstruction(
      new PublicKey(v.ata),
      new PublicKey(v.mint),
      new PublicKey(v.dest),
      new PublicKey(v.owner),
      BigInt(v.amount),
      v.decimals,
    );
    assert.equal(Buffer.from(ix.data).toString('hex'), v.ixData);
    assert.deepEqual(
      ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
      v.ixKeys,
    );
    assert.equal(ix.programId.toBase58(), v.programId);
  }
});

function fakeConnection(data, owner = TOKEN_PROGRAM_ID) {
  return { getAccountInfo: async () => ({ owner, data }) };
}

test('token account layout parses mint, owner and amount', async () => {
  const mint = new PublicKey(vectors[0].mint);
  const owner = new PublicKey(vectors[0].owner);
  const buf = Buffer.alloc(165);
  mint.toBuffer().copy(buf, 0);
  owner.toBuffer().copy(buf, 32);
  buf.writeBigUInt64LE(873054189007860n, 64);
  const acc = await getAccount(fakeConnection(buf), new PublicKey(vectors[0].ata));
  assert.equal(acc.mint.toBase58(), mint.toBase58());
  assert.equal(acc.owner.toBase58(), owner.toBase58());
  assert.equal(acc.amount, 873054189007860n);
});

test('mint layout parses decimals and supply', async () => {
  const buf = Buffer.alloc(82);
  buf.writeBigUInt64LE(123456789n, 36);
  buf[44] = 6;
  const m = await getMint(fakeConnection(buf), new PublicKey(vectors[0].mint));
  assert.equal(m.decimals, 6);
  assert.equal(m.supply, 123456789n);
});

test('accounts not owned by the token program are rejected', async () => {
  const buf = Buffer.alloc(165);
  const wrongOwner = new PublicKey(vectors[0].owner);
  await assert.rejects(
    () => getAccount(fakeConnection(buf, wrongOwner), new PublicKey(vectors[0].ata)),
    /not owned by the SPL Token program/,
  );
});

test('missing accounts are rejected', async () => {
  const conn = { getAccountInfo: async () => null };
  await assert.rejects(() => getMint(conn, new PublicKey(vectors[0].mint)), /not found/);
});

test('truncated account data is rejected', async () => {
  await assert.rejects(
    () => getAccount(fakeConnection(Buffer.alloc(64)), new PublicKey(vectors[0].ata)),
    /malformed data/,
  );
});
