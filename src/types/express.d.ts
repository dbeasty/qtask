declare global {
  namespace Express {
    interface Request {
      auth?: {
        userId: string;
        email: string;
        mustChangePassword: boolean;
      };
      admin?: {
        identity: string;
      };
    }
  }
}

export {};
