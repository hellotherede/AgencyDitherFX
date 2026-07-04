export const defaultSymbols = {
  circle:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="32"/></svg>',
  square:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="18" y="18" width="64" height="64" rx="5"/></svg>',
  diamond:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M50 8 92 50 50 92 8 50Z"/></svg>',
  slash:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="m19 88-11-11L81 4l11 11Z"/></svg>',
  cross:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M42 8h16v34h34v16H58v34H42V58H8V42h34Z"/></svg>',
  star:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="m50 4 11 34 35 12-35 11-11 35-12-35L4 50l34-12Z"/></svg>',
  ring:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill-rule="evenodd" d="M50 8a42 42 0 1 1 0 84 42 42 0 0 1 0-84Zm0 18a24 24 0 1 0 0 48 24 24 0 0 0 0-48Z"/></svg>'
} as const;

export type DefaultSymbolName = keyof typeof defaultSymbols;
