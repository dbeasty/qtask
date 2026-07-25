export interface UserSummary {
  userId: string;
  displayName?: string;
  email: string;
}

export interface ShareContact extends UserSummary {
  lastSharedAt: string;
}
