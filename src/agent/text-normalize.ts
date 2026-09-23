/**
 * LaTeX a model reaches for out of habit, rendered as the character it meant.
 *
 * Nothing downstream renders math: Telegram, Discord, the CLI and the browser
 * all show `$\rightarrow$` verbatim in the middle of a sentence. Models trained
 * hard on maths reach for math mode for something as ordinary as an arrow, and
 * asking them not to in the prompt only reduces it.
 *
 * Only symbols are translated. This is not a TeX renderer: an expression that
 * cannot become a single character is left exactly as the model wrote it,
 * because a half-rendered formula is worse than an honest one.
 */

const LATEX_SYMBOLS: ReadonlyArray<[RegExp, string]> = [
  [/\\(?:longrightarrow|rightarrow|to)\b/g, '→'],
  [/\\(?:longleftarrow|leftarrow|gets)\b/g, '←'],
  [/\\(?:longleftrightarrow|leftrightarrow)\b/g, '↔'],
  [/\\Rightarrow\b/g, '⇒'],
  [/\\Leftarrow\b/g, '⇐'],
  [/\\times\b/g, '×'],
  [/\\cdot\b/g, '·'],
  [/\\div\b/g, '÷'],
  [/\\approx\b/g, '≈'],
  [/\\pm\b/g, '±'],
  [/\\(?:leq|le)\b/g, '≤'],
  [/\\(?:geq|ge)\b/g, '≥'],
  [/\\(?:neq|ne)\b/g, '≠'],
  [/\\infty\b/g, '∞'],
  [/\\(?:ldots|dots)\b/g, '…'],
];

/** Math mode wrapped around a symbol the step above already made plain text. */
const WRAPPED_SYMBOL = /\$\s*([←→↔⇐⇒×·÷≈±≤≥≠∞…]+)\s*\$/g;

/**
 * Escaped punctuation: the backslash belongs to TeX or to Markdown, the
 * character belongs to the answer. An inline-math delimiter `\(` becomes a
 * parenthesis rather than nothing — unescaping never deletes text the model
 * wrote, and this pipeline is Markdown first.
 */
const ESCAPED_PUNCTUATION = /\\([%&#_{}$()[\]])/g;

export function normalizeAgentText(text: string): string {
  // Every rule needs a backslash, so text without one is already clean.
  if (!text.includes('\\')) return text;
  return mapOutsideCode(text, (segment) => {
    let out = segment;
    for (const [pattern, symbol] of LATEX_SYMBOLS) out = out.replace(pattern, symbol);
    out = out.replace(WRAPPED_SYMBOL, '$1');
    return out.replace(ESCAPED_PUNCTUATION, '$1');
  });
}

/**
 * Apply a transform to prose only. A fenced block or an inline span is quoted
 * text — an EFT fit, a SQL snippet, a command — and rewriting characters inside
 * it would corrupt something the pilot is meant to copy verbatim.
 */
function mapOutsideCode(text: string, transform: (segment: string) => string): string {
  return text
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((part, index) => (index % 2 === 1 ? part : transform(part)))
    .join('');
}
