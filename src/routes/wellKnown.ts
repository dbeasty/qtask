import { Router } from 'express';
import { config } from '../config/index.js';
import {
  buildAuthorizationServerMetadata,
  buildProtectedResourceMetadata,
  getProtectedResourceMetadataPath,
} from '../oauth/metadata.js';
import { getMcpResourceUri } from '../config/urls.js';

export const wellKnownRouter = Router();

wellKnownRouter.get('/oauth-authorization-server', (_req, res) => {
  if (!config.mcpOAuth.enabled) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  res.json(buildAuthorizationServerMetadata());
});

wellKnownRouter.get('/oauth-protected-resource', (_req, res) => {
  if (!config.mcpOAuth.enabled) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  res.json(buildProtectedResourceMetadata());
});

wellKnownRouter.get('/oauth-protected-resource/api/mcp', (_req, res) => {
  if (!config.mcpOAuth.enabled) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  res.json(buildProtectedResourceMetadata(getMcpResourceUri()));
});

export function mountWellKnownRoutes(app: import('express').Express): void {
  app.use('/.well-known', wellKnownRouter);
}
