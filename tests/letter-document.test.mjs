// These tests exercise the shared formatting layer used by browser downloads.
// Fixed saved dates keep the expected PDF/TXT output deterministic across machines.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createLetterDownloadFilename,
  createLetterPdfDefinition,
  formatLetterText,
} from '../src/lib/letterDocument.ts';

// Representative generated-letter content is shared across cases so assertions focus on metadata.
const letter = 'Dear Morgan Manager,\n\nPlease accept my resignation.\n\nYours sincerely,\nTaylor Employee';
// The timestamp is persisted generation metadata, not the date when a document is later downloaded.
const details = {
  senderName: 'Taylor Employee',
  homeAddress: '12 Sample Road\nLondon',
  officeAddress: 'Office House\nLondon',
  generatedAt: '2026-09-27T12:00:00Z',
};

test('print-ready PDF uses its saved generation date, sender name, and optional address blocks', () => {
  // Verify the A4 layout, premium hierarchy, and matching plain-text representation.
  const pdf = createLetterPdfDefinition(letter, details);
  assert.equal(pdf.pageSize, 'A4');
  assert.deepEqual(pdf.pageMargins, [74, 94, 74, 70]);
  const content = JSON.stringify(pdf.content);
  for (const expected of [
    'RESIGNATION LETTER',
    'Taylor Employee',
    '12 Sample Road',
    '27 September 2026',
    'Office House',
    'Dear Morgan Manager',
  ]) {
    assert.match(content, new RegExp(expected));
  }
  assert.equal(typeof pdf.footer, 'function');
  assert.equal(pdf.styles.letterBody.fontSize, 11.5);
  assert.match(formatLetterText(letter, details), /27 September 2026/);
});

test('download filenames use the requested local date and time format', () => {
  // A fixed local timestamp keeps both extensions deterministic on every machine.
  const downloadTime = new Date(2026, 9, 1, 4, 1, 23);
  assert.equal(createLetterDownloadFilename('pdf', downloadTime), 'resign-letter--2026-10-01--04-01-23.pdf');
  assert.equal(createLetterDownloadFilename('txt', downloadTime), 'resign-letter--2026-10-01--04-01-23.txt');
});

test('invalid download timestamps fail explicitly', () => {
  assert.throws(() => createLetterDownloadFilename('pdf', new Date(Number.NaN)), /download timestamp is invalid/i);
});

test('omitted addresses are absent rather than replaced with blank labels', () => {
  // Missing optional data should not create empty labels or leak placeholder address text.
  const withoutAddresses = { ...details, homeAddress: null, officeAddress: null };
  const pdf = createLetterPdfDefinition(letter, withoutAddresses);
  const text = JSON.stringify(pdf.content);
  assert.doesNotMatch(text, /home address|office address|Sample Road|Office House/i);
  assert.match(formatLetterText(letter, withoutAddresses), /27 September 2026/);
});

test('legacy paid letters remain downloadable without inventing a sender or generation date', () => {
  // Older paid records predate these columns; formatting must remain useful without fabricated metadata.
  const legacy = { senderName: '', homeAddress: null, officeAddress: null, generatedAt: null };
  const pdf = createLetterPdfDefinition(letter, legacy);
  const content = JSON.stringify(pdf.content);
  assert.doesNotMatch(content, /Invalid Date|undefined|null/);
  // Decorative title and brand elements are separate from the three unchanged letter paragraphs.
  assert.equal(pdf.content.filter((item) => item.style === 'letterBody').length, 3);
  assert.equal(formatLetterText(letter, legacy), letter);
});