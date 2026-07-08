import assert from 'node:assert/strict';

import { normalizeExternalHttpUrl } from '../externalLinks';

const acceptedCases: Array<[unknown, string]> = [
  ['https://example.com/path?q=1#hash', 'https://example.com/path?q=1#hash'],
  [' http://127.0.0.1:12345/test ', 'http://127.0.0.1:12345/test'],
  ['HTTPS://Example.COM/Case', 'https://example.com/Case'],
];

for (const [input, expected] of acceptedCases) {
  assert.equal(normalizeExternalHttpUrl(input), expected, `${String(input)} should be accepted`);
}

const rejectedCases: unknown[] = [
  '',
  'not a url',
  'javascript:alert(1)',
  'file:///etc/passwd',
  'mailto:test@example.com',
  'vscode://file/example',
  'https://example.com/\nnext',
  null,
  undefined,
  42,
];

for (const input of rejectedCases) {
  assert.equal(normalizeExternalHttpUrl(input), null, `${String(input)} should be rejected`);
}

console.log('externalLinksSmoke: all checks passed');
