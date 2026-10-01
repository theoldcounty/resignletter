import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces';

/**
 * Optional saved details used to render the letter consistently in plain text
 * and PDF exports. Nullable address/date fields support older or partial records.
 */
export type LetterDetails = {
  senderName: string;
  homeAddress: string | null;
  officeAddress: string | null;
  generatedAt: string | null;
};

/** Keep downloaded filenames consistent between the text and PDF exports. */
export type LetterDownloadFormat = 'pdf' | 'txt';

/**
 * Create the requested timestamped filename using the visitor's local clock.
 * Local time makes the filename match the moment the person initiated the download.
 */
export function createLetterDownloadFilename(format: LetterDownloadFormat, now: Date = new Date()): string {
  if (Number.isNaN(now.getTime())) throw new Error('The download timestamp is invalid.');

  const pad = (value: number) => String(value).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  return `resign-letter--${date}--${time}.${format}`;
}

/** Format a stored timestamp as a stable UK-style date without local-time shifts. */
export function formatLetterDate(generatedAt: string | null): string {
  // An absent date is allowed for drafts and older saved letters.
  if (!generatedAt) return '';
  const date = new Date(generatedAt);
  // Fail clearly for corrupt saved data instead of silently printing "Invalid Date".
  if (Number.isNaN(date.getTime())) throw new Error('The saved letter date is invalid.');
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** Build the printable plain-text version using blank lines between letter sections. */
export function formatLetterText(letter: string, details: LetterDetails): string {
  return [
    details.senderName,
    details.homeAddress,
    details.generatedAt ? formatLetterDate(details.generatedAt) : null,
    details.officeAddress,
    letter,
    // Missing optional values are removed before joining so they do not create
    // empty address/date blocks in the downloaded text.
  ].filter(Boolean).join('\n\n');
}

/**
 * Translate the letter into a polished, print-ready A4 pdfmake definition.
 * The letter text stays unchanged; hierarchy and spacing make the export easier to read.
 */
export function createLetterPdfDefinition(letter: string, details: LetterDetails): TDocumentDefinitions {
  // Each PDF section is a content node so pdfmake can paginate the letter naturally.
  const content: Content[] = [];

  // Use a restrained navy-and-brass palette to give the document a clear, formal hierarchy.
  content.push({ text: 'RESIGNATION LETTER', style: 'eyebrow', margin: [0, 0, 0, 8] });
  content.push({ text: 'Resignation letter', style: 'title', margin: [0, 0, 0, 8] });
  content.push({ text: 'A professional draft for your review', style: 'subtitle', margin: [0, 0, 0, 16] });
  // The short rule separates the title from the letter details without adding decoration to the body.
  content.push({
    canvas: [{ type: 'line', x1: 0, y1: 0, x2: 447, y2: 0, lineWidth: 1.4, lineColor: '#C3A36B' }],
    margin: [0, 0, 0, 22],
  });

  // Keep sender and recipient information in separate columns; omit empty blocks for older records.
  const senderLines = [details.senderName, details.homeAddress].filter((value): value is string => Boolean(value));
  const recipientLines = [details.officeAddress].filter((value): value is string => Boolean(value));
  if (senderLines.length || recipientLines.length) {
    // Type the nested stacks explicitly so pdfmake's content union remains checked by TypeScript.
    const senderStack: Content[] = [{ text: 'FROM', style: 'sectionLabel', margin: [0, 0, 0, 7] }];
    senderLines.forEach((text, index) => {
      senderStack.push({
        text,
        style: index === 0 && details.senderName ? 'contactName' : 'contactDetail',
        margin: [0, 0, 0, 3],
      });
    });
    const recipientStack: Content[] = [{ text: 'TO', style: 'sectionLabel', margin: [0, 0, 0, 7] }];
    recipientLines.forEach((text) => {
      recipientStack.push({ text, style: 'contactDetail', margin: [0, 0, 0, 3] });
    });

    content.push({
      columns: [
        { width: '*', stack: senderStack },
        { width: '*', stack: recipientStack },
      ],
      columnGap: 28,
      margin: [0, 0, 0, 20],
    });
  }

  // Place the saved creation date before the message; it remains distinct from the download timestamp.
  if (details.generatedAt) {
    content.push({
      text: formatLetterDate(details.generatedAt),
      style: 'date',
      alignment: 'right',
      margin: [0, 0, 0, 24],
    });
  }

  // Preserve the generated wording while giving each paragraph comfortable reading space.
  for (const paragraph of letter.trim().split(/\n\s*\n/)) {
    if (paragraph.trim()) content.push({ text: paragraph.trim(), style: 'letterBody', margin: [0, 0, 0, 15] });
  }

  return {
    // A4 margins reserve room for the repeating wordmark and page-number footer.
    pageSize: 'A4',
    pageMargins: [74, 94, 74, 70],
    // Repeat a quiet brand line on each page without competing with the letter.
    header: {
      columns: [
        { text: 'ResignLetter', style: 'wordmark' },
        { text: 'PROFESSIONAL LETTER', style: 'headerNote', alignment: 'right' },
      ],
      margin: [74, 34, 74, 0],
    },
    // Include page numbering and a review reminder on every page.
    footer: (currentPage: number, pageCount: number): Content => ({
      columns: [
        { text: 'ResignLetter  •  Review all details before sending', style: 'footer' },
        { text: `Page ${currentPage} of ${pageCount}`, style: 'footer', alignment: 'right' },
      ],
      margin: [74, 0, 74, 32],
    }),
    // Store useful document metadata, while avoiding an empty author value.
    info: { title: 'Resignation Letter', author: details.senderName || 'ResignLetter' },
    content,
    // Use pdfmake's bundled Roboto font for portable rendering across viewers and printers.
    defaultStyle: { font: 'Roboto', fontSize: 11, lineHeight: 1.45, color: '#253447' },
    styles: {
      wordmark: { fontSize: 10, bold: true, color: '#18334D', characterSpacing: 0.6 },
      headerNote: { fontSize: 7.5, bold: true, color: '#9B7A45', characterSpacing: 0.8 },
      eyebrow: { fontSize: 8, bold: true, color: '#9B7A45', characterSpacing: 1.3 },
      title: { fontSize: 25, bold: true, color: '#18334D' },
      subtitle: { fontSize: 10, color: '#64748B' },
      sectionLabel: { fontSize: 7.5, bold: true, color: '#9B7A45', characterSpacing: 0.9 },
      contactName: { fontSize: 10.5, bold: true, color: '#24364B' },
      contactDetail: { fontSize: 9.5, color: '#566579', lineHeight: 1.3 },
      date: { fontSize: 9.5, color: '#425168' },
      letterBody: { fontSize: 11.5, lineHeight: 1.55, color: '#253447' },
      footer: { fontSize: 7.5, color: '#8793A2' },
    },
  };
}

/** Generate a timestamp-named PDF on demand without loading PDF libraries on the editing path. */
export async function downloadLetterPdf(
  letter: string,
  details: LetterDetails,
  filename: string = createLetterDownloadFilename('pdf'),
): Promise<void> {
  // Load pdfmake and its virtual font files together only when a visitor exports;
  // this keeps the heavier PDF code off the normal editing path.
  const [pdfMakeModule, fontsModule] = await Promise.all([
    import('pdfmake/build/pdfmake'),
    import('pdfmake/build/vfs_fonts'),
  ]);
  // Register the bundled font data before creating a definition that references Roboto.
  pdfMakeModule.default.addVirtualFileSystem(fontsModule.default);
  await pdfMakeModule.default.createPdf(createLetterPdfDefinition(letter, details)).download(filename);
}