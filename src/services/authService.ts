import bcrypt from 'bcryptjs';
import { UserModel } from '../models/index.js';
import { signToken } from '../auth/jwt.js';
import { HttpError } from '../utils/httpError.js';
import { projectService } from './projectService.js';

const BCRYPT_ROUNDS = 12;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function serializeUser(user: { _id: unknown; email: string; displayName?: string | null }) {
  return {
    id: String(user._id),
    email: user.email,
    displayName: user.displayName ?? undefined,
  };
}

export class AuthService {
  async register(input: { email: string; password: string; displayName?: string }) {
    const email = normalizeEmail(input.email);
    const existing = await UserModel.findOne({ email }).lean();
    if (existing) {
      throw new HttpError(409, 'An account with this email already exists');
    }

    const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
    const user = await UserModel.create({
      email,
      passwordHash,
      displayName: input.displayName?.trim() || undefined,
    });

    const userId = String(user._id);
    await projectService.ensureDefaultProject(userId);

    const token = signToken({ sub: userId, email });
    return { token, user: serializeUser(user) };
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

    const userId = String(user._id);
    const token = signToken({ sub: userId, email: user.email });
    return { token, user: serializeUser(user) };
  }

  async getUserById(userId: string) {
    const user = await UserModel.findById(userId).lean();
    if (!user) return null;
    return serializeUser(user);
  }
}

export const authService = new AuthService();
