/**
 * Interactive passphrase entry for an encrypted keystore.
 *
 * Rules this enforces:
 *  - never accepted as a command-line argument (it would land in shell history
 *    and in the process table)
 *  - never echoed to the terminal while typing
 *  - never logged, never returned anywhere except to the decrypt call
 *  - only prompted on a real TTY; unattended callers use
 *    ROZO_CHECKOUT_KEYSTORE_PASSPHRASE instead
 */

import readline from 'node:readline';
import { SkillError } from './output.mjs';

/**
 * Prompt for a passphrase with echo suppressed.
 * @returns {Promise<string>}
 */
export function promptPassphrase(prompt = '  Keystore passphrase: ') {
  if (!process.stdin.isTTY) {
    throw new SkillError(
      'KEYSTORE_PASSPHRASE_REQUIRED',
      'A keystore passphrase is needed but this is not a terminal. Set ' +
        'ROZO_CHECKOUT_KEYSTORE_PASSPHRASE for unattended use.',
    );
  }

  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    // Swallow the echo of every keystroke between the prompt and the newline.
    let muted = false;
    const originalWrite = rl._writeToOutput?.bind(rl);
    rl._writeToOutput = (chunk) => {
      if (!muted) {
        if (originalWrite) originalWrite(chunk);
        else process.stdout.write(chunk);
        return;
      }
      // Redraw only the prompt itself, never the typed characters.
      if (chunk.includes(prompt)) process.stdout.write(prompt);
    };

    rl.question(prompt, (answer) => {
      rl._writeToOutput = originalWrite;
      rl.close();
      process.stdout.write('\n');
      const value = String(answer ?? '');
      if (!value) {
        reject(new SkillError('KEYSTORE_PASSPHRASE_REQUIRED', 'No passphrase entered.'));
        return;
      }
      resolve(value);
    });
    muted = true;

    rl.on('SIGINT', () => {
      rl._writeToOutput = originalWrite;
      rl.close();
      process.stdout.write('\n');
      reject(new SkillError('CANCELLED', 'Cancelled.'));
    });
  });
}
