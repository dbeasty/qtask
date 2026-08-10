import { UserOAuthAuthCodeModel } from '../../models/index.js';
import { createOneTimeToken, hashToken } from '../oneTimeToken.js';
import { HttpError } from '../../utils/httpError.js';

const AUTH_CODE_TTL_MS = 60 * 1000;

export async function issueUserOAuthAuthCode(userId: string): Promise<string> {
  const { token, tokenHash, expiresAt } = createOneTimeToken(AUTH_CODE_TTL_MS);
  await UserOAuthAuthCodeModel.create({ codeHash: tokenHash, userId, expiresAt });
  return token;
}

export async function exchangeUserOAuthAuthCode(code: string): Promise<string> {
  const codeHash = hashToken(code);
  const doc = await UserOAuthAuthCodeModel.findOneAndDelete({
    codeHash,
    expiresAt: { $gt: new Date() },
  });

  if (!doc) {
    throw new HttpError(400, 'Invalid or expired sign-in code');
  }

  return doc.userId;
}
