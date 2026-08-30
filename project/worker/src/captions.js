/**
 * Burned-in captions, built as ASS subtitles and rendered by libass.
 *
 * ASS rather than a stack of drawtext filters: a minute of speech is around 150 words, and
 * highlighting each one with drawtext means 150 filters with hand-computed x positions and
 * no line wrapping. libass does layout, wrapping, outlines and per-word colour itself, and
 * FFmpeg's `subtitles` filter is one argument.
 *
 * Colours below are ASS's &HAABBGGRR — alpha first and the channels reversed from CSS, so
 * &H0000E5FF is opaque #FFE500. Getting that backwards silently swaps red and blue.
 */

const WHITE = '&H00FFFFFF';
const BLACK = '&H00000000';
const YELLOW = '&H0000E5FF';
const CYAN = '&H00FFD42D';
const DIM = '&H00BBBBBB';

/**
 * The presets offered in the Clips tab.
 *
 * `highlight` drives the one structural difference between them: a highlighted style emits
 * one event per word so the active word can change colour mid-line, while an unhighlighted
 * one emits a single event per line. Everything else is styling.
 */
export const CAPTION_STYLES = {
  bold: {
    label: 'Bold',
    description: 'Big uppercase with a heavy outline, active word in yellow.',
    fontSize: 92,
    outline: 7,
    shadow: 0,
    borderStyle: 1,
    uppercase: true,
    marginV: 340,
    maxChars: 20,
    maxWords: 4,
    primary: WHITE,
    highlight: YELLOW,
    inactive: WHITE,
    pop: true,
  },
  karaoke: {
    label: 'Karaoke',
    description: 'Spoken words light up in cyan as they are said.',
    fontSize: 84,
    outline: 6,
    shadow: 0,
    borderStyle: 1,
    uppercase: false,
    marginV: 340,
    maxChars: 26,
    maxWords: 6,
    primary: DIM,
    highlight: CYAN,
    inactive: DIM,
    pop: false,
  },
  minimal: {
    label: 'Minimal',
    description: 'Clean sentence case, no highlighting.',
    fontSize: 64,
    outline: 3,
    shadow: 1,
    borderStyle: 1,
    uppercase: false,
    marginV: 300,
    maxChars: 34,
    maxWords: 8,
    primary: WHITE,
    highlight: null,
    inactive: WHITE,
    pop: false,
  },
  boxed: {
    label: 'Boxed',
    description: 'White text on a solid bar, readable over anything.',
    fontSize: 68,
    outline: 6,
    shadow: 0,
    // BorderStyle 3 turns the outline into a filled box behind the text rather than a
    // stroke around each glyph.
    borderStyle: 3,
    uppercase: false,
    marginV: 320,
    maxChars: 30,
    maxWords: 7,
    primary: WHITE,
    highlight: null,
    inactive: WHITE,
    pop: false,
  },
  none: { label: 'None', description: 'No captions.', disabled: true },
};

/** Words whose spoken time overlaps the window, rebased so the clip starts at zero. */
export function wordsInWindow(words, startSeconds, endSeconds) {
  return (words || [])
    .filter((w) => w.e > startSeconds && w.s < endSeconds)
    .map((w) => ({
      w: w.w,
      s: Math.max(0, w.s - startSeconds),
      e: Math.min(endSeconds - startSeconds, w.e - startSeconds),
    }))
    .filter((w) => w.e > w.s);
}

/**
 * Groups words into caption lines.
 *
 * Breaks on the character and word limits, and also on a pause: a gap of more than
 * `gapSeconds` between words is nearly always a sentence boundary, and holding the previous
 * line across it leaves stale text on screen during silence.
 */
export function groupIntoLines(words, { maxChars, maxWords, gapSeconds = 0.7 }) {
  const lines = [];
  let current = [];

  const flush = () => {
    if (current.length > 0) lines.push(current);
    current = [];
  };

  for (const word of words) {
    const previous = current[current.length - 1];
    const wouldBeLength = current.reduce((n, w) => n + w.w.length + 1, 0) + word.w.length;

    if (
      current.length >= maxWords ||
      (current.length > 0 && wouldBeLength > maxChars) ||
      (previous && word.s - previous.e > gapSeconds)
    ) {
      flush();
    }
    current.push(word);
  }
  flush();

  return lines;
}

/** ASS timestamps are H:MM:SS.cc — centiseconds, and the hour is not zero-padded. */
export function assTime(seconds) {
  const clamped = Math.max(0, seconds);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = Math.floor(clamped % 60);
  const cs = Math.round((clamped - Math.floor(clamped)) * 100);
  // Rounding centiseconds can carry past 99, which would emit "SS.100".
  const carry = cs === 100;
  return `${h}:${pad(m)}:${pad(carry ? s + 1 : s)}.${pad(carry ? 0 : cs)}`;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

/**
 * Braces introduce override blocks in ASS and a backslash starts an escape, so text
 * containing either would be parsed as markup instead of shown. Newlines are replaced by
 * spaces because line breaking is libass's job, not the transcript's.
 */
export function escapeAss(text) {
  return String(text)
    .replace(/\\/g, '')
    .replace(/\{/g, '(')
    .replace(/\}/g, ')')
    .replace(/\r?\n/g, ' ')
    .trim();
}

/**
 * Builds the .ass file for one clip.
 *
 * Returns an empty string when there is nothing to draw, which the caller treats as "skip
 * the subtitles filter" — an empty subtitle file is valid but makes FFmpeg do pointless work.
 */
export function buildAss({ words, styleName, width = 1080, height = 1920 }) {
  const style = CAPTION_STYLES[styleName];
  if (!style || style.disabled || words.length === 0) return '';

  const lines = groupIntoLines(words, { maxChars: style.maxChars, maxWords: style.maxWords });
  const events = [];

  for (const line of lines) {
    const lineEnd = line[line.length - 1].e;
    const text = (w) => escapeAss(style.uppercase ? w.w.toUpperCase() : w.w);

    if (!style.highlight) {
      // One event for the whole line; nothing changes while it is on screen.
      events.push(event(line[0].s, lineEnd, line.map(text).join(' ')));
      continue;
    }

    // One event per word, each holding until the next word begins so the line stays on
    // screen continuously rather than blinking out during the gaps between words.
    for (let i = 0; i < line.length; i++) {
      const start = line[i].s;
      const end = i + 1 < line.length ? line[i + 1].s : lineEnd;
      if (end <= start) continue;

      const rendered = line.map((word, j) => {
        const body = text(word);
        if (j !== i) return `{\\c${style.inactive}}${body}`;
        const pop = style.pop ? '\\fscx108\\fscy108' : '';
        return `{\\c${style.highlight}${pop}}${body}{\\fscx100\\fscy100}`;
      });

      events.push(event(start, end, rendered.join(' ')));
    }
  }

  if (events.length === 0) return '';

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    // WrapStyle 0 balances the lines libass has to wrap itself.
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, ' +
      'BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, ' +
      'BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // Alignment 2 is bottom-centre, which MarginV then lifts into the lower third.
    `Style: Default,${fontName()},${style.fontSize},${style.primary},${style.highlight ?? style.primary},` +
      `${BLACK},${BLACK},-1,0,0,0,100,100,0,0,${style.borderStyle},${style.outline},${style.shadow},` +
      `2,80,80,${style.marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  return `${header.join('\n')}\n${events.join('\n')}\n`;
}

function event(start, end, text) {
  return `Dialogue: 0,${assTime(start)},${assTime(end)},Default,,0,0,0,,${text}`;
}

/**
 * libass resolves fonts by family name through fontconfig, so this is a family ("DejaVu
 * Sans") rather than a file path. The Docker image ships DejaVu; CAPTION_FONT overrides it
 * when a nicer face is available on the host.
 */
function fontName() {
  return process.env.CAPTION_FONT || 'DejaVu Sans';
}
