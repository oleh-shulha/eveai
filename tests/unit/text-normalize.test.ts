import { describe, expect, it } from 'vitest';
import { normalizeAgentText } from '../../src/agent/text-normalize.js';

describe('LaTeX in chat answers', () => {
  it('renders the arrow a model wrote in math mode', () => {
    // Exactly what reached the chat: "Расчет для рейса Jita $\rightarrow$ Villore".
    expect(normalizeAgentText('рейс Jita $\\rightarrow$ Villore'))
      .toBe('рейс Jita → Villore');
  });

  it('handles the bare command and the spaced math mode', () => {
    expect(normalizeAgentText('Jita \\to Amarr')).toBe('Jita → Amarr');
    expect(normalizeAgentText('Jita $ \\rightarrow $ Amarr')).toBe('Jita → Amarr');
  });

  it('translates the symbols a market answer actually uses', () => {
    expect(normalizeAgentText('12 000 \\times 17 160 ISK')).toBe('12 000 × 17 160 ISK');
    expect(normalizeAgentText('ROI \\approx 39.9\\%')).toBe('ROI ≈ 39.9%');
    expect(normalizeAgentText('profit \\ge 80M, loss \\le 0, delta \\pm 5%'))
      .toBe('profit ≥ 80M, loss ≤ 0, delta ± 5%');
  });

  it('drops inline math delimiters around already-plain text', () => {
    expect(normalizeAgentText('маржа \\(82 080 000 ISK\\)')).toBe('маржа (82 080 000 ISK)');
  });

  it('leaves a fenced block exactly as written', () => {
    const fit = ['Вот фит:', '```', 'Damage Control II', 'x \\times y $\\rightarrow$ z', '```', 'готово'].join('\n');

    expect(normalizeAgentText(fit)).toBe(fit);
  });

  it('leaves an inline code span alone', () => {
    expect(normalizeAgentText('используй `\\times` как есть'))
      .toBe('используй `\\times` как есть');
  });

  it('touches nothing when there is no backslash', () => {
    const clean = 'Jita → Villore, прибыль 82 000 000 ISK ($5 за блок)';

    expect(normalizeAgentText(clean)).toBe(clean);
  });

  it('leaves an expression it cannot render as one character alone', () => {
    // A half-rendered formula is worse than an honest one.
    const formula = 'объём: $\\frac{a}{b}$';

    expect(normalizeAgentText(formula)).toBe(formula);
  });
});
