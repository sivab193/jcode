/**
 * Laya integration seam (handoff §10 — "Laya integrates here").
 *
 * Laya is his local 322M model, the router brain. When it is serving
 * (SCODE_LAYA_URL set, e.g. http://localhost:8080), scode asks it to
 * classify the brief first; when it is not configured, or the call fails
 * or returns something invalid, the rule-based classifier takes over
 * silently. Laya is never a hard dependency.
 *
 * Expected endpoint: POST {SCODE_LAYA_URL}/classify with { brief } and a
 * JSON reply { taskClass, difficulty, confidence? }. taskClass must be one
 * of the classifier's classes, difficulty low/medium/high.
 */
import type { Classification, TaskClass } from './classifier.js';

const TASK_CLASSES: TaskClass[] = [
  'review-tests', 'architecture', 'aws', 'exploration',
  'github', 'free-model', 'deep-reasoning', 'general',
];

const DIFFICULTIES = ['low', 'medium', 'high'] as const;

export async function layaClassify(brief: string, baseUrl?: string): Promise<Classification | null> {
  const url = baseUrl ?? process.env.SCODE_LAYA_URL ?? process.env.JCODE_LAYA_URL;
  if (!url) return null;
  try {
    const response = await fetch(`${url.replace(/\/$/, '')}/classify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ brief }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { taskClass?: unknown; difficulty?: unknown; confidence?: unknown };
    if (!TASK_CLASSES.includes(data.taskClass as TaskClass)) return null;
    if (!DIFFICULTIES.includes(data.difficulty as (typeof DIFFICULTIES)[number])) return null;
    return {
      taskClass: data.taskClass as TaskClass,
      difficulty: data.difficulty as 'low' | 'medium' | 'high',
      reason: `Laya${typeof data.confidence === 'number' ? ` (confidence ${Math.round(data.confidence * 100)}%)` : ''}`,
    };
  } catch {
    return null;
  }
}
