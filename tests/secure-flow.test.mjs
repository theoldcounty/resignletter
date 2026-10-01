// Security regression tests exercise shared server validators and inspect access-control wiring.
// The production database and Stripe services are not contacted; only their trust boundaries are checked.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseLetterInput } from '../supabase/functions/_shared/letter.ts';
import { configuredAppOrigin } from '../supabase/functions/_shared/payment.ts';

test('server keeps only valid letter details and ignores forged payment fields', () => {
  // The client may submit extra keys, but only validated letter content is eligible for persistence.
  const parsed = parseLetterInput({
    managerName: '  Alex Manager  ',
    company: '  Example Ltd  ',
    lastDay: '2026-10-30',
    reason: '',
    tone: 'professional',
    paid: true,
    payment_status: 'paid',
    letter_text: 'forged letter',
  });

  assert.deepEqual(parsed, {
    managerName: 'Alex Manager',
    company: 'Example Ltd',
    lastDay: '2026-10-30',
    reason: null,
    tone: 'professional',
  });
  assert.equal(parseLetterInput({ ...parsed, lastDay: '2026-02-30' }), null);
  assert.equal(parseLetterInput({ ...parsed, tone: 'untrusted' }), null);
  assert.equal(parseLetterInput({ ...parsed, company: '' }), null);
});

test('Stripe return URLs use a configured HTTPS app origin', () => {
  // HTTPS and a credential-free origin prevent unsafe redirects and accidental secret propagation.
  assert.equal(configuredAppOrigin('https://resignletter.example/checkout?private=1'), 'https://resignletter.example');
  assert.equal(configuredAppOrigin('http://resignletter.example'), null);
  assert.equal(configuredAppOrigin('https://user:pass@resignletter.example'), null);
  assert.equal(configuredAppOrigin(undefined), null);
});

test('letters are private and Stripe can reach the signature-verified webhook', () => {
  // Read the deployed SQL/config/source declarations to guard against insecure wiring, not just helper behavior.
  const migration = readFileSync(new URL('../supabase/migrations/20260926060000_protect_resignation_letters.sql', import.meta.url), 'utf8');
  const config = readFileSync(new URL('../supabase/config.toml', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');

  for (const action of ['select', 'insert', 'update', 'delete']) {
    // Every anonymous table operation must lose its legacy policy before broad privileges are revoked.
    assert.match(migration, new RegExp(`DROP POLICY IF EXISTS "anon_${action}_letters"`));
  }
  assert.match(migration, /REVOKE ALL ON public\.resignation_letters FROM anon, authenticated/);
  assert.match(config, /\[functions\.stripe-webhook\]\s*verify_jwt = false/);
  assert.doesNotMatch(app, /\.from\(['"]resignation_letters['"]\)/);
});