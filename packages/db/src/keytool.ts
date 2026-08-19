#!/usr/bin/env node
/**
 * Field key lifecycle (ADR 0005).
 *
 *   npm run key -w @lcp/db -- generate --key-id <kms-key-arn-or-alias>
 *   npm run key -w @lcp/db -- verify
 *
 * `generate` is a once-in-the-life-of-the-system command. It mints a 32-byte
 * key, wraps it under KMS, and prints two things: the wrapped ciphertext for
 * the deployment environment, and the raw key ONCE, for the sealed offline
 * copy.
 *
 * That third copy is the disaster copy. AWS accounts get locked out, and the
 * alternative to having it is telling several hundred customers their gate
 * codes are gone. ADR 0005 notes it is the part most likely to be skipped and
 * the part that matters most on the worst day, which is exactly why this
 * command refuses to be quiet about it.
 */
import { randomBytes } from 'node:crypto';
import { loadRepoEnv } from './env.js';
import { initFieldKey, encryptField, decryptField } from './crypto.js';
import { wrapFieldKey, unwrapFieldKey } from './kms.js';

loadRepoEnv();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const command = process.argv[2];

try {
  switch (command) {
    case 'generate': {
      const keyId = arg('key-id');
      if (!keyId) throw new Error('generate needs --key-id (a KMS key ARN or alias/name)');

      // The raw key is printed once. In CI or through a pipe that print lands
      // in a retained build log or a file on disk, which is every failure mode
      // ADR 0005 is trying to avoid. Refuse rather than warn.
      if (process.env.CI) {
        throw new Error('Refusing to run in CI: this prints a secret meant for paper only.');
      }
      if (!process.stdout.isTTY) {
        throw new Error(
          'Refusing to run without a terminal (output is piped or redirected). ' +
          'Run it interactively — the raw key must not land in a file.',
        );
      }
      // Minting a second key orphans every existing ciphertext, and no
      // re-encryption tool exists yet (ADR 0005 leaves rotation as future work).
      if ((process.env.LCP_FIELD_KEY_WRAPPED || process.env.LCP_FIELD_KEY) && !flag('force')) {
        throw new Error(
          'A field key is already configured. Generating another makes every ' +
          'existing gate code permanently unreadable — there is no re-encryption ' +
          'pass yet. Re-run with --force only if you mean exactly that.',
        );
      }

      const raw = randomBytes(32);
      const wrapped = await wrapFieldKey(raw, keyId);

      // Prove the grant and the region NOW, while the operator is standing
      // here with the paper — not at the first deploy.
      const check = await unwrapFieldKey(wrapped);
      if (!check.equals(raw)) throw new Error('KMS round trip did not return the same key.');

      console.log(`
=============================================================
  WRAPPED KEY — put this in the deployment environment
=============================================================

LCP_FIELD_KEY_WRAPPED=${wrapped}
LCP_KMS_KEY_ID=${keyId}

Also set LCP_KMS_REGION, and give the app's IAM role kms:Decrypt
on ${keyId} and nothing else. Verified: this ciphertext unwraps.
`);

      // stderr, deliberately: `npm run key -- generate > env.txt` must not
      // capture the raw key into a file.
      console.error(`
=============================================================
  RAW KEY — write this down NOW, then never store it digitally
=============================================================

${raw.toString('base64')}

Do this before closing this terminal:

  1. Write it on paper. Seal it. Safe or safe deposit box.
  2. NOT in a password manager that syncs to the laptop holding
     the database credentials — stored together, the encryption
     bought nothing.
  3. Do not paste it into the hosting dashboard, this repository,
     a note app, or a chat.
  4. When you are done, close this terminal and clear its buffer.
     Scrollback keeps it otherwise.

If this key and the database are lost together, the gate codes for
several hundred homes are unrecoverable. If they are stored together,
encrypting them achieved nothing. That is the whole of ADR 0005.
=============================================================
`);
      break;
    }

    case 'verify': {
      // Proves the configured key actually works, without printing it.
      await initFieldKey();
      const probe = 'gate-code-roundtrip-probe';
      const back = decryptField(encryptField(probe));
      if (back !== probe) throw new Error('Round trip did not return the original value.');

      const source = process.env.LCP_FIELD_KEY_WRAPPED
        ? `KMS-wrapped (region ${process.env.LCP_KMS_REGION ?? process.env.AWS_REGION})`
        : process.env.LCP_FIELD_KEY
          ? 'raw LCP_FIELD_KEY (acceptable for staging, not for real gate codes)'
          : 'generated dev key (embedded PGlite only)';
      console.log(`[key] ok — encrypt/decrypt round trip passed. Source: ${source}`);
      break;
    }

    default:
      console.log(`Unknown command: ${command ?? '(none)'}

  generate --key-id <kms-key-arn-or-alias> [--force]
                                             mint, wrap, and print the field key
  verify                                     prove the configured key round-trips
`);
      process.exitCode = 1;
  }
} catch (err: any) {
  console.error(`\n[key] ${err?.message ?? err}`);
  process.exitCode = 1;
}
