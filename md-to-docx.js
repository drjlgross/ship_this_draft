import { marked } from 'marked';
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
} from 'docx';

const HEADINGS = [
  HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6,
];

// Flatten marked's inline tokens into docx TextRuns, carrying bold/italic
// down through nesting. Links render as their text only.
function runs(tokens, style = {}) {
  const out = [];
  for (const t of tokens ?? []) {
    switch (t.type) {
      case 'strong':
        out.push(...runs(t.tokens, { ...style, bold: true }));
        break;
      case 'em':
        out.push(...runs(t.tokens, { ...style, italics: true }));
        break;
      case 'del':
        out.push(...runs(t.tokens, { ...style, strike: true }));
        break;
      case 'link':
        out.push(...runs(t.tokens, style));
        break;
      case 'codespan':
        out.push(new TextRun({ ...style, text: t.text, font: 'Courier New' }));
        break;
      case 'br':
        out.push(new TextRun({ ...style, break: 1 }));
        break;
      case 'text':
        if (t.tokens) out.push(...runs(t.tokens, style));
        else out.push(new TextRun({ ...style, text: t.text }));
        break;
      case 'escape':
      case 'html':
        out.push(new TextRun({ ...style, text: t.text }));
        break;
      default:
        if (t.tokens) out.push(...runs(t.tokens, style));
        else if (t.text) out.push(new TextRun({ ...style, text: t.text }));
    }
  }
  return out;
}

function listParagraphs(token, depth = 0) {
  const paras = [];
  for (const item of token.items) {
    const inline = [];
    const nested = [];
    for (const child of item.tokens ?? []) {
      if (child.type === 'list') nested.push(child);
      else if (child.type === 'text' || child.type === 'paragraph') inline.push(...runs(child.tokens ?? [{ type: 'text', text: child.text }]));
      else inline.push(...runs(child.tokens ?? []));
    }
    paras.push(new Paragraph({
      children: inline,
      ...(token.ordered
        ? { numbering: { reference: 'ordered', level: depth } }
        : { bullet: { level: depth } }),
    }));
    for (const n of nested) paras.push(...listParagraphs(n, depth + 1));
  }
  return paras;
}

function blockParagraphs(tokens) {
  const paras = [];
  for (const t of tokens) {
    switch (t.type) {
      case 'heading':
        paras.push(new Paragraph({
          children: runs(t.tokens),
          heading: HEADINGS[Math.min(t.depth, 6) - 1],
        }));
        break;
      case 'paragraph':
        paras.push(new Paragraph({ children: runs(t.tokens) }));
        break;
      case 'list':
        paras.push(...listParagraphs(t));
        break;
      case 'blockquote':
        for (const p of blockParagraphs(t.tokens)) paras.push(p);
        break;
      case 'code':
        for (const line of t.text.split('\n')) {
          paras.push(new Paragraph({
            children: [new TextRun({ text: line, font: 'Courier New' })],
          }));
        }
        break;
      case 'hr':
        paras.push(new Paragraph({ children: [new TextRun({ text: '' })], thematicBreak: true }));
        break;
      case 'space':
        break;
      default:
        if (t.text) paras.push(new Paragraph({ children: [new TextRun({ text: t.text })] }));
    }
  }
  return paras;
}

export async function markdownToDocx(markdown) {
  const doc = new Document({
    numbering: {
      config: [{
        reference: 'ordered',
        levels: [0, 1, 2, 3].map((level) => ({
          level,
          format: 'decimal',
          text: `%${level + 1}.`,
          alignment: 'left',
          style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
        })),
      }],
    },
    sections: [{ children: blockParagraphs(marked.lexer(markdown)) }],
  });
  return Packer.toBuffer(doc);
}
