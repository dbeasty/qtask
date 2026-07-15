import mongoose from 'mongoose';
import { config } from '../config/index.js';

export async function connectDb(): Promise<void> {
  // Prefer IPv4 — on macOS, localhost can resolve to ::1 while Docker Mongo listens on IPv4.
  await mongoose.connect(config.mongodbUri, { family: 4 });
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
}
