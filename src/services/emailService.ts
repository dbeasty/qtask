import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
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

async function sendEmail(to: string, subject: string, text: string): Promise<void> {
  const transport = getTransporter();
  if (!transport) {
    logger.info('Email not sent (SMTP not configured)', { to, subject, text });
    return;
  }

  await transport.sendMail({
    from: config.smtp.from,
    to,
    subject,
    text,
  });
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
