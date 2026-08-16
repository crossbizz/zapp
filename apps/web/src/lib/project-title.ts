const CREATION_PREFIXES = [
  /^(?:please\s+)?(?:can|could|would)\s+you\s+/iu,
  /^i\s+(?:want|need)\s+(?:you\s+)?to\s+/iu,
  /^help\s+me\s+(?:to\s+)?/iu,
  /^what\s+if\s+we\s+/iu,
  /^i\s+have\s+an?\s+idea\s+for\s+/iu,
  /^(?:please\s+)?(?:build|create|make|design|develop|prototype|implement)\s+/iu,
  /^(?:me|us)\s+/iu,
  /^(?:a|an|the)\s+/iu,
] as const;

const DETAIL_CONNECTORS = new Set(['for', 'that', 'using', 'where', 'which', 'with']);
const INITIALISMS = new Map([
  ['ai', 'AI'],
  ['api', 'API'],
  ['crm', 'CRM'],
  ['css', 'CSS'],
  ['html', 'HTML'],
  ['ios', 'iOS'],
  ['saas', 'SaaS'],
  ['seo', 'SEO'],
  ['sql', 'SQL'],
  ['ui', 'UI'],
  ['ux', 'UX'],
  ['web3', 'Web3'],
]);

function removeCreationFiller(value: string): string {
  let title = value;
  let previous = '';
  while (title !== previous) {
    previous = title;
    for (const prefix of CREATION_PREFIXES) title = title.replace(prefix, '');
  }
  return title;
}

function titleCase(word: string): string {
  const initialism = INITIALISMS.get(word.toLocaleLowerCase('en-US'));
  if (initialism !== undefined) return initialism;
  if (/^[A-Z0-9]{2,5}$/u.test(word) || /[A-Z].*[A-Z]/u.test(word)) return word;
  return `${word.slice(0, 1).toLocaleUpperCase('en-US')}${word.slice(1).toLocaleLowerCase('en-US')}`;
}

export function deriveProjectTitle(prompt: string): string {
  const normalized = prompt.trim().replace(/\s+/gu, ' ').replace(/[.!?]+$/gu, '');
  const withoutFiller = removeCreationFiller(normalized);
  const candidates = withoutFiller.match(/[A-Za-z0-9][A-Za-z0-9+#.'-]*/gu) ?? [];
  const words: string[] = [];

  for (const candidate of candidates) {
    if (words.length >= 2 && DETAIL_CONNECTORS.has(candidate.toLocaleLowerCase('en-US'))) break;
    words.push(candidate);
    if (words.length === 4) break;
  }

  const selected = words.length > 0 ? words : (normalized.match(/[A-Za-z0-9]+/gu) ?? []).slice(0, 4);
  const title = selected.map(titleCase).join(' ').slice(0, 80);
  return title.length > 0 ? title : 'Untitled Project';
}
