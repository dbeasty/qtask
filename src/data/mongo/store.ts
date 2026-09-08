/**
 * The MongoDB backend: a thin adapter over the existing Mongoose models.
 *
 * Deliberately thin. The models keep their schemas, defaults, casting, timestamps
 * and indexes exactly as they are, so switching a service from `TaskModel.find` to
 * `tasks.find` changes no behaviour on this backend at all. That is the property
 * that makes the migration safe to do collection by collection: the Mongo path is
 * not being rewritten, only re-routed.
 *
 * Everything crossing this boundary outward is a plain object with a string `_id`
 * (`lean()` plus id stringification), so nothing above the data layer can reach a
 * Mongoose document and call `.save()` on it.
 */

import mongoose, { type Model } from 'mongoose';
import { config } from '../../config/index.js';
import type {
  BulkOperation,
  Collection,
  CollectionName,
  DataStore,
  DeleteResult,
  Doc,
  Filter,
  FindOptions,
  Update,
  UpdateOptions,
  UpdateResult,
} from '../types.js';

/** Model names as registered in src/models/index.ts, by collection name. */
const MODEL_BY_COLLECTION: Record<CollectionName, string> = {
  users: 'User',
  tasks: 'Task',
  projects: 'Project',
  comments: 'Comment',
  activities: 'Activity',
  conversations: 'Conversation',
  notifications: 'Notification',
  invites: 'Invite',
  feedback: 'Feedback',
  feedbackVisionJobs: 'FeedbackVisionJob',
  embeddingJobs: 'EmbeddingJob',
  llmCallMetrics: 'LlmCallMetric',
  llmDailyMetrics: 'LlmDailyMetric',
  adminAudits: 'AdminAudit',
  mcpApiKeys: 'McpApiKey',
  mcpSessions: 'McpSession',
  mcpOAuthClients: 'McpOAuthClient',
  mcpOAuthAuthorizationCodes: 'McpOAuthAuthorizationCode',
  mcpOAuthRefreshTokens: 'McpOAuthRefreshToken',
  mcpOAuthPendingConsents: 'McpOAuthPendingConsent',
  userOAuthAuthCodes: 'UserOAuthAuthCode',
};

/**
 * Turns a lean Mongoose result into a plain document. ObjectIds become strings —
 * including the ones on nested subdocuments, which callers compare against ids
 * that arrived from an API as strings.
 */
function toPlain(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value;
  if (value instanceof mongoose.Types.ObjectId) return value.toString();
  if (Array.isArray(value)) return value.map(toPlain);
  if (typeof value === 'object') {
    if (Buffer.isBuffer(value)) return value;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = toPlain(item);
    }
    return out;
  }
  return value;
}

function plainDoc<T extends Doc>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  return toPlain(value) as T;
}

class MongoBackedCollection<T extends Doc> implements Collection<T> {
  constructor(
    readonly name: CollectionName,
    private readonly model: Model<Doc>
  ) {}

  async find(filter: Filter = {}, options: FindOptions = {}): Promise<T[]> {
    let query = this.model.find(filter);
    if (options.select) query = query.select(options.select);
    if (options.sort) query = query.sort(options.sort);
    if (options.skip !== undefined) query = query.skip(options.skip);
    if (options.limit !== undefined) query = query.limit(options.limit);
    const docs = await query.lean();
    return docs.map((doc) => plainDoc<T>(doc)!).filter(Boolean);
  }

  async findOne(filter: Filter, options: FindOptions = {}): Promise<T | null> {
    let query = this.model.findOne(filter);
    if (options.select) query = query.select(options.select);
    if (options.sort) query = query.sort(options.sort);
    return plainDoc<T>(await query.lean());
  }

  async findById(id: string, options: FindOptions = {}): Promise<T | null> {
    // An id that is not a valid ObjectId is a miss, not a cast error: callers pass
    // ids straight from URLs and request bodies, and every one of them would
    // otherwise need its own validity check before every lookup.
    if (!mongoose.isValidObjectId(id)) return null;
    let query = this.model.findById(id);
    if (options.select) query = query.select(options.select);
    return plainDoc<T>(await query.lean());
  }

  async countDocuments(filter: Filter = {}): Promise<number> {
    return this.model.countDocuments(filter);
  }

  async distinct(field: string, filter: Filter = {}): Promise<unknown[]> {
    const values = await this.model.distinct(field, filter);
    return values.map((value) => toPlain(value));
  }

  async create(doc: Doc): Promise<T> {
    const created = await this.model.create(doc);
    return plainDoc<T>(created.toObject())!;
  }

  async insertMany(docs: Doc[]): Promise<T[]> {
    const created = await this.model.insertMany(docs);
    return created.map((doc) => plainDoc<T>(doc.toObject())!);
  }

  async updateOne(filter: Filter, update: Update, options: UpdateOptions = {}): Promise<UpdateResult> {
    const result = await this.model.updateOne(filter, update, { upsert: options.upsert ?? false });
    return {
      matched: result.matchedCount ?? 0,
      modified: result.modifiedCount ?? 0,
      upsertedId: result.upsertedId ? String(result.upsertedId) : undefined,
    };
  }

  async updateMany(filter: Filter, update: Update): Promise<UpdateResult> {
    const result = await this.model.updateMany(filter, update);
    return { matched: result.matchedCount ?? 0, modified: result.modifiedCount ?? 0 };
  }

  async findOneAndUpdate(filter: Filter, update: Update, options: UpdateOptions = {}): Promise<T | null> {
    const doc = await this.model
      .findOneAndUpdate(filter, update, {
        new: options.returnDocument !== 'before',
        upsert: options.upsert ?? false,
        ...(options.sort ? { sort: options.sort } : {}),
      })
      .lean();
    return plainDoc<T>(doc);
  }

  async findByIdAndUpdate(id: string, update: Update, options: UpdateOptions = {}): Promise<T | null> {
    if (!mongoose.isValidObjectId(id)) return null;
    const doc = await this.model
      .findByIdAndUpdate(id, update, { new: options.returnDocument !== 'before' })
      .lean();
    return plainDoc<T>(doc);
  }

  async replaceOne(filter: Filter, doc: Doc): Promise<UpdateResult> {
    // `_id` is immutable in Mongo, so a replacement body carrying one is rejected
    // even when it matches the document being replaced.
    const { _id: _ignored, ...body } = doc;
    const result = await this.model.replaceOne(filter, body);
    return { matched: result.matchedCount ?? 0, modified: result.modifiedCount ?? 0 };
  }

  async deleteOne(filter: Filter): Promise<DeleteResult> {
    const result = await this.model.deleteOne(filter);
    return { deleted: result.deletedCount ?? 0 };
  }

  async deleteMany(filter: Filter): Promise<DeleteResult> {
    const result = await this.model.deleteMany(filter);
    return { deleted: result.deletedCount ?? 0 };
  }

  async findOneAndDelete(filter: Filter): Promise<T | null> {
    return plainDoc<T>(await this.model.findOneAndDelete(filter).lean());
  }

  async bulkWrite(operations: BulkOperation[]): Promise<UpdateResult> {
    if (operations.length === 0) return { matched: 0, modified: 0 };
    const result = await this.model.bulkWrite(operations as never);
    return { matched: result.matchedCount ?? 0, modified: result.modifiedCount ?? 0 };
  }
}

export class MongoDataStore implements DataStore {
  readonly backend = 'mongo' as const;
  private readonly collections = new Map<CollectionName, Collection<Doc>>();

  async connect(): Promise<void> {
    // Prefer IPv4 — on macOS, localhost can resolve to ::1 while Docker Mongo listens on IPv4.
    await mongoose.connect(config.mongodbUri, { family: 4 });
    const { ProjectModel, TaskModel } = await import('../../models/index.js');
    await Promise.all([TaskModel.syncIndexes(), ProjectModel.syncIndexes()]);
  }

  async disconnect(): Promise<void> {
    await mongoose.disconnect();
  }

  collection<T extends Doc = Doc>(name: CollectionName): Collection<T> {
    const existing = this.collections.get(name);
    if (existing) return existing as Collection<T>;

    const modelName = MODEL_BY_COLLECTION[name];
    if (!modelName) throw new Error(`Unknown collection: ${name}`);
    // Models register themselves on import of src/models/index.ts, which the app
    // does at startup. Reading from the connection's registry rather than importing
    // per collection keeps this file from depending on twenty exported symbols.
    const model = mongoose.models[modelName] as Model<Doc> | undefined;
    if (!model) {
      throw new Error(`Mongoose model "${modelName}" is not registered — import src/models/index.js first`);
    }

    const collection = new MongoBackedCollection<T>(name, model);
    this.collections.set(name, collection as unknown as Collection<Doc>);
    return collection;
  }

  async clear(): Promise<void> {
    if (config.nodeEnv !== 'test') {
      throw new Error('clear() is test-support only');
    }
    // Empties the collections rather than dropping the database. Dropping takes the
    // indexes with it, and Mongoose only builds them once per model at startup — so
    // a dropped database leaves every later test running against a schema with no
    // unique constraints, passing writes the real deployment would reject. Rebuilding
    // them each time is correct but costs over a second per call; deleting documents
    // keeps the constraints and is effectively free.
    const collections = await mongoose.connection.db?.collections();
    await Promise.all((collections ?? []).map((collection) => collection.deleteMany({})));
  }
}
