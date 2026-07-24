import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { Resend } from 'resend';
import { config } from '../config/index.js';
import { GITHUB_REPO_URL } from '../constants/brand.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('email');

export const testEmailOutbox = {
  verification: [] as string[],
  reset: [] as string[],
  verificationBodies: [] as string[],
  resetBodies: [] as string[],
};

export function clearTestEmailOutbox(): void {
  testEmailOutbox.verification = [];
  testEmailOutbox.reset = [];
  testEmailOutbox.verificationBodies = [];
  testEmailOutbox.resetBodies = [];
}

let transporter: Transporter | null = null;
let resendClient: Resend | null = null;
let emailReady = false;

function getTransporter(): Transporter | null {
  if (!config.smtp.host) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth:
        config.smtp.user && config.smtp.pass
          ? { user: config.smtp.user, pass: config.smtp.pass }
          : undefined,
    });
  }
  return transporter;
}

function getResendClient(): Resend | null {
  if (!config.mail.resendApiKey) return null;
  if (!resendClient) {
    resendClient = new Resend(config.mail.resendApiKey);
  }
  return resendClient;
}

export async function initEmail(): Promise<void> {
  if (process.env.REGISTRATION_ENABLED === 'false') {
    logger.warn('REGISTRATION_ENABLED=false; new account creation is disabled');
  }

  if (process.env.MAIL_RESEND === 'true' && process.env.MAIL_SMTP === 'true') {
    logger.warn('Both MAIL_RESEND and MAIL_SMTP are true; using Resend');
  }

  if (config.nodeEnv === 'test' || config.nodeEnv === 'development') {
    emailReady = true;
    return;
  }

  if (config.mail.provider === 'resend') {
    if (!config.mail.resendApiKey) {
      emailReady = false;
      logger.warn('MAIL_RESEND is set but RESEND_API_KEY is missing; registration and password-reset emails are disabled');
      return;
    }
    getResendClient();
    emailReady = true;
    logger.info('Resend mail provider ready');
    return;
  }

  if (config.mail.provider === 'smtp') {
    if (!config.smtp.host) {
      emailReady = false;
      logger.warn('MAIL_SMTP is set but SMTP_HOST is missing; registration and password-reset emails are disabled');
      return;
    }

    const transport = getTransporter();
    if (!transport) {
      emailReady = false;
      return;
    }

    try {
      await transport.verify();
      emailReady = true;
      logger.info('SMTP connection verified');
    } catch (error) {
      emailReady = false;
      logger.warn('SMTP verification failed; registration and password-reset emails are disabled', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  emailReady = false;
  logger.warn('Mail not configured; registration and password-reset emails are disabled');
}

export function isRegistrationEnabled(): boolean {
  // Read env at call time so tests can toggle without reloading config.
  return emailReady && process.env.REGISTRATION_ENABLED !== 'false';
}

export function getEmailStatus(): 'configured' | 'disabled' {
  return emailReady ? 'configured' : 'disabled';
}

async function sendViaResend(to: string, subject: string, text: string): Promise<void> {
  const client = getResendClient();
  if (!client) {
    logger.info('Email not sent (Resend not configured)', { to, subject, text });
    return;
  }

  const { error } = await client.emails.send({
    from: config.mail.from,
    to: [to],
    subject,
    text,
  });

  if (error) {
    throw new Error(error.message);
  }
}

async function sendViaSmtp(to: string, subject: string, text: string): Promise<void> {
  const transport = getTransporter();
  if (!transport) {
    logger.info('Email not sent (SMTP not configured)', { to, subject, text });
    return;
  }

  await transport.sendMail({
    from: config.mail.from,
    to,
    subject,
    text,
  });
}

async function sendEmail(to: string, subject: string, text: string): Promise<void> {
  if (process.env.NODE_ENV === 'test' && process.env.TEST_EMAIL_SEND_FAIL === 'true') {
    throw new Error('Simulated email send failure');
  }

  try {
    if (config.mail.provider === 'resend') {
      await sendViaResend(to, subject, text);
      return;
    }

    if (config.mail.provider === 'smtp') {
      await sendViaSmtp(to, subject, text);
      return;
    }

    logger.info('Email not sent (mail not configured)', { to, subject, text });
  } catch (error) {
    logger.error('Failed to send email', {
      to,
      subject,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function sendVerificationEmail(email: string, token: string): Promise<void> {
  const verifyUrl = `${config.appUrl}/verify-email?token=${encodeURIComponent(token)}`;
  const privacyUrl = `${config.appUrl}/privacy`;
  const text = `Welcome to QTask!

Verify your email address by opening this link:
${verifyUrl}

Privacy Policy: ${privacyUrl}

This link expires in 24 hours.

Learn more or contribute: ${GITHUB_REPO_URL}`;

  if (process.env.NODE_ENV === 'test') {
    testEmailOutbox.verification.push(token);
    testEmailOutbox.verificationBodies.push(text);
  }

  await sendEmail(email, 'Verify your QTask email', text);
}

export async function sendPasswordResetEmail(email: string, token: string): Promise<void> {
  const resetUrl = `${config.appUrl}/reset-password?token=${encodeURIComponent(token)}`;
  const privacyUrl = `${config.appUrl}/privacy`;
  const text = `You requested a password reset for your QTask account.

Reset your password by opening this link:
${resetUrl}

This link expires in 1 hour. If you did not request this, you can ignore this email.

Privacy Policy: ${privacyUrl}`;

  if (process.env.NODE_ENV === 'test') {
    testEmailOutbox.reset.push(token);
    testEmailOutbox.resetBodies.push(text);
  }

  await sendEmail(email, 'Reset your QTask password', text);
}
