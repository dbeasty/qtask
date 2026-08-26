import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config/index.js';
import { getUserId } from '../middleware/index.js';
import { validateBody } from '../middleware/validate.js';
import { mcpOAuthClientService } from '../services/mcpOAuthClientService.js';
import { mcpOAuthService } from '../services/mcpOAuthService.js';
import { HttpError } from '../utils/httpError.js';

export const oauthRouter = Router();
export const oauthConsentRouter = Router();

const tokenBodySchema = z.object({
  grant_type: z.string().optional(),
  code: z.string().optional(),
  redirect_uri: z.string().optional(),
  client_id: z.string().optional(),
  client_secret: z.string().optional(),
  code_verifier: z.string().optional(),
  resource: z.string().optional(),
  refresh_token: z.string().optional(),
});

function parseTokenBody(req: { body: unknown; headers: { authorization?: string } }) {
  // The old code cast req.body straight to Record<string, string> — a
  // type-level lie, not a runtime check. A field sent as an object (e.g.
  // client_id: {"$gt":""}) passed through untouched into a Mongoose query
  // downstream. Validate every field is actually a string before using any
  // of them.
  const rawBody =
    req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const parsed = tokenBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    throw new HttpError(400, 'Invalid token request body');
  }
  const body = parsed.data;

  let clientId = body.client_id;
  let clientSecret = body.client_secret;

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Basic ')) {
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon >= 0) {
      clientId = clientId ?? decoded.slice(0, colon);
      clientSecret = clientSecret ?? decoded.slice(colon + 1);
    }
  }

  return {
    grantType: body.grant_type,
    code: body.code,
    redirectUri: body.redirect_uri,
    clientId,
    clientSecret,
    codeVerifier: body.code_verifier,
    resource: body.resource,
    refreshToken: body.refresh_token,
  };
}

oauthRouter.get('/authorize', async (req, res, next) => {
  try {
    if (!config.mcpOAuth.enabled) {
      res.status(404).json({ error: 'OAuth is disabled' });
      return;
    }

    const result = await mcpOAuthService.beginAuthorization({
      responseType: typeof req.query.response_type === 'string' ? req.query.response_type : undefined,
      clientId: typeof req.query.client_id === 'string' ? req.query.client_id : undefined,
      redirectUri: typeof req.query.redirect_uri === 'string' ? req.query.redirect_uri : undefined,
      scope: typeof req.query.scope === 'string' ? req.query.scope : undefined,
      state: typeof req.query.state === 'string' ? req.query.state : undefined,
      codeChallenge:
        typeof req.query.code_challenge === 'string' ? req.query.code_challenge : undefined,
      codeChallengeMethod:
        typeof req.query.code_challenge_method === 'string'
          ? req.query.code_challenge_method
          : undefined,
      resource: typeof req.query.resource === 'string' ? req.query.resource : undefined,
    });

    res.redirect(result.consentUrl);
  } catch (error) {
    if (error instanceof HttpError) {
      // Only redirect back to redirect_uri once it's independently confirmed
      // registered for the named client — most of beginAuthorization's
      // checks (response_type, code_challenge_method, resource, unknown
      // client, or redirect_uri itself failing validation) throw before
      // ever validating redirect_uri, so blindly redirecting to whatever
      // the query string says is an open redirect on this server's own
      // origin. Anything that can't be proven safe gets a local JSON error
      // instead of a redirect.
      const safeRedirectUrl = await resolveSafeErrorRedirect(req);
      if (safeRedirectUrl) {
        safeRedirectUrl.searchParams.set('error', 'invalid_request');
        safeRedirectUrl.searchParams.set('error_description', error.message);
        if (typeof req.query.state === 'string') {
          safeRedirectUrl.searchParams.set('state', req.query.state);
        }
        res.redirect(safeRedirectUrl.toString());
        return;
      }
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    next(error);
  }
});

async function resolveSafeErrorRedirect(req: {
  query: Record<string, unknown>;
}): Promise<URL | undefined> {
  const redirectUriParam =
    typeof req.query.redirect_uri === 'string' ? req.query.redirect_uri : undefined;
  const clientIdParam = typeof req.query.client_id === 'string' ? req.query.client_id : undefined;
  if (!redirectUriParam || !clientIdParam) return undefined;

  try {
    const client = await mcpOAuthClientService.resolveClient(clientIdParam);
    if (!client || !mcpOAuthClientService.validateRedirectUri(client, redirectUriParam)) {
      return undefined;
    }
    return new URL(redirectUriParam);
  } catch {
    return undefined;
  }
}

const consentActionSchema = z.object({
  state: z.string().min(1),
  action: z.enum(['approve', 'deny']),
});

oauthConsentRouter.get('/consent', async (req, res, next) => {
  try {
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    if (!state) {
      res.status(400).json({ error: 'state is required' });
      return;
    }
    const details = await mcpOAuthService.getConsentDetails(state);
    if (!details) {
      res.status(404).json({ error: 'Consent request not found or expired' });
      return;
    }
    res.json({ consent: details });
  } catch (error) {
    next(error);
  }
});

oauthConsentRouter.post('/consent', validateBody(consentActionSchema), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const redirectUrl =
      req.body.action === 'approve'
        ? await mcpOAuthService.approveConsent(userId, req.body.state)
        : await mcpOAuthService.denyConsent(req.body.state);
    res.json({ redirectUrl });
  } catch (error) {
    next(error);
  }
});

oauthRouter.post('/token', async (req, res, next) => {
  try {
    if (!config.mcpOAuth.enabled) {
      res.status(404).json({ error: 'OAuth is disabled' });
      return;
    }

    const params = parseTokenBody(req);
    const token = await mcpOAuthService.exchangeToken(params);
    res.json(token);
  } catch (error) {
    if (error instanceof HttpError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    next(error);
  }
});

const dcrSchema = z.object({
  client_name: z.string().optional(),
  redirect_uris: z.array(z.string().url()).min(1),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  token_endpoint_auth_method: z.string().optional(),
});

oauthRouter.post('/register', validateBody(dcrSchema), async (req, res, next) => {
  try {
    if (!config.mcpOAuth.enabled) {
      res.status(404).json({ error: 'OAuth is disabled' });
      return;
    }

    const client = await mcpOAuthClientService.registerDynamicClient(req.body);
    res.status(201).json({
      ...client,
      grant_types: req.body.grant_types ?? ['authorization_code'],
      response_types: req.body.response_types ?? ['code'],
      token_endpoint_auth_method: req.body.token_endpoint_auth_method ?? 'client_secret_post',
    });
  } catch (error) {
    next(error);
  }
});

oauthRouter.post('/revoke', async (req, res, next) => {
  try {
    if (!config.mcpOAuth.enabled) {
      res.status(404).json({ error: 'OAuth is disabled' });
      return;
    }
    res.status(200).json({ revoked: true });
  } catch (error) {
    next(error);
  }
});
