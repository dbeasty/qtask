/**
 * Diagnostic: times individual data-layer calls one at a time against whichever backend the
 * environment selects (the same env the benchmark workers get). Used to see where a backend
 * spends its time without the noise of concurrency.
 *
 *   BENCH_INDEX=bench/.cache/smoke-s42/index.json DATA_KDB=true ... tsx bench/probe-ops.ts
 */

import { readFileSync } from 'node:fs';
import type { DatasetIndex } from './lib/dataset.ts';

await import('../src/models/index.ts');
const { connectData, disconnectData, collection } = await import('../src/data/index.ts');
const index = JSON.parse(readFileSync(process.env.BENCH_INDEX!, 'utf8')) as DatasetIndex;
const t = performance.now();
await connectData();
console.log(`connect ${(performance.now() - t).toFixed(1)} ms`);
const user = index.users[1]!;
const taskId = user.taskIds[0]!;
const reps = Number(process.env.REPS ?? 5);

async function time(label: string, fn: () => Promise<unknown>): Promise<void> {
  const xs: number[] = [];
  for (let i = 0; i < reps; i++) {
    const s = performance.now();
    await fn();
    xs.push(performance.now() - s);
  }
  xs.sort((a, b) => a - b);
  console.log(`${label.padEnd(48)} min ${xs[0]!.toFixed(1)}  median ${xs[Math.floor(xs.length / 2)]!.toFixed(1)}  max ${xs[xs.length - 1]!.toFixed(1)} ms`);
}

const notStaged = { staging: { $exists: false } };
await time('users.findById', () => collection('users').findById(user.id));
await time('tasks.findById', () => collection('tasks').findById(taskId));
await time('notifications.countDocuments {userId,read}', () => collection('notifications').countDocuments({ userId: user.id, read: false }));
await time('projects.find access', () => collection('projects').find({ ...notStaged, $or: [{ userId: user.id }, { 'collaborators.userId': user.id }] }, { select: '_id' }));
await time('tasks.find {userId} sort limit 200', () => collection('tasks').find({ userId: user.id, ...notStaged }, { sort: { sortOrder: 1 }, limit: 200 }));
await time('activities.create', () => collection('activities').create({ taskId, userId: user.id, action: 'probe', details: {} }));
await time('users.updateOne $set lastActiveAt', () => collection('users').updateOne({ _id: user.id }, { $set: { lastActiveAt: new Date() } }));
await time('notifications.updateOne by _id', async () => {
  const n = await collection('notifications').findOne({ userId: user.id });
  await collection('notifications').updateOne({ _id: n!._id }, { $set: { read: true } });
});
await time('tasks.updateOne $set percent', () => collection('tasks').updateOne({ _id: taskId }, { $set: { percentComplete: Math.floor(Math.random() * 100) } }));
await time('embeddingJobs.updateOne upsert', () => collection('embeddingJobs').updateOne({ entityType: 'task', entityId: taskId }, { $set: { status: 'pending' }, $setOnInsert: { attempts: 0, dirty: false } }, { upsert: true }));
await disconnectData();
