import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveMailFrom, resolveMailProvider } from '../src/config/index.js';

describe('resolveMailProvider', () => {
  it('selects resend when MAIL_RESEND=true', () => {
    assert.equal(
      resolveMailProvider({ MAIL_RESEND: 'true', MAIL_SMTP: 'true', SMTP_HOST: 'smtp.example.com' }),
      'resend',
    );
  });

  it('selects smtp when MAIL_SMTP=true', () => {
    assert.equal(resolveMailProvider({ MAIL_SMTP: 'true' }), 'smtp');
  });

  it('selects smtp from SMTP_HOST alone for backward compat', () => {
    assert.equal(resolveMailProvider({ SMTP_HOST: 'smtp.example.com' }), 'smtp');
  });

  it('returns none when no mail config is set', () => {
    assert.equal(resolveMailProvider({}), 'none');
  });
});

describe('resolveMailFrom', () => {
  it('prefers RESEND_FROM for resend', () => {
    assert.equal(
      resolveMailFrom('resend', {
        RESEND_FROM: 'QTask <noreply@example.com>',
        SMTP_FROM: 'smtp@example.com',
      }),
      'QTask <noreply@example.com>',
    );
  });

  it('falls back to SMTP_FROM for resend', () => {
    assert.equal(resolveMailFrom('resend', { SMTP_FROM: 'smtp@example.com' }), 'smtp@example.com');
  });

  it('uses SMTP_FROM for smtp', () => {
    assert.equal(resolveMailFrom('smtp', { SMTP_FROM: 'smtp@example.com' }), 'smtp@example.com');
  });
});
