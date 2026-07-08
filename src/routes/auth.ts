import { Router } from 'express';
import { z } from 'zod';
import { authService } from '../services/authService.js';
import { requireAuth } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { getUserId } from '../middleware/index.js';

export const authRouter = Router();

const registerSchema = z.object({
  email: z.string().email('Valid email is required'),
  password: z.string().min(10, 'Password must be at least 10 characters'),
  displayName: z.string().trim().min(1).optional(),
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

authRouter.post('/change-password', requireAuth, validateBody(changePasswordSchema), async (req, res, next) => {
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

authRouter.get('/me', requireAuth, async (req, res, next) => {
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
