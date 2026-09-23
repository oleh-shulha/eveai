import { describe, expect, it } from 'vitest';
import {
  buildTurnCompletionNudge,
  createTurnGoalLedger,
  pendingTurnOutcomes,
  recordTurnToolOutcome,
} from '../../src/agent/turn-goals.js';

describe('turn outcome ledger', () => {
  it('keeps route, autopilot, and monitor independently pending', () => {
    const ledger = createTurnGoalLedger('Построй маршрут до Jita, включи автопилот и онлайн-скан');
    expect(pendingTurnOutcomes(ledger)).toEqual(['route', 'autopilot', 'route_monitor']);

    recordTurnToolOutcome(ledger, 'plan_route', { set_autopilot: false }, {
      ok: true,
      autopilot_set: false,
      monitor_started: false,
    });
    expect(pendingTurnOutcomes(ledger)).toEqual(['autopilot', 'route_monitor']);
  });

  it('settles every route outcome only from an explicit successful mutation', () => {
    const ledger = createTurnGoalLedger('Build a route, enable autopilot, and online scan');
    recordTurnToolOutcome(ledger, 'plan_route', { set_autopilot: true }, {
      ok: true,
      autopilot_set: true,
      monitor_started: true,
    });
    expect(pendingTurnOutcomes(ledger)).toEqual([]);
  });

  it('emits a bounded correction without hidden reasoning language', () => {
    const text = buildTurnCompletionNudge(['autopilot', 'route_monitor']);
    expect(text).toContain('autopilot, route_monitor');
    expect(text).not.toMatch(/chain.of.thought|reasoning trace/i);
  });

  it('requires two attempted public reads for explicit two-target requests', () => {
    const ledger = createTurnGoalLedger('Покажи рыночную историю PLEX и Tritanium');
    expect(pendingTurnOutcomes(ledger)).toEqual(['multi_public_read']);
    recordTurnToolOutcome(ledger, 'market_history_summary', {}, { ok: true });
    expect(pendingTurnOutcomes(ledger)).toEqual(['multi_public_read']);
    recordTurnToolOutcome(ledger, 'market_history_summary', {}, { ok: false, error: 'unavailable' });
    expect(pendingTurnOutcomes(ledger)).toEqual(['multi_public_read']);
  });

  it('accepts one bounded batch that attempted both requested reads', () => {
    const ledger = createTurnGoalLedger('Сравни количество систем в The Forge и Domain');
    recordTurnToolOutcome(ledger, 'local_parallel_batch', {}, {
      results: [
        { output: { ok: true } },
        { output: { ok: true } },
      ],
    });
    expect(pendingTurnOutcomes(ledger)).toEqual([]);
  });

  it('keeps a failed delegated sibling pending for bounded failure reporting', () => {
    const ledger = createTurnGoalLedger('Сравни количество систем в The Forge и Domain');
    recordTurnToolOutcome(ledger, 'delegate_read_subagents', {}, {
      results: [{ status: 'completed' }, { status: 'failed' }],
    });
    expect(pendingTurnOutcomes(ledger)).toEqual(['multi_public_read']);
  });

  it.each([
    'Посчитай станции в Jita и Amarr',
    'Сравни количество лун в двух системах Jita и Amarr',
    'Покажи текущие цены PLEX и Tritanium',
  ])('detects an explicit multi-target public request: %s', (goal) => {
    expect(pendingTurnOutcomes(createTurnGoalLedger(goal))).toContain('multi_public_read');
  });

  it('lets one multi-item market facade satisfy two price targets', () => {
    const ledger = createTurnGoalLedger('Покажи текущие цены PLEX и Tritanium');
    recordTurnToolOutcome(ledger, 'batch_market_prices', {}, {
      ok: true,
      prices: [{ type_id: 1, error: null }, { type_id: 2, error: null }],
    });
    expect(pendingTurnOutcomes(ledger)).toEqual([]);
  });

  it('counts the whole-market read the question actually calls for', () => {
    // The regression this file exists for: market_wide_summary returns its
    // regions under `regions`, was in no counted list, and scored zero — so a
    // finished priced answer was sent back to the model for more work.
    const ledger = createTurnGoalLedger('Поищи регионы недалеко от Житы где хороший объём продаж и цена лучше');
    expect(pendingTurnOutcomes(ledger)).toEqual(['multi_public_read']);

    recordTurnToolOutcome(ledger, 'market_wide_summary', {}, {
      ok: true,
      type_id: 4246,
      regions: [{ region_id: 10000002 }, { region_id: 10000043 }],
    });

    expect(pendingTurnOutcomes(ledger)).toEqual([]);
  });

  it('counts a read the ledger has never heard of', () => {
    const ledger = createTurnGoalLedger('Покажи текущие цены PLEX и Tritanium');

    recordTurnToolOutcome(ledger, 'some_future_public_facade', {}, {
      ok: true,
      entries: [{ id: 1 }, { id: 2 }],
    });

    expect(pendingTurnOutcomes(ledger)).toEqual([]);
  });

  it('still refuses to count mutations, failures, and bookkeeping as reads', () => {
    const ledger = createTurnGoalLedger('Покажи текущие цены PLEX и Tritanium');

    recordTurnToolOutcome(ledger, 'plan_route', {}, { ok: true, routes: [{ jumps: 3 }, { jumps: 4 }] });
    recordTurnToolOutcome(ledger, 'update_plan', {}, { ok: true, steps: [{ id: 1 }, { id: 2 }] });
    recordTurnToolOutcome(ledger, 'get_eve_capabilities', {}, { ok: true, scopes: ['a', 'b'] });
    recordTurnToolOutcome(ledger, 'intel_note', {}, { ok: true, notes: [{ id: 1 }, { id: 2 }] });
    recordTurnToolOutcome(ledger, 'sde_sql', {}, { ok: false, error: 'bad sql' });

    expect(pendingTurnOutcomes(ledger)).toEqual(['multi_public_read']);
  });

  it('treats a single-value read as one attempt, not two', () => {
    const ledger = createTurnGoalLedger('Покажи текущие цены PLEX и Tritanium');

    recordTurnToolOutcome(ledger, 'market_type_info', {}, { ok: true, type_id: 34, price: 5 });

    expect(pendingTurnOutcomes(ledger)).toEqual(['multi_public_read']);
  });

  it('does not count a price batch whose entries all failed', () => {
    const ledger = createTurnGoalLedger('Покажи текущие цены PLEX и Tritanium');

    recordTurnToolOutcome(ledger, 'batch_market_prices', {}, {
      ok: true,
      prices: [{ type_id: 1, error: 'no data' }, { type_id: 2, error: 'no data' }],
    });

    expect(pendingTurnOutcomes(ledger)).toEqual(['multi_public_read']);
  });

  it.each([
    'Не используй private ESI, route, UI или writes',
    'Маршрут не нужен и не включай автопилот',
    "Do not build a route and don't enable autopilot or online scan",
  ])('does not convert an explicit prohibition into a required mutation: %s', (goal) => {
    expect(pendingTurnOutcomes(createTurnGoalLedger(goal))).toEqual([]);
  });

  it('keeps positive route authorization when later text forbids other actions', () => {
    const ledger = createTurnGoalLedger(
      'Построй маршрут, включи автопилот и онлайн-скан. Не выполняй другие игровые действия.',
    );
    expect(pendingTurnOutcomes(ledger)).toEqual(['route', 'autopilot', 'route_monitor']);
  });

  it.each([
    ['Не включай автопилот, но построй маршрут', ['route']],
    ["Don't enable autopilot, but build a route", ['route']],
    ['Не строй маршрут, однако включи автопилот', ['autopilot']],
    ['Do not build a route; however, enable autopilot', ['autopilot']],
  ])('scopes negation to its contrast clause: %s', (goal, expected) => {
    expect(pendingTurnOutcomes(createTurnGoalLedger(goal))).toEqual(expected);
  });
});
