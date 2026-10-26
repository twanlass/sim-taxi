// Slide 3: a retro character select. Four little pixel people, the family, and a click (or the
// clicker's →) drops the next player tag onto the next of them, 1P to 4P, and each one picked drops
// into a bouncing stance of their own — and then Heather goes grey and falls off the screen, because she
// isn't playing, and the other three close up. START shows once the team is settled. The sprites
// are drawn here from character grids, the way every mesh in the game is built
// in code; the styles are in talk/index.html.
import '@fontsource/press-start-2p';

/**
 * The head every sprite shares, 16 wide, before hair: S skin, s skin shade, W the eye's glint,
 * E the iris, e the pupil, M mouth. The body below it is one of BODY's poses; an outline is added
 * round whatever ends up filled.
 */
const HEAD = [
  '................',
  '................',
  '................',
  '....SSSSSSSS....',
  '...SSSSSSSSSS...',
  '...SSSSSSSSSS...',
  '...SSSSSSSSSS...',
  '...SSWESSWESS...',
  '...SSEeSSEeSS...',
  '..sSSSSSSSSSSs..',
  '...SSSSSSSSSS...',
  '...SSSSMMSSSS...',
  '....SSSSSSSS....',
  '.....ssSSss.....',
];

/**
 * The body, 13 rows under the head: T shirt, S hands, P trousers, F shoes. `stand` is arms down,
 * feet together; the rest are what each player drops into when picked, one each so the four don't
 * read as the same sprite in different shirts. `guard` is the fighting-game idle, a boxer's guard
 * in three-quarter view — turned to face right, the lead fist up by the chin, the rear one in front
 * of the chest, the feet staggered. (The first cut stood square-on with its knees out and its fists
 * at its shoulders, and read as a squat rather than a fight.) `akimbo` is hands on hips, elbows out;
 * `cheer` punches one fist at the sky; `kick` throws a leg out sideways at hip height.
 *
 * `spare` lists rows that can come out without breaking the pose, in the order they go: a shorter
 * player loses the first few (`short`), and the bounce's low frame loses the next one (`frameGrid`).
 * So each pose needs one more spare row than the shortest player who wears it is short.
 */
const BODY = {
  stand: {
    spare: [9, 10, 3, 8],
    rows: [
      '....TTssssTT....',
      '...TTTTTTTTTT...',
      '..TTTTTTTTTTTT..',
      '..TTTTTTTTTTTT..',
      '..STTTTTTTTTTS..',
      '..STTTTTTTTTTS..',
      '..S.PPPPPPPP.S..',
      '....PPPPPPPP....',
      '....PPP..PPP....',
      '....PPP..PPP....',
      '....PPP..PPP....',
      '....FFF..FFF....',
      '...FFFF..FFFF...',
    ],
  },
  guard: {
    spare: [9, 8, 10, 3],
    rows: [
      '....TTsssKSSTT..',
      '...TTTTTTTTTTT..',
      '...TTTTTTTTTTT..',
      '...TTTTTTTTTT...',
      '....TTTTTTTT....',
      '....TTTTTTTT....',
      '....PPPPPPPP....',
      '...PPPP.PPPP....',
      '..PPP....PPPP...',
      '..PPP.....PPP...',
      '.PPP......PPP...',
      '.FFF.......FFF..',
      '.FFF.......FFFF.',
    ],
  },
  akimbo: {
    spare: [9, 8, 10, 3],
    rows: [
      '....TTssssTT....',
      '...TTTTTTTTTT...',
      '..TTTTTTTTTTTT..',
      '.TTTTTTTTTTTTTT.',
      'TT.TTTTTTTTTT.TT',
      '.S..TTTTTTTT..S.',
      '..SSPPPPPPPPSS..',
      '....PPPPPPPP....',
      '...PPP...PPP....',
      '...PPP....PPP...',
      '..PPP.....PPP...',
      '..FFF.....FFF...',
      '.FFFF.....FFFF..',
    ],
  },
  cheer: {
    spare: [8, 9, 3, 10],
    rows: [
      '....TTssssTTTTT.',
      '...TTTTTTTTTT...',
      '..TTTTTTTTTTT...',
      '..TTTTTTTTTTT...',
      '..STTTTTTTTTT...',
      '..STTTTTTTTTT...',
      '..S.PPPPPPPP....',
      '....PPPPPPPP....',
      '....PPP..PPP....',
      '...PPP....PPP...',
      '..PPP......PPP..',
      '..FFF......FFF..',
      '.FFFF......FFFF.',
    ],
  },
  kick: {
    spare: [9, 10, 3, 8, 2],
    rows: [
      '....TTsssKSSTT..',
      '...TTTTTTTTTTT..',
      '..TTTTTTTTTTTT..',
      '..TTTTTTTTTTTT..',
      '..STTTTTTTTTT...',
      '.SSTTTTTTTTTT...',
      '....PPPPPPPPPPPF',
      '....PPPPPPPPPPPF',
      '....PPP.........',
      '....PPP.........',
      '....PPP.........',
      '....FFF.........',
      '...FFFF.........',
    ],
  },
};
/**
 * What a pose draws over the head, laid on after the hair: the guard's fists come up beside the
 * chin, the lead one big and out in front, the rear one tucked under it, so the arms read as up. K
 * is outline drawn by hand: a fist is skin against skin where it meets the face, and the automatic
 * outline only rings filled cells against empty ones, so the first cut melted the fists into the
 * chin. The cheer's arm runs up the side of the head into the empty rows above the hair, over a
 * pigtail. Rows are counted from the top of the head.
 */
const FISTS_UP = {
  11: '............KSS.',
  12: '............KSS.',
  13: '.........KSSKTT.',
};
const HEAD_POSE = {
  stand: {},
  guard: FISTS_UP,
  akimbo: {},
  cheer: {
    0: '.............SSS',
    1: '.............SSS',
    2: '.............KSS',
    ...Object.fromEntries([3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((y) => [y, '.............KSS'])),
    13: '.............TTT',
  },
  kick: FISTS_UP,
};
// The sprite's cell, one pixel of outline room on every side of the 16 × 27 figure.
const CELL_W = 18;
const CELL_H = 29;
// The frames along the sheet: standing, then the two halves of the bounce in the player's own pose.
const FRAMES = [['stand', 0], [null, 0], [null, 1]];

/** Rosy cheeks, laid over the face like the hair: a dab each side, or a big round flush. */
const CHEEKS = {
  small: { 10: '...SBSSSSSSBS...' },
  big: { 10: '...BBSSSSSSBB...', 11: '....BSSMMSSB....' },
};

/** Hair laid over the face: H hair, R a ribbon; '.' leaves the face as it is. */
const HAIR = {
  // Tyler's: swept over to one side in a wave, the fringe curling back up at its tip.
  wave: [
    '.....HHHHHH.....',
    '...HHHHHHHHHH...',
    '..HHHHHHHHHHHH..',
    '..HHHHHHHHHHHH..',
    '..HHHHHHHH..HH..',
    '..HH..HHH...HH..',
    '...H........H...',
  ],
  // Long and parted down the middle: the part opens a V of forehead, then it falls past the shoulders.
  parted: [
    '................',
    '....HHHHHHHH....',
    '...HHHHHHHHHH...',
    '..HHHHH..HHHHH..',
    '..HHHH....HHHH..',
    '..HHH......HHH..',
    '..HH........HH..',
    '..HH........HH..',
    '..HH........HH..',
    '..HH........HH..',
    '..HH........HH..',
    '..HH........HH..',
    '..HH........HH..',
    '.HHH........HHH.',
    '.HHH........HHH.',
    '.HHH........HHH.',
    '.HH..........HH.',
  ],
  pigtails: [
    '................',
    '....HHHHHHHH....',
    '...HHHHHHHHHH...',
    '...HHHHHHHHHH...',
    '..HHHHHHHHHHHH..',
    'HHHR........RHHH',
    'HHH..........HHH',
    'HH............HH',
    'HH............HH',
    '.H............H.',
  ],
};

const SKIN = { S: '#f1c29a', s: '#d9a57c', W: '#ffffff', e: '#1a120e', B: '#f08a84', M: '#a33a3a', F: '#2a2a33' };
const OUTLINE = '#120d16';
const GREEN_EYES = '#3f9a4a';

// In the order the tags land. `sitsOut` is the joke: once all four are picked, she falls off the
// screen. `age` and `stat` (chunks out of STAT_CHUNKS) are the stat block under each name. `short` is
// how many rows shorter than Tyler they stand — a row each, tallest to smallest — and `pose` is the
// stance they drop into when picked.
const PLAYERS = [
  { name: 'Tyler', age: 'old', stat: 2, hair: 'wave', cheeks: 'big', H: '#6b4226', E: GREEN_EYES, T: '#c8432f', P: '#3b4f7a', short: 0, pose: 'guard' },
  { name: 'Heather', age: 'young', stat: 5, hair: 'parted', cheeks: 'small', H: '#6e4a2e', E: GREEN_EYES, T: '#8a4fd0', P: '#2f3a52', short: 1, pose: 'akimbo', sitsOut: true },
  { name: 'Isla', age: '11', stat: 4, hair: 'pigtails', cheeks: 'big', H: '#e8c35a', E: '#3a7bd5', M: '#d8323c', T: '#f06aa0', P: '#4a7bc8', R: '#d8323c', short: 2, pose: 'cheer' },
  { name: 'Nia', age: '8', stat: 3, hair: 'parted', cheeks: 'small', H: '#4f3220', E: GREEN_EYES, T: '#59c27a', P: '#5a4a7a', short: 3, pose: 'kick' },
];
// The stat bar's length, and its label until we know what the stat is.
const STAT_CHUNKS = 5;
const STAT_LABEL = '???';
// The arcade's player colours: red, blue, green, yellow.
const TAG_COLOURS = ['#ff4d4d', '#3fa9ff', '#52d16b', '#ffd23f'];
// How long the four of them stand picked before Heather's tag comes off.
const SIT_OUT_MS = 1400;

/**
 * One frame of a sprite as rows of cells, feet on the bottom row. A shorter player loses `short` of
 * the pose's spare rows and the bounce's low half one more. Whatever is taken out goes back in as
 * empty rows on top, which is what drops the figure.
 */
function frameGrid(p, pose, low) {
  const { rows, spare } = BODY[pose];
  const body = rows.map((row) => [...row]);
  const cut = spare.slice(0, p.short + (low ? 1 : 0));
  for (const i of cut.sort((x, y) => y - x)) body.splice(i, 1);
  const grid = [...HEAD.map((row) => [...row]), ...body];
  const over = (rows) => Object.entries(rows).forEach(([y, row]) => [...row].forEach((c, x) => {
    // Past the head, hair only falls over the shirt — never over a raised fist.
    if (c !== '.' && (y < HEAD.length || '.T'.includes(grid[y][x]))) grid[y][x] = c;
  }));
  over(CHEEKS[p.cheeks]);
  over(HAIR[p.hair]);
  over(HEAD_POSE[pose]);
  return [...cut.map(() => [...'.'.repeat(16)]), ...grid];
}

/** The sprite sheet, every frame side by side, as an image URL; CSS steps through it unsmoothed. */
function spriteSheet(p) {
  const colours = { ...SKIN, K: OUTLINE, H: p.H, E: p.E, T: p.T, P: p.P, R: p.R, ...(p.M && { M: p.M }) };
  const c = document.createElement('canvas');
  c.width = CELL_W * FRAMES.length; c.height = CELL_H;
  const g = c.getContext('2d');
  FRAMES.forEach(([pose, low], f) => {
    const grid = frameGrid(p, pose ?? p.pose, low);
    const filled = (x, y) => grid[y]?.[x] !== undefined && grid[y][x] !== '.';
    for (let y = -1; y <= grid.length; y++) {
      for (let x = -1; x <= 16; x++) {
        if (filled(x, y)) g.fillStyle = colours[grid[y][x]];
        // The outline: any empty cell beside a filled one, so every shape carries its own edge.
        else if (filled(x - 1, y) || filled(x + 1, y) || filled(x, y - 1) || filled(x, y + 1)) g.fillStyle = OUTLINE;
        else continue;
        g.fillRect(f * CELL_W + x + 1, y + 1, 1, 1);
      }
    }
  });
  return c.toDataURL();
}

/**
 * Build the screen inside `slide`. `start` is called by the START button. Sets `slide.advance`,
 * which the deck calls on → before moving on: it places the next tag, or sends the one who sits out
 * off early, and answers true while there's something left to do. Everything resets when the slide
 * is left (`leave`).
 */
export function mountSelect(slide, { start }) {
  const title = document.createElement('h2');
  title.textContent = 'Choose your player';
  const roster = document.createElement('div');
  roster.className = 'roster';
  const fighters = PLAYERS.map((p, i) => {
    const f = document.createElement('div');
    f.className = 'fighter';
    f.style.setProperty('--p', TAG_COLOURS[i]);
    // Where the head starts down the cell: below the rows a shorter player doesn't have.
    f.style.setProperty('--top', String(p.short / CELL_H));
    const frame = document.createElement('div');
    frame.className = 'sprite';
    frame.style.backgroundImage = `url(${spriteSheet(p)})`;
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = `${i + 1}P`;
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = p.name;
    // The stat block: age, then one stat as a bar of chunks.
    const stats = document.createElement('div');
    stats.className = 'stats';
    const age = document.createElement('div');
    age.textContent = `Age: ${p.age}`;
    const bar = document.createElement('div');
    bar.className = 'bar';
    const label = document.createElement('span');
    label.textContent = STAT_LABEL;
    bar.appendChild(label);
    for (let k = 0; k < STAT_CHUNKS; k++) {
      const chunk = document.createElement('i');
      if (k < p.stat) chunk.className = 'on';
      bar.appendChild(chunk);
    }
    stats.append(age, bar);
    f.append(tag, frame, name, stats);
    roster.appendChild(f);
    return f;
  });
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'start';
  button.textContent = 'Start';
  slide.append(title, roster, button);

  let placed = 0;
  let satOut = false;
  let timer = 0;
  const leaver = fighters[PLAYERS.findIndex((p) => p.sitsOut)];
  // The joke: everyone's picked, a beat, and then one of them isn't.
  const sitOut = () => {
    clearTimeout(timer);
    satOut = true;
    leaver?.classList.add('dropped');
    slide.classList.add('ready');
  };
  const place = () => {
    if (placed < fighters.length) {
      fighters[placed++].classList.add('taken');
      if (placed === fighters.length) timer = setTimeout(sitOut, SIT_OUT_MS);
      return true;
    }
    if (!satOut) { sitOut(); return true; }
    return false;
  };
  slide.addEventListener('click', place);
  button.addEventListener('click', (e) => { e.stopPropagation(); start(); });
  slide.advance = place;
  slide.addEventListener('leave', () => {
    clearTimeout(timer);
    placed = 0;
    satOut = false;
    for (const f of fighters) f.classList.remove('taken', 'dropped');
    slide.classList.remove('ready');
  });
}
