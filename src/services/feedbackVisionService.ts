import { config } from '../config/index.js';
import { createLlmCallTracker, type OllamaTimingFields } from './llmMetrics.js';

export interface VisionCheckResult {
  isScreenshot: boolean;
  confidence: number;
  rationale?: string;
  model: string;
  checkedAt: Date;
}

export class FeedbackVisionError extends Error {
  constructor(
    message: string,
    readonly statusCode: number
  ) {
    super(message);
    this.name = 'FeedbackVisionError';
  }
}

const SCREENSHOT_PROMPT = `You classify uploaded images for a bug-report form.
Decide whether the image is a screenshot of a computer, phone, or tablet user interface (app window, browser, desktop, mobile screen capture).
Return ONLY valid JSON with this shape:
{"isScreenshot": boolean, "confidence": number, "reason": string}
confidence must be between 0 and 1.
Set isScreenshot to false for photos of people, nature, memes, documents photographed with a camera, drawings, or unrelated images.`;

function parseVisionResponse(text: string): { isScreenshot: boolean; confidence: number; reason?: string } {
  const trimmed = text.trim();
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new FeedbackVisionError('Vision model returned an invalid response', 503);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    throw new FeedbackVisionError('Vision model returned an invalid response', 503);
  }
  if (
    typeof parsed !== 'object' ||
    parsed == null ||
    typeof (parsed as { isScreenshot?: unknown }).isScreenshot !== 'boolean' ||
    typeof (parsed as { confidence?: unknown }).confidence !== 'number'
  ) {
    throw new FeedbackVisionError('Vision model returned an invalid response', 503);
  }
  const result = parsed as { isScreenshot: boolean; confidence: number; reason?: string };
  return {
    isScreenshot: result.isScreenshot,
    confidence: Math.min(1, Math.max(0, result.confidence)),
    reason: typeof result.reason === 'string' ? result.reason : undefined,
  };
}

export async function classifyScreenshot(
  imageBuffer: Buffer,
  contentType: string,
  userId?: string
): Promise<VisionCheckResult> {
  const model = config.ollama.visionModel;
  const tracker = createLlmCallTracker({
    callType: 'feedback_vision',
    source: 'feedback_vision',
    model,
    userId,
  });

  const base64 = imageBuffer.toString('base64');
  const body = {
    model,
    stream: false,
    messages: [
      {
        role: 'user',
        content: SCREENSHOT_PROMPT,
        images: [base64],
      },
    ],
    format: 'json',
  };

  let response: Response;
  try {
    response = await fetch(`${config.ollama.baseUrl.replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (error) {
    tracker.fail(error);
    throw new FeedbackVisionError(
      'Screenshot validation is temporarily unavailable. Please try again later.',
      503
    );
  }

  if (!response.ok) {
    tracker.fail(new Error(`HTTP ${response.status}`), response.status);
    throw new FeedbackVisionError(
      'Screenshot validation is temporarily unavailable. Please try again later.',
      503
    );
  }

  let payload: { message?: { content?: string }; [key: string]: unknown };
  try {
    payload = (await response.json()) as typeof payload;
  } catch (error) {
    tracker.fail(error, response.status);
    throw new FeedbackVisionError(
      'Screenshot validation is temporarily unavailable. Please try again later.',
      503
    );
  }

  tracker.complete(response.status, payload as OllamaTimingFields);

  const content = payload.message?.content;
  if (!content) {
    throw new FeedbackVisionError('Vision model returned an invalid response', 503);
  }

  const parsed = parseVisionResponse(content);
  const minConfidence = config.feedback.visionMinConfidence;
  const accepted = parsed.isScreenshot && parsed.confidence >= minConfidence;

  return {
    isScreenshot: accepted,
    confidence: parsed.confidence,
    rationale: parsed.reason,
    model,
    checkedAt: new Date(),
  };
}

export const SCREENSHOT_REJECTION_MESSAGE =
  'Please attach a screenshot of the issue (not a photo or unrelated image).';
