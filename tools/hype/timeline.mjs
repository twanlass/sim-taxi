/**
 * The trailer's structure, shared by the soundtrack and the edit so that a cut and a drum hit can
 * never drift apart. 120 BPM: a beat is 0.5s — exactly 15 frames at 30fps — and a bar is 2s.
 */

export const BPM = 120;
export const FPS = 30;
export const BEAT = 60 / BPM;
export const BAR = BEAT * 4;

// In seconds. Every boundary sits on a bar line.
export const SECTIONS = [
  { name: 'intro', start: 0, end: 8, music: 'intro' },
  { name: 'title', start: 8, end: 16, music: 'drop' },
  { name: 'clock', start: 16, end: 22, music: 'groove' },
  { name: 'loco', start: 22, end: 30, music: 'lift' },
  { name: 'city', start: 30, end: 36, music: 'groove' },
  { name: 'heist', start: 36, end: 44, music: 'groove', lead: true },
  { name: 'wreck', start: 44, end: 50, music: 'breath' },
  { name: 'finale', start: 50, end: 56, music: 'finale' },
  { name: 'end', start: 56, end: 62, music: 'end' },
];

export const TOTAL = SECTIONS.at(-1).end;
