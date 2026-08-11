// Minimal SPL-token helpers backed only by @solana/web3.js.
//
// This replaces the @solana/spl-token dependency, which pulled in
// bigint-buffer (GHSA-3gc7-fjrx-p6mg, no patched release) via
// @solana/buffer-layout-utils. send-sol.mjs only ever needed five small
// pieces of it — the ATA derivation, two account reads and the
// TransferChecked instruction — so they are hand-rolled here against the
// documented on-chain layouts instead.
//
// Layout references:
//   Token account: mint[0..32] owner[32..64] amount u64le[64..72], len 165
//   Mint account:  mintAuthorityOption[0..4] mintAuthority[4..36]
//                  supply u64le[36..44] decimals u8[44], len 82
//   TransferChecked instruction: tag 12, amount u64le, decimals u8

import { PublicKey, TransactionInstruction } from '@solana/web3.js';

export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
);

const TOKEN_ACCOUNT_LEN = 165;
const MINT_LEN = 82;

export async function getAssociatedTokenAddress(mint, owner) {
  const [address] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return address;
}

async function fetchOwnedAccount(connection, address, minLen, what) {
  const info = await connection.getAccountInfo(address, 'confirmed');
  if (!info) throw new Error(`${what} not found: ${address.toBase58()}`);
  if (!info.owner.equals(TOKEN_PROGRAM_ID)) {
    throw new Error(`${what} ${address.toBase58()} is not owned by the SPL Token program`);
  }
  if (info.data.length < minLen) {
    throw new Error(`${what} ${address.toBase58()} has malformed data (${info.data.length} bytes)`);
  }
  return info.data;
}

export async function getAccount(connection, address) {
  const data = await fetchOwnedAccount(connection, address, TOKEN_ACCOUNT_LEN, 'Token account');
  return {
    address,
    mint: new PublicKey(data.subarray(0, 32)),
    owner: new PublicKey(data.subarray(32, 64)),
    amount: data.readBigUInt64LE(64),
  };
}

export async function getMint(connection, address) {
  const data = await fetchOwnedAccount(connection, address, MINT_LEN, 'Mint');
  return {
    address,
    supply: data.readBigUInt64LE(36),
    decimals: data[44],
  };
}

export function createTransferCheckedInstruction(
  source,
  mint,
  destination,
  owner,
  amount,
  decimals,
) {
  const data = Buffer.alloc(10);
  data.writeUInt8(12, 0); // TransferChecked
  data.writeBigUInt64LE(BigInt(amount), 1);
  data.writeUInt8(decimals, 9);
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  });
}
