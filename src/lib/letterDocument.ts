import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces';

export type LetterDetails = {
  senderName: string;
  homeAddress: string | null;
  officeAddress: string | null;
  generatedAt: string | null;
};

export function formatLetterDate(generatedAt: string | null): string {
  if (!generatedAt) return '';
  const date = new Date(generatedAt);
  if (Number.isNaN(date.getTime())) throw new Error('The saved letter date is invalid.');
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function formatLetterText(letter: string, details: LetterDetails): string {
  return [
    details.senderName,
    details.homeAddress,
    details.generatedAt ? formatLetterDate(details.generatedAt) : null,
    details.officeAddress,
    letter,
  ].filter(Boolean).join('\n\n');
}

export function createLetterPdfDefinition(letter: string, details: LetterDetails): TDocumentDefinitions {
  const content: Content[] = [];
  if (details.senderName) content.push({ text: details.senderName, bold: true, margin: [0, 0, 0, 4] });
  if (details.homeAddress) content.push({ text: details.homeAddress, margin: [0, 0, 0, 8] });
  if (details.generatedAt) content.push({ text: formatLetterDate(details.generatedAt), margin: [0, 18, 0, 20] });
  if (details.officeAddress) content.push({ text: details.officeAddress, margin: [0, 0, 0, 22] });
  for (const paragraph of letter.trim().split(/\n\s*\n/)) {
    content.push({ text: paragraph.trim(), margin: [0, 0, 0, 14] });
  }
  return {
    pageSize: 'A4',
    pageMargins: [64, 72, 64, 72],
    info: { title: 'Resignation Letter', author: details.senderName || 'ResignLetter' },
    content,
    defaultStyle: { font: 'Roboto', fontSize: 11, lineHeight: 1.35, color: '#1e293b' },
  };
}

export async function downloadLetterPdf(letter: string, details: LetterDetails): Promise<void> {
  const [pdfMakeModule, fontsModule] = await Promise.all([
    import('pdfmake/build/pdfmake'),
    import('pdfmake/build/vfs_fonts'),
  ]);
  pdfMakeModule.default.addVirtualFileSystem(fontsModule.default);
  await pdfMakeModule.default.createPdf(createLetterPdfDefinition(letter, details)).download('resignation-letter.pdf');
}