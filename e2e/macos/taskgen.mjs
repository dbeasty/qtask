// The tasks the perf run fills the store with: deterministic, with a rare word ("zebra", 1%)
// so search has a known selective query, and some with due dates.
const WORDS = ['plan', 'review', 'write', 'call', 'fix', 'order', 'draft', 'ship', 'clean', 'book', 'sort', 'test', 'email', 'pay', 'read'];
const NOUNS = ['report', 'invoice', 'garage', 'budget', 'roadmap', 'schedule', 'contract', 'garden', 'kitchen', 'release', 'backlog', 'survey', 'taxes', 'permit', 'quote'];

export function taskFields(n, projectIds) {
  const rare = n % 100 === 0 ? ' zebra' : '';
  return {
    title: `${WORDS[n % WORDS.length]} ${NOUNS[(n * 7) % NOUNS.length]} ${n}${rare}`,
    description: `Task ${n}: ${NOUNS[(n * 3) % NOUNS.length]} follow-up for the ${WORDS[(n * 5) % WORDS.length]} cycle.${rare}`,
    projectId: projectIds[n % projectIds.length],
    priority: ['low', 'medium', 'high', 'urgent'][n % 4],
    tags: [`t${n % 10}`],
    ...(n % 5 === 0 ? { dueDate: new Date(Date.now() + (n % 30) * 86400000).toISOString() } : {}),
  };
}
