jest.mock('../config/storage', () => ({
  getServerUrl: jest.fn(),
  setServerUrl: jest.fn(),
  clearServerUrl: jest.fn(),
  getStoredToken: jest.fn(),
  setStoredToken: jest.fn(),
  clearStoredToken: jest.fn(),
}));

import * as storage from '../config/storage';
import { ApiError, login, pingServer, resolveBaseUrl, setCachedBaseUrl } from './client';

const mockedStorage = storage as jest.Mocked<typeof storage>;

function mockFetchOnce(status: number, body: unknown) {
  (globalThis.fetch as jest.Mock).mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    statusText: 'error',
    text: async () => JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  setCachedBaseUrl(null);
  globalThis.fetch = jest.fn();
});

describe('resolveBaseUrl', () => {
  it('throws when no server URL is cached or stored', async () => {
    mockedStorage.getServerUrl.mockResolvedValueOnce(null);
    await expect(resolveBaseUrl()).rejects.toThrow(ApiError);
  });

  it('reads the stored server URL and caches it', async () => {
    mockedStorage.getServerUrl.mockResolvedValueOnce('https://qtask.example.com');
    await expect(resolveBaseUrl()).resolves.toBe('https://qtask.example.com');
    // Second call should use the cache, not hit storage again.
    await expect(resolveBaseUrl()).resolves.toBe('https://qtask.example.com');
    expect(mockedStorage.getServerUrl).toHaveBeenCalledTimes(1);
  });
});

describe('pingServer', () => {
  it('returns true when the health endpoint responds ok', async () => {
    mockFetchOnce(200, {});
    await expect(pingServer('https://qtask.example.com')).resolves.toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledWith('https://qtask.example.com/health');
  });

  it('strips a trailing slash before requesting /health', async () => {
    mockFetchOnce(200, {});
    await pingServer('https://qtask.example.com/');
    expect(globalThis.fetch).toHaveBeenCalledWith('https://qtask.example.com/health');
  });

  it('returns false when the request throws (offline/unreachable)', async () => {
    (globalThis.fetch as jest.Mock).mockRejectedValueOnce(new Error('network down'));
    await expect(pingServer('https://qtask.example.com')).resolves.toBe(false);
  });
});

describe('login', () => {
  beforeEach(() => {
    setCachedBaseUrl('https://qtask.example.com');
  });

  it('stores the returned token on success', async () => {
    mockFetchOnce(200, { token: 'jwt-token', user: { id: 'u1', email: 'a@example.com' } });
    const result = await login('a@example.com', 'hunter2');
    expect(result.token).toBe('jwt-token');
    expect(mockedStorage.setStoredToken).toHaveBeenCalledWith('jwt-token');
  });

  it('throws an ApiError carrying the server error message on failure', async () => {
    mockFetchOnce(401, { error: 'Invalid credentials' });
    await expect(login('a@example.com', 'wrong')).rejects.toMatchObject({
      message: 'Invalid credentials',
      status: 401,
    });
    expect(mockedStorage.setStoredToken).not.toHaveBeenCalled();
  });
});
