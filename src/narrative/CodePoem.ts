/**
 * The language the world is written in (brief §08, §40).
 *
 * It has to read as *code* — keywords, calls, arguments, a cursor — while every
 * line is actually an instruction about light, weather, growth or memory. The
 * brief's arc is that the opening and the ending are the same program, so these
 * two sequences share a vocabulary deliberately: the last lines are the first
 * lines, seen from the other end.
 *
 * Kept as structured tokens rather than a formatted string so the overlay can
 * colour it without parsing anything.
 */

export type TokenKind = 'kw' | 'fn' | 'arg' | 'num' | 'str' | 'op' | 'plain' | 'comment';
export type Token = [TokenKind, string];
export type CodeLine = Token[];

const kw = (s: string): Token => ['kw', s];
const fn = (s: string): Token => ['fn', s];
const arg = (s: string): Token => ['arg', s];
const num = (s: string): Token => ['num', s];
const str = (s: string): Token => ['str', s];
const op = (s: string): Token => ['op', s];
const p = (s: string): Token => ['plain', s];
const cm = (s: string): Token => ['comment', s];

/** The opening: nothing, then a particle, then a tulip. */
export const GENESIS: CodeLine[] = [
  [cm('// nothing yet')],
  [],
  [kw('let'), p(' '), arg('dark'), p(' '), op('='), p(' '), fn('void'), op('()')],
  [kw('let'), p(' '), arg('one'), p(' '), op('='), p(' '), fn('particle'), op('('), num('1'), op(')')],
  [],
  [arg('one'), op('.'), fn('divide'), op('('), num('240'), op(')')],
  [arg('one'), op('.'), fn('follow'), op('('), fn('curve'), op('.'), arg('golden'), op(')')],
  [],
  [cm('// the curves remember they were veins')],
  [kw('for'), p(' '), arg('v'), p(' '), kw('in'), p(' '), arg('curves'), p(' '), op('{')],
  [p('  '), arg('v'), op('.'), fn('become'), op('('), str("'vein'"), op(')')],
  [p('  '), arg('v'), op('.'), fn('reach'), op('('), arg('down'), op(','), p(' '), arg('patience'), op(':'), p(' '), num('0.7'), op(')')],
  [op('}')],
  [],
  [arg('root'), op('.'), fn('enter'), op('('), arg('soil'), op(')')],
  [arg('stem'), op('.'), fn('rise'), op('('), arg('until'), op(':'), p(' '), arg('light'), op(')')],
  [arg('leaf'), op('.'), fn('unfold'), op('('), num('2'), op(')')],
  [],
  [kw('let'), p(' '), arg('bud'), p(' '), op('='), p(' '), fn('tulip'), op('('), arg('stage'), op(':'), p(' '), str("'closed'"), op(')')],
  [],
  [cm('// silence')],
  [],
  [arg('bud'), op('.'), fn('petal'), op('('), num('1'), op(')'), op('.'), fn('open'), op('()')],
  [arg('bud'), op('.'), fn('petal'), op('('), num('2'), op(')'), op('.'), fn('open'), op('()')],
  [arg('bud'), op('.'), fn('petal'), op('('), num('3'), op(')'), op('.'), fn('open'), op('()')],
  [arg('bud'), op('.'), fn('open'), op('('), arg('all'), op(')')],
  [],
  [arg('ground'), op('.'), fn('pulse'), op('()')],
];

/** The awakening: the field is written into existence. */
export const AWAKEN: CodeLine[] = [
  [arg('field'), op('.'), fn('sow'), op('('), num('10'), op(')')],
  [arg('field'), op('.'), fn('sow'), op('('), num('100'), op(')')],
  [arg('field'), op('.'), fn('sow'), op('('), num('1000'), op(')')],
  [arg('horizon'), op('.'), fn('begin'), op('()')],
  [],
  [arg('wind'), op('.'), fn('teach'), op('('), arg('gentleness'), op(')')],
  [arg('light'), op('.'), fn('learn'), op('('), arg('the'), p(' '), arg('hour'), op(')')],
  [arg('sky'), op('.'), fn('remember'), op('('), arg('weather'), op(')')],
  [arg('music'), op('.'), fn('listen'), op('()')],
];

/** The ending: the world resolves back into the program that made it. */
export const REVEAL: CodeLine[] = [
  [arg('world'), op('.'), fn('dissolve'), op('('), arg('into'), op(':'), p(' '), arg('particles'), op(')')],
  [arg('particles'), op('.'), fn('align'), op('('), arg('into'), op(':'), p(' '), arg('lines'), op(')')],
  [arg('lines'), op('.'), fn('resolve'), op('('), arg('into'), op(':'), p(' '), arg('code'), op(')')],
  [],
  [cm('// it has been running the whole time')],
  [],
  [arg('world'), op('.'), fn('status'), op('()')],
];

/** Poetic messages hidden inside particular tulips (brief §33). */
export const PETAL_MESSAGES: readonly string[] = [
  'I’m proud of you.',
  'Take your time.',
  'You don’t have to carry everything alone.',
  'Keep going.',
  'Somewhere, someone is cheering for you.',
  'You make ordinary moments feel different.',
  'You deserve beautiful things too.',
  'Rest is allowed.',
  'This was worth building.',
  'You are not behind.',
  'Look how far the field goes.',
  'Some things grow quietly.',
];

/** The loading stages, in the brief's own words (§54). */
export const LOADING_STAGES: readonly string[] = [
  'Planting the first seed…',
  'Growing the roots…',
  'Teaching the tulips to dance…',
  'Teaching the wind…',
  'Finding the music…',
  'Creating her garden…',
];

export const LOADING_FINAL = 'Open your eyes.';

export const FINAL_LINES: readonly string[] = ['WORLD CREATED.', 'FOR HER.'];

export const SECRET_ENDING_LINES: readonly string[] = [
  'Maybe some worlds aren’t meant to be visited.',
  'Maybe they’re meant to be felt.',
];
