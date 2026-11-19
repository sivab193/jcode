import { layaClassify } from './laya.js';

export type TaskClass =
  | 'review-tests'
  | 'architecture'
  | 'aws'
  | 'exploration'
  | 'github'
  | 'free-model'
  | 'deep-reasoning'
  | 'general';

export interface Classification {
  taskClass: TaskClass;
  difficulty: 'low' | 'medium' | 'high';
  reason: string;
}

/**
 * Rules first, Laya later (handoff §5). The classifier's input is the brief
 * only — never a raw transcript. Keep rules ordered most-specific first.
 */
export function classify(brief: string): Classification {
  const text = brief.toLowerCase();
  if (/\b(aws|lambda|cloudformation|cdk|dynamodb|s3|ec2)\b/.test(text)) return { taskClass: 'aws', difficulty: 'medium', reason: 'AWS-native keywords' };
  if (/\b(github|pull request|\bpr\b|actions|issue|workflow)\b/.test(text)) return { taskClass: 'github', difficulty: 'medium', reason: 'GitHub-native workflow' };
  if (/\b(deep reason|hard problem|prove|formal|algorithm design|complexity)\b/.test(text)) return { taskClass: 'deep-reasoning', difficulty: 'high', reason: 'deep-reasoning keywords' };
  if (/\b(architecture|architect|large refactor|redesign|migration)\b/.test(text)) return { taskClass: 'architecture', difficulty: 'high', reason: 'architecture/refactor keywords' };
  if (/\b(huge repo|explore|codebase|find where|survey the)\b/.test(text)) return { taskClass: 'exploration', difficulty: 'medium', reason: 'repository exploration' };
  if (/\b(free model|cheap|quick question|one-liner|trivial|draft)\b/.test(text)) return { taskClass: 'free-model', difficulty: 'low', reason: 'free-model / low-stakes keywords' };
  if (/\b(review|test|tests|lint|typo)\b/.test(text)) return { taskClass: 'review-tests', difficulty: 'low', reason: 'review/test keywords' };
  return { taskClass: 'general', difficulty: 'medium', reason: 'default rule' };
}

/**
 * Laya first, rules as fallback (Phase 6). When Laya is not serving
 * (SCODE_LAYA_URL unset) or its answer is invalid, this is exactly classify().
 */
export async function classifyAsync(brief: string): Promise<Classification> {
  return (await layaClassify(brief)) ?? classify(brief);
}
