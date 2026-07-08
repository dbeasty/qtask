import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { config } from '../config/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('email');

export const testEmailOutbox = {
  verification: [] as string[],
  reset: [] as string[],
};

export function clearTestEmailOutbox(): void {
  testEmailOutbox.verification = [];
  testEmailOutbox.reset = [];
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
  if (process.env.NODE_ENV === 'test') {
    testEmailOutbox.verification.push(token);
  }
  const url = `${config.appUrl}/verify-email?token=${encodeURIComponent(token)}`;
  await sendEmail(
    email,
    'Verify your QTask email',
    `Welcome to QTask!\n\nVerify your email address by opening this link:\n${url}\n\nThis link expires in 24 hours.`
  );
}

export async function sendPasswordResetEmail(email: string, token: string): Promise<void> {
  if (process.env.NODE_ENV === 'test') {
    testEmailOutbox.reset.push(token);
  }
  const url = `${config.appUrl}/reset-password?token=${encodeURIComponent(token)}`;
  await sendEmail(
    email,
    'Reset your QTask password',
    `You requested a password reset for your QTask account.\n\nReset your password by opening this link:\n${url}\n\nThis link expires in 1 hour. If you did not request this, you can ignore this email.`
  );
}
