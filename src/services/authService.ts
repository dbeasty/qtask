import bcrypt from 'bcryptjs';
import { UserModel } from '../models/index.js';
import { signToken } from '../auth/jwt.js';
import { createOneTimeToken, hashToken } from '../auth/oneTimeToken.js';
import { HttpError } from '../utils/httpError.js';
import { projectService } from './projectService.js';
import * as emailService from './emailService.js';

const BCRYPT_ROUNDS = 12;
const LEGAL_VERSION = '1.0';
const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isEmailVerified(user: { emailVerified?: boolean | null }): boolean {
  return user.emailVerified !== false;
}

export interface UserPreferences {
  autoApproveProposals: boolean;
  skipConfirmations: boolean;
}

function serializePreferences(preferences?: {
  autoApproveProposals?: boolean | null;
  skipConfirmations?: boolean | null;
} | null): UserPreferences {
  return {
    autoApproveProposals: preferences?.autoApproveProposals === true,
    skipConfirmations: preferences?.skipConfirmations === true,
  };
}

function serializeUser(user: {
  _id: unknown;
  email: string;
  displayName?: string | null;
  emailVerified?: boolean | null;
  mustChangePassword?: boolean | null;
  preferences?: {
    autoApproveProposals?: boolean | null;
    skipConfirmations?: boolean | null;
  } | null;
}) {
  return {
    id: String(user._id),
    email: user.email,
    displayName: user.displayName ?? undefined,
    emailVerified: isEmailVerified(user),
    mustChangePassword: user.mustChangePassword === true,
    preferences: serializePreferences(user.preferences),
  };
}

export class AuthService {
  async register(input: {
    email: string;
    password: string;
    displayName?: string;
    acceptLegal: true;
  }) {
    if (!emailService.isRegistrationEnabled()) {
      throw new HttpError(503, 'Registration is not currently enabled.');
    }

    const email = normalizeEmail(input.email);
    const existing = await UserModel.findOne({ email }).lean();
    if (existing) {
      throw new HttpError(409, 'An account with this email already exists');
    }

    const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
    const verification = createOneTimeToken(VERIFICATION_TTL_MS);

    const user = await UserModel.create({
      email,
      passwordHash,
      displayName: input.displayName?.trim() || undefined,
      emailVerified: false,
      emailVerificationTokenHash: verification.tokenHash,
      emailVerificationExpires: verification.expiresAt,
      legalAcceptedAt: new Date(),
      legalVersion: LEGAL_VERSION,
    });

    const userId = String(user._id);
    await projectService.ensureDefaultProject(userId);
    await emailService.sendVerificationEmail(email, verification.token);

    return { message: 'Check your email to verify your account before signing in.' };
  }

  async login(input: { email: string; password: string }) {
    const email = normalizeEmail(input.email);
    const user = await UserModel.findOne({ email });
    if (!user) {
      throw new HttpError(401, 'Invalid email or password');
    }

    const valid = await bcrypt.compare(input.password, user.passwordHash);
    if (!valid) {
      throw new HttpError(401, 'Invalid email or password');
    }

    if (!isEmailVerified(user)) {
      throw new HttpError(403, 'Please verify your email before signing in.');
    }

    const userId = String(user._id);
    user.lastLoginAt = new Date();
    await user.save();
    const mustChangePassword = user.mustChangePassword === true;
    const token = signToken({
      sub: userId,
      email: user.email,
      ...(mustChangePassword ? { pwd_change: true } : {}),
    });
    return { token, user: serializeUser(user), mustChangePassword };
  }

  async verifyEmail(token: string) {
    const tokenHash = hashToken(token);
    const user = await UserModel.findOne({
      emailVerificationTokenHash: tokenHash,
      emailVerificationExpires: { $gt: new Date() },
    });

    if (!user) {
      throw new HttpError(400, 'Invalid or expired verification link');
    }

    user.emailVerified = true;
    user.emailVerificationTokenHash = undefined;
    user.emailVerificationExpires = undefined;
    await user.save();

    return { message: 'Email verified. You can now sign in.' };
  }

  async resendVerification(emailInput: string) {
    const email = normalizeEmail(emailInput);
    const user = await UserModel.findOne({ email });

    if (user && !isEmailVerified(user) && emailService.isRegistrationEnabled()) {
      const verification = createOneTimeToken(VERIFICATION_TTL_MS);
      user.emailVerificationTokenHash = verification.tokenHash;
      user.emailVerificationExpires = verification.expiresAt;
      await user.save();
      await emailService.sendVerificationEmail(email, verification.token);
    }

    return { message: 'If an unverified account exists for that email, a verification link has been sent.' };
  }

  async forgotPassword(emailInput: string) {
    const email = normalizeEmail(emailInput);
    const user = await UserModel.findOne({ email });

    if (user && emailService.isRegistrationEnabled()) {
      const reset = createOneTimeToken(RESET_TTL_MS);
      user.passwordResetTokenHash = reset.tokenHash;
      user.passwordResetExpires = reset.expiresAt;
      await user.save();
      await emailService.sendPasswordResetEmail(email, reset.token);
    }

    return { message: 'If an account exists for that email, a password reset link has been sent.' };
  }

  async resetPassword(token: string, password: string) {
    const tokenHash = hashToken(token);
    const user = await UserModel.findOne({
      passwordResetTokenHash: tokenHash,
      passwordResetExpires: { $gt: new Date() },
    });

    if (!user) {
      throw new HttpError(400, 'Invalid or expired reset link');
    }

    user.passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    user.passwordResetTokenHash = undefined;
    user.passwordResetExpires = undefined;
    user.mustChangePassword = false;
    await user.save();

    return { message: 'Password updated. You can now sign in.' };
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    const user = await UserModel.findById(userId);
    if (!user) {
      throw new HttpError(404, 'User not found');
    }

    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) {
      throw new HttpError(401, 'Current password is incorrect');
    }

    user.passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    user.mustChangePassword = false;
    await user.save();

    const token = signToken({ sub: String(user._id), email: user.email });
    return { message: 'Password updated.', token, user: serializeUser(user) };
  }

  async updateProfile(
    userId: string,
    input: {
      displayName?: string | null;
      preferences?: {
        autoApproveProposals?: boolean;
        skipConfirmations?: boolean;
      };
    }
  ) {
    const user = await UserModel.findById(userId);
    if (!user) {
      throw new HttpError(404, 'User not found');
    }

    if (input.displayName !== undefined) {
      const trimmed = input.displayName?.trim();
      user.displayName = trimmed || undefined;
    }

    if (input.preferences) {
      if (!user.preferences) {
        user.preferences = {
          autoApproveProposals: false,
          skipConfirmations: false,
        };
      }
      if (input.preferences.autoApproveProposals !== undefined) {
        user.preferences.autoApproveProposals = input.preferences.autoApproveProposals;
      }
      if (input.preferences.skipConfirmations !== undefined) {
        user.preferences.skipConfirmations = input.preferences.skipConfirmations;
      }
      user.markModified('preferences');
    }

    await user.save();
    return { user: serializeUser(user) };
  }

  async getUserById(userId: string) {
    const user = await UserModel.findById(userId).lean();
    if (!user) return null;
    return serializeUser(user);
  }
}

export const authService = new AuthService();
