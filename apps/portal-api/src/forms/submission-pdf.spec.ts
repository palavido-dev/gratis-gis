// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  formatSubmissionReceipt,
  pdfText,
  receiptFilename,
  renderSubmissionPdf,
} from './submission-pdf';

describe('submission pdf', () => {
  it('escapes parentheses and keeps Latin-1 as octal', () => {
    expect(pdfText('a (b) \\ c')).toBe('a \\(b\\) \\\\ c');
    expect(pdfText('café')).toBe('caf\\351');
    expect(pdfText('雪')).toBe('?');
  });

  it('names the file from the title and a short id', () => {
    expect(receiptFilename('Park Bench Report!', 'abcd-1234-zzzz')).toBe(
      'park-bench-report-abcd1234.pdf',
    );
  });

  it('uses question labels and formats a point as lat, lon', () => {
    const receipt = formatSubmissionReceipt({
      title: 'Bench report',
      capturedAt: '2026-10-03T00:00:00.000Z',
      submissionId: 'sub-1',
      questions: [
        { id: 'note', label: 'What happened' },
        {
          id: 'where',
          label: 'Location',
          type: 'group',
          children: [{ id: 'spot', label: 'Spot' }],
        },
      ],
      response: {
        note: 'Broken (slat)',
        spot: { type: 'Point', coordinates: [-79.8, 38.9] },
        _internal: 'skip',
      },
    });
    expect(receipt.lines.map((line) => line.label)).toEqual([
      'Submission',
      'What happened',
      'Spot',
    ]);
    expect(receipt.lines[1]?.value).toBe('Broken (slat)');
    expect(receipt.lines[2]?.value).toBe('38.9, -79.8');
  });

  it('writes a PDF whose xref matches the file', () => {
    const bytes = renderSubmissionPdf({
      title: 'Bench (report)',
      capturedAt: '2026-10-03T00:00:00.000Z',
      lines: [{ label: 'Note', value: 'Broken (slat)' }],
    });
    const text = bytes.toString('latin1');
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text).toContain('Bench \\(report\\)');
    expect(text).toContain('Broken \\(slat\\)');
    expect(text).toContain('/Count 1');
    const start = Number(/startxref\n(\d+)/.exec(text)?.[1]);
    expect(text.slice(start, start + 4)).toBe('xref');
  });

  it('splits a long receipt across pages', () => {
    const bytes = renderSubmissionPdf({
      title: 'Long report',
      capturedAt: '2026-10-03T00:00:00.000Z',
      lines: Array.from({ length: 80 }, (_, i) => ({
        label: `Question ${i + 1}`,
        value: `Answer ${i + 1} with enough words to occupy a line of the receipt.`,
      })),
    });
    const text = bytes.toString('latin1');
    const count = Number(/\/Count (\d+)/.exec(text)?.[1]);
    expect(count).toBeGreaterThan(1);
  });
});
