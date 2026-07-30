import { SITE_URL } from '../constants/brand.js';
import { config } from './index.js';

export function getApiOrigin(): string {
  if (config.nodeEnv === 'production') {
    return new URL(config.appUrl).origin;
  }
  return `http://localhost:${config.port}`;
}

export function getMcpResourceUri(): string {
  return `${getApiOrigin()}/api/mcp`;
}

export function getMcpCloudResourceUri(): string {
  return config.nodeEnv === 'production' ? getMcpResourceUri() : `${SITE_URL}/api/mcp`;
}
