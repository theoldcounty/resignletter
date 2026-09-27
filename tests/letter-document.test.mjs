import assert from 'node:assert/strict';
import test from 'node:test';
import { createLetterPdfDefinition, formatLetterText } from '../src/lib/letterDocument.ts';

const letter = 'Dear Morgan Manager,\n\nPlease accept my resignation.\n\nYours sincerely,\nTaylor Employee';
const details = {
  senderName: 'Taylor Employee',
  homeAddress: '12 Sample Road\nLondon',
  officeAddress: 'Office House\nLondon',
  generatedAt: '2026-09-27T12:00:00Z',
};

test('print-ready PDF uses its saved generation date, sender name, and optional address blocks', () => {
  const pdf = createLetterPdfDefinition(letter, details);
  assert.equal(pdf.pageSize, 'A4');
  assert.deepEqual(pdf.pageMargins, [64, 72, 64, 72]);
  const content = JSON.stringify(pdf.content);
  for (const expected of ['Taylor Employee', '12 Sample Road', '27 September 2026', 'Office House', 'Dear Morgan Manager']) {
    assert.match(content, new RegExp(expected));
  }
  assert.match(formatLetterText(letter, details), /27 September 2026/);
});

test('omitted addresses are absent rather than replaced with blank labels', () => {
  const withoutAddresses = { ...details, homeAddress: null, officeAddress: null };
  const pdf = createLetterPdfDefinition(letter, withoutAddresses);
  const text = JSON.stringify(pdf.content);
  assert.doesNotMatch(text, /home address|office address|Sample Road|Office House/i);
  assert.match(formatLetterText(letter, withoutAddresses), /27 September 2026/);
});

test('legacy paid letters remain downloadable without inventing a sender or generation date', () => {
  const legacy = { senderName: '', homeAddress: null, officeAddress: null, generatedAt: null };
  const content = JSON.stringify(createLetterPdfDefinition(letter, legacy).content);
  assert.doesNotMatch(content, /Invalid Date|undefined|null/);
  assert.equal(createLetterPdfDefinition(letter, legacy).content.length, 3);
  assert.equal(formatLetterText(letter, legacy), letter);
});