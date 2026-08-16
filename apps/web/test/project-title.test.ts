import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { deriveProjectTitle } from '../src/lib/project-title.js';

void describe('project title derivation', () => {
  void it('removes creation filler and keeps a concise product name', () => {
    assert.equal(deriveProjectTitle('Build a customer support portal'), 'Customer Support Portal');
    assert.equal(deriveProjectTitle('Build me a simple todo app'), 'Simple Todo App');
    assert.equal(deriveProjectTitle('build a simple todo app'), 'Simple Todo App');
  });

  void it('removes exploratory filler without changing the complete prompt', () => {
    assert.equal(
      deriveProjectTitle('What if we prototype a garden planning app?'),
      'Garden Planning App',
    );
    assert.equal(
      deriveProjectTitle('I have an idea for a subscription analytics dashboard with Stripe billing'),
      'Subscription Analytics Dashboard',
    );
  });

  void it('caps long names at four meaningful words and preserves common initialisms', () => {
    assert.equal(
      deriveProjectTitle('Create a polished AI customer support analytics dashboard'),
      'Polished AI Customer Support',
    );
    assert.ok(deriveProjectTitle('Make a very detailed project planning workspace for agencies').split(' ').length <= 4);
  });

  void it('returns a valid fallback when the prompt has no title words', () => {
    assert.equal(deriveProjectTitle('..........'), 'Untitled Project');
  });
});
