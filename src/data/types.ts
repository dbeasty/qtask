/**
 * The data-layer contract. Every backend implements this and nothing above it may
 * import a driver — that is what makes DATA_MONGO and DATA_KDB interchangeable.
 *
 * The shape is deliberately the MongoDB subset the application already uses, rather
 * than a new vocabulary: a port that also redesigns the query language is two risky
 * changes wearing one coat, and there would be no way to tell a porting bug from a
 * translation bug. What it does not carry over is Mongoose's document objects —
 * everything here is plain JSON with a string `_id`, so a `doc.save()` becomes an
 * explicit `replaceOne`, visible at the call site.
 */

export type Doc = Record<string, unknown>;

export type Filter = Record<string, unknown>;
export type Update = Record<string, unknown>;
export type Sort = Record<string, 1 | -1>;

export interface FindOptions {
  sort?: Sort;
  limit?: number;
  skip?: number;
  /** Mongoose's space-separated projection: `'email displayName'`, or `'-embedding'`. */
  select?: string;
}

export interface UpdateOptions {
  upsert?: boolean;
  /** Which side of the update to return. Mongoose's `{ new: true }` is `'after'`. */
  returnDocument?: 'before' | 'after';
  /** Picks which document to act on when the filter matches several. */
  sort?: Sort;
}

export interface UpdateResult {
  matched: number;
  modified: number;
  upsertedId?: string;
}

export interface DeleteResult {
  deleted: number;
}

/** One entry of a bulk write. Only the operation the application actually issues. */
export interface BulkUpdateOne {
  updateOne: { filter: Filter; update: Update; upsert?: boolean };
}

export type BulkOperation = BulkUpdateOne;

/**
 * A collection of documents. Reads return plain objects that the caller owns and
 * may mutate freely — no backend hands back a live view of its own state.
 */
export interface Collection<T extends Doc = Doc> {
  readonly name: string;

  find(filter?: Filter, options?: FindOptions): Promise<T[]>;
  findOne(filter: Filter, options?: FindOptions): Promise<T | null>;
  findById(id: string, options?: FindOptions): Promise<T | null>;
  countDocuments(filter?: Filter): Promise<number>;
  distinct(field: string, filter?: Filter): Promise<unknown[]>;

  create(doc: Doc): Promise<T>;
  insertMany(docs: Doc[]): Promise<T[]>;

  updateOne(filter: Filter, update: Update, options?: UpdateOptions): Promise<UpdateResult>;
  updateMany(filter: Filter, update: Update): Promise<UpdateResult>;
  findOneAndUpdate(filter: Filter, update: Update, options?: UpdateOptions): Promise<T | null>;
  findByIdAndUpdate(id: string, update: Update, options?: UpdateOptions): Promise<T | null>;
  /** Replaces a whole document. This is what a Mongoose `doc.save()` becomes. */
  replaceOne(filter: Filter, doc: Doc): Promise<UpdateResult>;

  deleteOne(filter: Filter): Promise<DeleteResult>;
  deleteMany(filter: Filter): Promise<DeleteResult>;
  findOneAndDelete(filter: Filter): Promise<T | null>;

  bulkWrite(operations: BulkOperation[]): Promise<UpdateResult>;
}

/** The collections the application uses, by name. */
export type CollectionName =
  | 'users'
  | 'tasks'
  | 'projects'
  | 'comments'
  | 'activities'
  | 'conversations'
  | 'notifications'
  | 'invites'
  | 'feedback'
  | 'feedbackVisionJobs'
  | 'embeddingJobs'
  | 'llmCallMetrics'
  | 'llmDailyMetrics'
  | 'adminAudits'
  | 'mcpApiKeys'
  | 'mcpSessions'
  | 'mcpOAuthClients'
  | 'mcpOAuthAuthorizationCodes'
  | 'mcpOAuthRefreshTokens'
  | 'mcpOAuthPendingConsents'
  | 'userOAuthAuthCodes';

/**
 * A connected backend. `connect` and `disconnect` bracket the process lifetime;
 * `collection` is the only way in.
 */
export interface DataStore {
  readonly backend: 'mongo' | 'kdb';
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  collection<T extends Doc = Doc>(name: CollectionName): Collection<T>;
  /** Drops all data. Test-support only; a store may refuse outside NODE_ENV=test. */
  clear(): Promise<void>;
}
