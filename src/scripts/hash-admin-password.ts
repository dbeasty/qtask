#!/usr/bin/env node
import { stdin as input } from 'node:process';
import { hashPassword } from '../utils/passwordHash.js';

async function readStdinLine(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of input) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

async function promptHidden(prompt: string): Promise<string> {
  if (!input.isTTY) {
    return readStdinLine();
  }

  process.stdout.write(prompt);
  input.setRawMode(true);
  input.resume();
  input.setEncoding('utf8');

  return new Promise((resolve, reject) => {
    let value = '';

    const onData = (char: string) => {
      switch (char) {
        case '\u0003':
          input.setRawMode(false);
          input.pause();
          input.removeListener('data', onData);
          reject(new Error('Cancelled'));
          break;
        case '\r':
        case '\n':
          input.setRawMode(false);
          input.pause();
          input.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(value);
          break;
        case '\u007f':
        case '\b':
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stdout.write('\b \b');
          }
          break;
        default:
          value += char;
          process.stdout.write('*');
          break;
      }
    };

    input.on('data', onData);
  });
}

async function promptPassword(): Promise<string> {
  const password = await promptHidden('Admin password: ');
  const confirm = await promptHidden('Confirm password: ');
  if (password !== confirm) {
    console.error('Passwords do not match.');
    process.exit(1);
  }
  if (password.length < 10) {
    console.error('Password must be at least 10 characters.');
    process.exit(1);
  }
  return password;
}

async function main(): Promise<void> {
  const useStdin = process.argv.includes('--stdin');
  const password = useStdin ? await readStdinLine() : await promptPassword();

  if (!password) {
    console.error('Password is required.');
    process.exit(1);
  }
  if (password.length < 10) {
    console.error('Password must be at least 10 characters.');
    process.exit(1);
  }

  const hash = await hashPassword(password);
  console.log(`ADMIN_PASSWORD_HASH=${hash}`);
  console.log('HASH_ADMIN_PASSWORD=true');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
