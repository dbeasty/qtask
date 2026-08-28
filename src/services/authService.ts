import bcrypt from 'bcryptjs';
import { ProjectModel, UserModel } from '../models/index.js';
import { signToken } from '../auth/jwt.js';
import { createOneTimeToken, hashToken } from '../auth/oneTimeToken.js';
import type { OAuthProfile } from '../auth/userOAuth/types.js';
import type { IdentityProviderId } from '../auth/userOAuth/types.js';
import { providerRequiresLinkConfirmation } from '../auth/userOAuth/types.js';
import { createLinkConfirmationToken, verifyLinkConfirmationToken } from '../auth/userOAuth/linkConfirmation.js';
import { HttpError } from '../utils/httpError.js';
import { createLogger } from '../utils/logger.js';
import { projectService } from './projectService.js';
import * as emailService from './emailService.js';

const logger = createLogger('auth');

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

export type ThemePreference = 'dark' | 'light';
export type StartupViewPreference = 'auto' | 'agent' | 'projects' | 'tasks' | 'last';

export interface UserPreferences {
  autoApproveProposals: boolean;
  skipConfirmations: boolean;
  trackExpenses: boolean;
  agentEnterToSend: boolean;
  completedDemoTour: boolean;
  theme: ThemePreference;
  startupView: StartupViewPreference;
}

const STARTUP_VIEW_VALUES = ['auto', 'agent', 'projects', 'tasks', 'last'] as const;

function normalizeStartupView(value: unknown): StartupViewPreference {
  return STARTUP_VIEW_VALUES.includes(value as StartupViewPreference)
    ? (value as StartupViewPreference)
    : 'last';
}

function serializePreferences(preferences?: {
  autoApproveProposals?: boolean | null;
  skipConfirmations?: boolean | null;
  trackExpenses?: boolean | null;
  agentEnterToSend?: boolean | null;
  completedDemoTour?: boolean | null;
  theme?: ThemePreference | null;
  startupView?: StartupViewPreference | null;
  enableHourlyTracking?: boolean | null;
} | null): UserPreferences {
  const trackExpenses =
    preferences?.trackExpenses !== undefined && preferences?.trackExpenses !== null
      ? preferences.trackExpenses === true
      : true;
  const theme = preferences?.theme === 'dark' ? 'dark' : 'light';
  return {
    autoApproveProposals: preferences?.autoApproveProposals === true,
    skipConfirmations: preferences?.skipConfirmations === true,
    trackExpenses,
    agentEnterToSend: preferences?.agentEnterToSend !== false,
    completedDemoTour: preferences?.completedDemoTour === true,
    theme,
    startupView: normalizeStartupView(preferences?.startupView),
  };
}

function serializeUser(user: {
  _id: unknown;
  email: string;
  displayName?: string | null;
  emailVerified?: boolean | null;
  mustChangePassword?: boolean | null;
  hourlyRate?: number | null;
  passwordHash?: string | null;
    preferences?: {
      autoApproveProposals?: boolean | null;
      skipConfirmations?: boolean | null;
      trackExpenses?: boolean | null;
      agentEnterToSend?: boolean | null;
      completedDemoTour?: boolean | null;
      theme?: ThemePreference | null;
      startupView?: StartupViewPreference | null;
      enableHourlyTracking?: boolean | null;
    } | null;
}) {
  return {
    id: String(user._id),
    email: user.email,
    displayName: user.displayName ?? undefined,
    emailVerified: isEmailVerified(user),
    mustChangePassword: user.mustChangePassword === true,
    hasPassword: Boolean(user.passwordHash),
    hourlyRate: user.hourlyRate ?? undefined,
    preferences: serializePreferences(user.preferences),
  };
}

function hasLinkedProvider(
  user: { identityProviders?: Array<{ provider?: string; providerUserId?: string }> | null },
  provider: IdentityProviderId,
  providerUserId: string
): boolean {
  return (
    user.identityProviders?.some(
      (entry) => entry.provider === provider && entry.providerUserId === providerUserId
    ) ?? false
  );
}

async function findUserByProvider(provider: IdentityProviderId, providerUserId: string) {
  return UserModel.findOne({
    identityProviders: { $elemMatch: { provider, providerUserId } },
  });
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

    try {
      await emailService.sendVerificationEmail(email, verification.token);
    } catch {
      await ProjectModel.deleteMany({ userId });
      await UserModel.deleteOne({ _id: user._id });
      throw new HttpError(503, 'Unable to send verification email. Please try again later.');
    }

    return { message: 'Check your email to verify your account before signing in.' };
  }

  async login(input: { email: string; password: string }) {
    const email = normalizeEmail(input.email);
    const user = await UserModel.findOne({ email });
    if (!user) {
      throw new HttpError(401, 'Invalid email or password');
    }

    if (!user.passwordHash) {
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
    logger.debug('User logged in', { userId });
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
      try {
        await emailService.sendVerificationEmail(email, verification.token);
      } catch {
        // Same generic response — do not leak deliverability details.
      }
    }

    return { message: 'If an unverified account exists for that email, a verification link has been sent.' };
  }

  async forgotPassword(emailInput: string) {
    const email = normalizeEmail(emailInput);
    const user = await UserModel.findOne({ email });

    if (user && !user.passwordHash) {
      return { message: 'If an account exists for that email, a password reset link has been sent.' };
    }

    if (user && emailService.isRegistrationEnabled()) {
      const reset = createOneTimeToken(RESET_TTL_MS);
      user.passwordResetTokenHash = reset.tokenHash;
      user.passwordResetExpires = reset.expiresAt;
      await user.save();
      try {
        await emailService.sendPasswordResetEmail(email, reset.token);
      } catch {
        // Same generic response — do not leak deliverability details.
      }
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

    if (!user.passwordHash) {
      throw new HttpError(400, 'This account uses social sign-in. Set a password from account settings first.');
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

  async createSessionForUserId(userId: string) {
    const user = await UserModel.findById(userId);
    if (!user) {
      throw new HttpError(404, 'User not found');
    }
    return this.issueSession(user);
  }

  private issueSession(user: {
    _id: unknown;
    email: string;
    mustChangePassword?: boolean | null;
    passwordHash?: string | null;
    displayName?: string | null;
    emailVerified?: boolean | null;
    hourlyRate?: number | null;
    preferences?: Parameters<typeof serializeUser>[0]['preferences'];
  }) {
    const userId = String(user._id);
    const mustChangePassword = user.mustChangePassword === true;
    const token = signToken({
      sub: userId,
      email: user.email,
      ...(mustChangePassword ? { pwd_change: true } : {}),
    });
    return { token, user: serializeUser(user), mustChangePassword };
  }

  async loginWithOAuthProvider(
    profile: OAuthProfile,
    options?: { acceptLegal?: boolean; inviteToken?: string }
  ) {
    if (!profile.emailVerified) {
      throw new HttpError(403, 'Your email address is not verified with this provider');
    }

    const email = normalizeEmail(profile.email);

    if (options?.inviteToken) {
      const { inviteService } = await import('./inviteService.js');
      const preview = await inviteService.getPublicInvitePreview(options.inviteToken);
      if (normalizeEmail(preview.inviteeEmail) !== email) {
        throw new HttpError(403, 'Sign in with the email address this invitation was sent to');
      }
    }

    const byProvider = await findUserByProvider(profile.provider, profile.providerUserId);
    if (byProvider) {
      if (normalizeEmail(byProvider.email) !== email) {
        throw new HttpError(409, 'Could not sign in with this provider. Contact support.');
      }
      byProvider.lastLoginAt = new Date();
      await byProvider.save();
      logger.info('OAuth sign-in', { userId: String(byProvider._id), provider: profile.provider });
      return { userId: String(byProvider._id), ...this.issueSession(byProvider) };
    }

    let user = await UserModel.findOne({ email });

    if (user) {
      const alreadyLinked = hasLinkedProvider(user, profile.provider, profile.providerUserId);

      if (!alreadyLinked && providerRequiresLinkConfirmation(profile.provider)) {
        if (!user.passwordHash) {
          // No password to confirm ownership with, and this provider's
          // email-verified claim isn't trustworthy enough to merge
          // identities on its own — the account owner must sign in with
          // the method they originally used instead.
          throw new HttpError(
            409,
            'An account with this email already exists. Sign in with your original sign-in method instead.'
          );
        }
        const linkToken = createLinkConfirmationToken({
          userId: String(user._id),
          provider: profile.provider,
          providerUserId: profile.providerUserId,
          displayName: profile.displayName,
        });
        logger.info('OAuth provider link requires confirmation', {
          userId: String(user._id),
          provider: profile.provider,
        });
        return { linkConfirmationRequired: true as const, linkToken, email: user.email };
      }

      if (!alreadyLinked) {
        user.identityProviders = user.identityProviders ?? [];
        user.identityProviders.push({
          provider: profile.provider,
          providerUserId: profile.providerUserId,
          linkedAt: new Date(),
        });
        logger.info('OAuth provider linked', {
          userId: String(user._id),
          provider: profile.provider,
        });
      }

      if (!isEmailVerified(user)) {
        user.emailVerified = true;
        user.emailVerificationTokenHash = undefined;
        user.emailVerificationExpires = undefined;
      }

      if (!user.displayName && profile.displayName) {
        user.displayName = profile.displayName;
      }

      user.lastLoginAt = new Date();
      await user.save();
      return { userId: String(user._id), ...this.issueSession(user) };
    }

    if (!emailService.isRegistrationEnabled()) {
      throw new HttpError(503, 'Registration is not currently enabled.');
    }

    if (options?.acceptLegal !== true) {
      throw new HttpError(400, 'You must accept the Terms and Privacy Policy');
    }

    user = await UserModel.create({
      email,
      displayName: profile.displayName,
      emailVerified: true,
      legalAcceptedAt: new Date(),
      legalVersion: LEGAL_VERSION,
      identityProviders: [
        {
          provider: profile.provider,
          providerUserId: profile.providerUserId,
          linkedAt: new Date(),
        },
      ],
    });

    const userId = String(user._id);
    await projectService.ensureDefaultProject(userId);
    user.lastLoginAt = new Date();
    await user.save();

    logger.info('OAuth account created', { userId, provider: profile.provider });
    return { userId, ...this.issueSession(user) };
  }

  /**
   * Completes a provider link that loginWithOAuthProvider deferred pending
   * confirmation (see providerRequiresLinkConfirmation) — the caller must
   * prove ownership of the existing account with its password before the
   * new provider identity is merged in.
   */
  async confirmOAuthProviderLink(linkToken: string, password: string) {
    const payload = verifyLinkConfirmationToken(linkToken);
    if (!payload) {
      throw new HttpError(400, 'Invalid or expired confirmation link');
    }

    const user = await UserModel.findById(payload.userId);
    if (!user || !user.passwordHash) {
      throw new HttpError(401, 'Invalid email or password');
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      throw new HttpError(401, 'Invalid email or password');
    }

    if (!hasLinkedProvider(user, payload.provider, payload.providerUserId)) {
      user.identityProviders = user.identityProviders ?? [];
      user.identityProviders.push({
        provider: payload.provider,
        providerUserId: payload.providerUserId,
        linkedAt: new Date(),
      });
      logger.info('OAuth provider linked after confirmation', {
        userId: String(user._id),
        provider: payload.provider,
      });
    }

    if (!user.displayName && payload.displayName) {
      user.displayName = payload.displayName;
    }

    user.lastLoginAt = new Date();
    await user.save();
    return { userId: String(user._id), ...this.issueSession(user) };
  }

  async refreshSession(userId: string) {
    const user = await UserModel.findById(userId);
    if (!user) {
      logger.warn('Refresh failed', { userId, reason: 'user_deleted' });
      throw new HttpError(404, 'User not found');
    }

    const mustChangePassword = user.mustChangePassword === true;
    const token = signToken({
      sub: String(user._id),
      email: user.email,
      ...(mustChangePassword ? { pwd_change: true } : {}),
    });
    return { token, user: serializeUser(user), mustChangePassword };
  }

  async updateProfile(
    userId: string,
    input: {
      displayName?: string | null;
      hourlyRate?: number | null;
      preferences?: {
        autoApproveProposals?: boolean;
        skipConfirmations?: boolean;
        trackExpenses?: boolean;
        agentEnterToSend?: boolean;
        completedDemoTour?: boolean;
        theme?: ThemePreference;
        startupView?: StartupViewPreference;
        enableHourlyTracking?: boolean;
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

    if (input.hourlyRate !== undefined) {
      user.hourlyRate = input.hourlyRate === null ? undefined : Math.max(0, input.hourlyRate);
    }

    if (input.preferences) {
      if (!user.preferences) {
        user.preferences = {
          autoApproveProposals: false,
          skipConfirmations: false,
          trackExpenses: true,
          agentEnterToSend: true,
          completedDemoTour: false,
          theme: 'light',
          startupView: 'last',
        };
      }
      if (input.preferences.autoApproveProposals !== undefined) {
        user.preferences.autoApproveProposals = input.preferences.autoApproveProposals;
      }
      if (input.preferences.skipConfirmations !== undefined) {
        user.preferences.skipConfirmations = input.preferences.skipConfirmations;
      }
      if (input.preferences.trackExpenses !== undefined) {
        user.preferences.trackExpenses = input.preferences.trackExpenses;
      } else if (input.preferences.enableHourlyTracking !== undefined) {
        user.preferences.trackExpenses = input.preferences.enableHourlyTracking;
      }
      if (input.preferences.agentEnterToSend !== undefined) {
        user.preferences.agentEnterToSend = input.preferences.agentEnterToSend;
      }
      if (input.preferences.completedDemoTour !== undefined) {
        user.preferences.completedDemoTour = input.preferences.completedDemoTour;
      }
      if (input.preferences.theme !== undefined) {
        user.preferences.theme = input.preferences.theme;
      }
      if (input.preferences.startupView !== undefined) {
        user.preferences.startupView = input.preferences.startupView;
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
