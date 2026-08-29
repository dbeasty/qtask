import { Router } from 'express';
import { z } from 'zod';
import { authService } from '../services/authService.js';
import { isRegistrationEnabled } from '../services/emailService.js';
import { config, getMcpPublicConfig } from '../config/index.js';
import { getMcpPublicOAuthConfig } from '../oauth/metadata.js';
import { getOAuthProviderPublicInfo } from '../auth/userOAuth/providers/registry.js';
import { userOAuthService } from '../auth/userOAuth/service.js';
import { verifyOAuthState } from '../auth/userOAuth/state.js';
import { HttpError } from '../utils/httpError.js';
import { requireAuth, requireAuthForRefresh, requirePasswordChangeAuth } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { getUserId } from '../middleware/index.js';
import { createLogger } from '../utils/logger.js';

export const authRouter = Router();
const logger = createLogger('auth');

const registerSchema = z.object({
  email: z.string().email('Valid email is required'),
  password: z.string().min(10, 'Password must be at least 10 characters'),
  displayName: z.string().trim().min(1).optional(),
  acceptLegal: z.literal(true, {
    errorMap: () => ({ message: 'You must accept the Terms & Disclaimer and Privacy Policy' }),
  }),
});

const loginSchema = z.object({
  email: z.string().email('Valid email is required'),
  password: z.string().min(1, 'Password is required'),
});

const tokenSchema = z.object({
  token: z.string().min(1, 'Token is required'),
});

const emailSchema = z.object({
  email: z.string().email('Valid email is required'),
});

const resetPasswordSchema = z.object({
  token: z.string().min(1, 'Token is required'),
  password: z.string().min(10, 'Password must be at least 10 characters'),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: z.string().min(10, 'Password must be at least 10 characters'),
});

const updateProfileSchema = z.object({
  displayName: z.union([z.string().trim().min(1), z.null()]).optional(),
  hourlyRate: z.number().min(0).nullable().optional(),
  preferences: z
    .object({
      autoApproveProposals: z.boolean().optional(),
      skipConfirmations: z.boolean().optional(),
      trackExpenses: z.boolean().optional(),
      agentEnterToSend: z.boolean().optional(),
      completedDemoTour: z.boolean().optional(),
      theme: z.enum(['dark', 'light']).optional(),
      startupView: z.enum(['auto', 'agent', 'projects', 'tasks', 'last']).optional(),
      enableHourlyTracking: z.boolean().optional(),
    })
    .optional(),
});

const oauthExchangeSchema = z.object({
  code: z.string().min(1, 'Code is required'),
});

const oauthConfirmLinkSchema = z.object({
  linkToken: z.string().min(1, 'Token is required'),
  password: z.string().min(1, 'Password is required'),
});

authRouter.get('/config', (_req, res) => {
  const mcp = getMcpPublicConfig();
  res.json({
    registrationEnabled: isRegistrationEnabled(),
    oauthProviders: getOAuthProviderPublicInfo(),
    mcp: config.mcpOAuth.enabled ? { ...mcp, oauth: getMcpPublicOAuthConfig() } : mcp,
  });
});

authRouter.get('/oauth/:provider', async (req, res, next) => {
  try {
    const returnTo = typeof req.query.returnTo === 'string' ? req.query.returnTo : undefined;
    const inviteToken = typeof req.query.inviteToken === 'string' ? req.query.inviteToken : undefined;
    const acceptLegal = req.query.acceptLegal === 'true';
    const mobileRedirectUri =
      typeof req.query.redirectUri === 'string' ? req.query.redirectUri : undefined;
    const redirectUrl = await userOAuthService.beginAuthorization({
      provider: req.params.provider ?? '',
      returnTo,
      inviteToken,
      acceptLegal,
      mobileRedirectUri,
    });
    res.redirect(redirectUrl);
  } catch (error) {
    next(error);
  }
});

authRouter.get('/oauth/:provider/callback', async (req, res, next) => {
  let returnTo: string | undefined;
  let mobileRedirectUri: string | undefined;
  const stateParam = typeof req.query.state === 'string' ? req.query.state : undefined;
  if (stateParam) {
    const state = verifyOAuthState(stateParam);
    returnTo = state?.returnTo;
    mobileRedirectUri = state?.mobileRedirectUri;
  }

  try {
    const provider = req.params.provider ?? '';
    const callbackUrl = new URL(`${req.protocol}://${req.get('host')}${req.originalUrl}`);
    const redirectUrl = await userOAuthService.handleCallback(provider, callbackUrl);
    res.redirect(redirectUrl);
  } catch (error) {
    const message =
      error instanceof HttpError
        ? error.message
        : error instanceof Error
          ? error.message
          : 'Sign-in failed';
    try {
      res.redirect(userOAuthService.buildErrorRedirect(message, returnTo, mobileRedirectUri));
    } catch {
      next(error);
    }
  }
});

authRouter.post('/oauth/exchange', validateBody(oauthExchangeSchema), async (req, res, next) => {
  try {
    const result = await userOAuthService.exchangeAuthCode(req.body.code);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

authRouter.post('/oauth/confirm-link', validateBody(oauthConfirmLinkSchema), async (req, res, next) => {
  try {
    const result = await userOAuthService.confirmProviderLink(req.body.linkToken, req.body.password);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

authRouter.post('/register', validateBody(registerSchema), async (req, res, next) => {
  try {
    const result = await authService.register(req.body);
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

authRouter.post('/login', validateBody(loginSchema), async (req, res, next) => {
  try {
    const result = await authService.login(req.body);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

authRouter.post('/verify-email', validateBody(tokenSchema), async (req, res, next) => {
  try {
    const result = await authService.verifyEmail(req.body.token);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

authRouter.post('/resend-verification', validateBody(emailSchema), async (req, res, next) => {
  try {
    const result = await authService.resendVerification(req.body.email);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

authRouter.post('/forgot-password', validateBody(emailSchema), async (req, res, next) => {
  try {
    const result = await authService.forgotPassword(req.body.email);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

authRouter.post('/reset-password', validateBody(resetPasswordSchema), async (req, res, next) => {
  try {
    const result = await authService.resetPassword(req.body.token, req.body.password);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

authRouter.post('/change-password', requirePasswordChangeAuth, validateBody(changePasswordSchema), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const result = await authService.changePassword(userId, req.body.currentPassword, req.body.newPassword);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

authRouter.patch('/me', requireAuth, validateBody(updateProfileSchema), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const result = await authService.updateProfile(userId, req.body);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

authRouter.get('/me', requirePasswordChangeAuth, async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const user = await authService.getUserById(userId);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.json({ user });
  } catch (error) {
    next(error);
  }
});

authRouter.post('/refresh', requireAuthForRefresh, async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const result = await authService.refreshSession(userId);
    logger.info('Session refreshed', {
      userId,
      mustChangePassword: result.mustChangePassword === true,
      source: 'refresh_endpoint',
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});
