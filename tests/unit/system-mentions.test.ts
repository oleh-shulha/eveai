import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import type { Db } from '../../src/db/sqlite.js';
import { findSystemMentions } from '../../src/eve/system-mentions.js';

let db: Database.Database;

const SYSTEMS: Array<[number, string]> = [
  [30000142, 'Jita'],
  [30002053, 'Villore'],
  [30002187, 'Amarr'],
  [30000144, 'Perimeter'],
  [30001407, 'New Caldari'],
  [30002659, 'Dodixie'],
  // Real systems whose names are ordinary words — the false-positive trap.
  [30003504, 'Hope'],
  [30004759, 'Center'],
  [30001161, 'F3R-IA'],
];

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  const insert = db.prepare('INSERT INTO sde_systems (system_id, name, constellation_id, data_json) VALUES (?, ?, 1, ?)');
  for (const [id, name] of SYSTEMS) insert.run(id, name, '{}');
});

afterEach(() => {
  db.close();
});

function names(text: string): string[] {
  return findSystemMentions(db as Db, text).map((entry) => entry.name);
}

describe('systems named in an answer', () => {
  it('finds the systems a trade answer talks about', () => {
    const text = 'Расчет для рейса Jita → Villore (Essence): закупка в Jita, продажа в Villore.';

    expect(findSystemMentions(db as Db, text)).toEqual([
      { systemId: 30000142, name: 'Jita' },
      { systemId: 30002053, name: 'Villore' },
    ]);
  });

  it('prefers the longer name over its first word', () => {
    expect(names('Ищи ордера в New Caldari, там дешевле')).toEqual(['New Caldari']);
  });

  it('matches the nullsec shape despite being short', () => {
    expect(names('Маршрут до F3R-IA не строится')).toEqual(['F3R-IA']);
  });

  it('does not turn ordinary words into systems', () => {
    // Hope and Center are real systems; these sentences are not about them.
    expect(names('there is hope for a better price in the center of the region')).toEqual([]);
    expect(names('надежда есть, смотри в центре региона')).toEqual([]);
  });

  it('ignores a name inside a word, a URL, or a link target', () => {
    expect(names('Jitanium is not a system')).toEqual([]);
    expect(names('см. https://example.com/Jita/prices')).toEqual([]);
    expect(names('[рынок](https://example.com/Amarr)')).toEqual([]);
  });

  it('leaves code blocks and inline spans alone', () => {
    const fit = ['```', 'undock at Jita IV', '```', 'и ещё `Amarr`'].join('\n');

    expect(names(fit)).toEqual([]);
  });

  it('reports each system once, in reading order', () => {
    expect(names('Из Jita в Amarr, потом обратно в Jita, затем Dodixie'))
      .toEqual(['Jita', 'Amarr', 'Dodixie']);
  });

  it('returns nothing for empty or system-free text', () => {
    expect(names('')).toEqual([]);
    expect(names('Просто текст без названий систем.')).toEqual([]);
  });
});
