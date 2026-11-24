/**
 * Test: the dashboard says when the next scan runs (discussion #363)
 *
 * Covers:
 * 1. scanHealthService / the scanner snapshot: `nextRunAt` comes from the armed
 *    cron task and is null when automatic processing is off or the scheduler
 *    is not armed — including against a real node-cron task
 * 2. server.js handing the real task to markArmed()
 * 3. The shipped browser helpers in public/js/modules/scan-schedule.js: the
 *    schedule in words, the countdown, the clock time and every card state
 * 4. The card markup and the dashboard module's tick lifecycle
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`✅  ${name}`);
    passed++;
  } catch (error) {
    console.error(`❌  ${name}`);
    console.error(`    ${error.message}`);
    failed++;
  }
}

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

(async () => {
  // ────────────────────────────────────────────────────────────────────────
  // 1. Server state
  // ────────────────────────────────────────────────────────────────────────

  const health = require('../services/scanHealthService');
  const scanControl = require('../services/scanControl');
  const {
    buildScannerHealthSnapshot,
  } = require('../services/scannerHealthSnapshot');

  const NEXT = new Date('2026-11-18T14:45:00.000Z');

  await test('An armed scheduler reports the next run its task names', () => {
    health.reset();
    health.markArmed('*/5 * * * *', () => NEXT);

    assert.strictEqual(health.getState().nextRunAt, NEXT.toISOString());
    const snapshot = buildScannerHealthSnapshot();
    assert.strictEqual(snapshot.scanner.nextRunAt, NEXT.toISOString());
    assert.strictEqual(snapshot.scanner.scanInterval, '*/5 * * * *');
  });

  await test('The next run is asked of the task on every snapshot, never cached', () => {
    health.reset();
    let next = new Date('2026-11-18T14:45:00.000Z');
    health.markArmed('*/5 * * * *', () => next);
    assert.strictEqual(
      buildScannerHealthSnapshot().scanner.nextRunAt,
      '2026-11-18T14:45:00.000Z'
    );
    next = new Date('2026-11-18T14:50:00.000Z');
    assert.strictEqual(
      buildScannerHealthSnapshot().scanner.nextRunAt,
      '2026-11-18T14:50:00.000Z'
    );
  });

  await test('Automatic processing off has no next run', () => {
    health.reset();
    health.markArmed('*/5 * * * *', () => NEXT);
    health.markAutomaticProcessingDisabled();

    const snapshot = buildScannerHealthSnapshot();
    assert.strictEqual(snapshot.scanner.automaticProcessingEnabled, false);
    assert.strictEqual(snapshot.scanner.nextRunAt, null);
  });

  await test('A scheduler that is not armed has no next run', () => {
    health.reset();
    const snapshot = buildScannerHealthSnapshot();
    assert.strictEqual(snapshot.scanner.armed, false);
    assert.strictEqual(
      snapshot.scanner.nextRunAt,
      null,
      'An unarmed scheduler must not show an invented time'
    );
  });

  await test('Arming without a provider reports no next run instead of guessing', () => {
    health.reset();
    health.markArmed('*/5 * * * *');
    assert.strictEqual(health.getState().nextRunAt, null);
  });

  await test('A provider that fails or answers nonsense yields null, never a throw', () => {
    health.reset();
    health.markArmed('*/5 * * * *', () => {
      throw new Error('boom');
    });
    assert.strictEqual(health.getState().nextRunAt, null);

    health.markArmed('*/5 * * * *', () => null);
    assert.strictEqual(health.getState().nextRunAt, null);

    health.markArmed('*/5 * * * *', () => new Date('not a date'));
    assert.strictEqual(health.getState().nextRunAt, null);
  });

  await test('getState() carries no function into a payload', () => {
    health.reset();
    health.markArmed('*/5 * * * *', () => NEXT);
    const state = health.getState();
    for (const [key, value] of Object.entries(state)) {
      assert.notStrictEqual(typeof value, 'function', `${key} is a function`);
    }
    assert.doesNotThrow(() => JSON.stringify(buildScannerHealthSnapshot()));
  });

  await test('reset() forgets the provider', () => {
    health.markArmed('*/5 * * * *', () => NEXT);
    health.reset();
    health.state.armed = true;
    assert.strictEqual(health.getState().nextRunAt, null);
    health.reset();
  });

  await test('A snapshot from a state without the field still says null', () => {
    const originalHealth = health.getState;
    const originalControl = scanControl.getState;
    health.getState = () => ({ paperless: {} });
    scanControl.getState = () => ({ running: false });
    try {
      assert.strictEqual(buildScannerHealthSnapshot().scanner.nextRunAt, null);
    } finally {
      health.getState = originalHealth;
      scanControl.getState = originalControl;
    }
  });

  await test('A real node-cron task hands over its next run, and none once stopped', async () => {
    const cron = require('node-cron');
    const task = cron.schedule('*/5 * * * *', () => {});
    try {
      health.reset();
      health.markArmed('*/5 * * * *', () => task.getNextRun());

      const nextRunAt = health.getState().nextRunAt;
      assert.ok(nextRunAt, 'Expected a next run from the live task');
      const next = new Date(nextRunAt);
      const ahead = next.getTime() - Date.now();
      assert.ok(ahead > 0 && ahead <= 5 * MINUTE, `next run ${ahead}ms away`);
      // node-cron reads the expression in local time.
      assert.strictEqual(next.getMinutes() % 5, 0);
      assert.strictEqual(next.getSeconds(), 0);

      await task.stop();
      assert.strictEqual(
        health.getState().nextRunAt,
        null,
        'A stopped task fires no more — no time to show'
      );
    } finally {
      await task.destroy();
      health.reset();
    }
  });

  // ────────────────────────────────────────────────────────────────────────
  // 2. server.js wiring
  // ────────────────────────────────────────────────────────────────────────

  const serverSource = read('server.js');

  await test('server.js hands the scan task itself to markArmed()', () => {
    assert.match(
      serverSource,
      /const scanTask = cron\.schedule\(config\.scanInterval,/,
      'The scan task has to be kept to be asked for its next run'
    );
    assert.match(
      serverSource,
      /scanHealthService\.markArmed\(config\.scanInterval, \(\) =>\s*scanTask\.getNextRun\(\)\s*\)/,
      'The next run must come from the real task, not a second parser'
    );
  });

  // ────────────────────────────────────────────────────────────────────────
  // 3. Browser helpers (the shipped module)
  // ────────────────────────────────────────────────────────────────────────

  const schedule = await import(
    path.join(root, 'public', 'js', 'modules', 'scan-schedule.js')
  );
  const {
    describeSchedule,
    formatCountdown,
    formatClockTime,
    describeScanSchedule,
  } = schedule;

  await test('Common cron shapes read as words', () => {
    const cases = [
      ['*/5 * * * *', 'Every 5 minutes'],
      ['*/30 * * * *', 'Every 30 minutes'],
      ['*/1 * * * *', 'Every minute'],
      ['* * * * *', 'Every minute'],
      ['0 * * * *', 'Every hour'],
      ['15 * * * *', 'Every hour at :15'],
      ['0 */2 * * *', 'Every 2 hours'],
      ['30 */6 * * *', 'Every 6 hours at :30'],
      ['0 */1 * * *', 'Every hour'],
      ['0 2 * * *', 'Daily at 02:00'],
      ['30 14 * * *', 'Daily at 14:30'],
      ['0 0 * * *', 'Daily at 00:00'],
      ['  */10   *  * * *  ', 'Every 10 minutes'],
      ['0 */5 * * * *', 'Every 5 minutes'],
    ];
    for (const [expression, words] of cases) {
      assert.strictEqual(describeSchedule(expression), words, expression);
    }
  });

  await test('Anything else falls back to the raw expression', () => {
    for (const expression of [
      '0 9 * * 1-5',
      '0 0 1 * *',
      '*/15 8-18 * * *',
      '0 8,12,18 * * *',
      '5-10 * * * *',
      '*/30 * * * * *',
      '*/0 * * * *',
      '*/90 * * * *',
      '61 * * * *',
      '0 25 * * *',
      '@hourly',
      'nonsense',
    ]) {
      assert.strictEqual(
        describeSchedule(expression),
        expression.trim(),
        expression
      );
    }
    assert.strictEqual(describeSchedule(''), '');
    assert.strictEqual(describeSchedule(null), '');
  });

  await test("Named times follow the next run in the viewer's time zone", () => {
    // The server reads the expression in its own zone. A container on UTC with
    // "0 2 * * *" fires at 03:00 for a viewer in Berlin, and the words must say
    // the same as the next-scan line beside them.
    const nextRunAt = new Date(2026, 10, 19, 3, 0, 0);
    assert.strictEqual(
      describeSchedule('0 2 * * *', { nextRunAt }),
      'Daily at 03:00'
    );
    assert.strictEqual(
      describeSchedule('0 * * * *', {
        nextRunAt: new Date(2026, 10, 19, 3, 30, 0),
      }),
      'Every hour at :30'
    );
    assert.strictEqual(
      describeSchedule('*/5 * * * *', { nextRunAt }),
      'Every 5 minutes'
    );
    assert.strictEqual(
      describeSchedule('0 2 * * *', { nextRunAt: 'garbage' }),
      'Daily at 02:00',
      'An unreadable next run falls back to the expression'
    );
  });

  await test('The countdown never shows zero or a negative value', () => {
    assert.strictEqual(formatCountdown(0), 'due now');
    assert.strictEqual(formatCountdown(-1), 'due now');
    assert.strictEqual(formatCountdown(-5 * MINUTE), 'due now');
    assert.strictEqual(formatCountdown(NaN), 'due now');
    assert.strictEqual(formatCountdown(undefined), 'due now');
    assert.strictEqual(formatCountdown(1), 'in 1s', 'the last second is 1s');
    assert.strictEqual(formatCountdown(400), 'in 1s');
    assert.strictEqual(formatCountdown(SECOND), 'in 1s');
    assert.strictEqual(formatCountdown(SECOND + 1), 'in 2s');
  });

  await test('The countdown reads in seconds, minutes, hours and days', () => {
    assert.strictEqual(formatCountdown(37 * SECOND), 'in 37s');
    assert.strictEqual(formatCountdown(59 * SECOND), 'in 59s');
    assert.strictEqual(formatCountdown(MINUTE), 'in 1m 00s');
    assert.strictEqual(formatCountdown(2 * MINUTE + 37 * SECOND), 'in 2m 37s');
    assert.strictEqual(formatCountdown(2 * MINUTE + 7 * SECOND), 'in 2m 07s');
    assert.strictEqual(formatCountdown(HOUR - SECOND), 'in 59m 59s');
    assert.strictEqual(formatCountdown(HOUR), 'in 1h 00m');
    assert.strictEqual(
      formatCountdown(HOUR + 5 * MINUTE + 59 * SECOND),
      'in 1h 05m'
    );
    assert.strictEqual(formatCountdown(23 * HOUR + 59 * MINUTE), 'in 23h 59m');
    assert.strictEqual(formatCountdown(24 * HOUR), 'in 1d 0h');
    assert.strictEqual(formatCountdown(51 * HOUR), 'in 2d 3h');
  });

  await test('The clock time names the day when it is not today', () => {
    const now = new Date(2026, 10, 18, 14, 42, 23).getTime();
    assert.strictEqual(
      formatClockTime(new Date(2026, 10, 18, 14, 45), { now }),
      '14:45'
    );
    assert.strictEqual(
      formatClockTime(new Date(2026, 10, 18, 9, 5), { now }),
      '09:05'
    );
    assert.strictEqual(
      formatClockTime(new Date(2026, 10, 19, 2, 0), { now }),
      'tomorrow 02:00'
    );
    assert.strictEqual(
      formatClockTime(new Date(2026, 11, 1, 0, 0), { now }),
      '2026-12-01 00:00'
    );
    assert.strictEqual(
      formatClockTime(new Date(2026, 11, 1, 0, 0), {
        now,
        formatDay: () => '01.12.2026',
      }),
      '01.12.2026 00:00'
    );
    // Across the year boundary "tomorrow" still means the next calendar day.
    assert.strictEqual(
      formatClockTime(new Date(2027, 0, 1, 0, 0), {
        now: new Date(2026, 11, 31, 23, 58).getTime(),
      }),
      'tomorrow 00:00'
    );
    assert.strictEqual(formatClockTime(null, { now }), '');
    assert.strictEqual(formatClockTime('garbage', { now }), '');
  });

  // The card states, as the brief lists them.
  const now = new Date(2026, 10, 18, 14, 42, 23).getTime();
  const armedScanner = (overrides = {}) => ({
    automaticProcessingEnabled: true,
    armed: true,
    running: false,
    scanInterval: '*/5 * * * *',
    lastRunFinishedAt: new Date(now - 3 * MINUTE).toISOString(),
    lastRunStatus: 'ok',
    nextRunAt: new Date(2026, 10, 18, 14, 45, 0).toISOString(),
    ...overrides,
  });

  await test('Idle with a next run: clock time, countdown, schedule in words', () => {
    const view = describeScanSchedule(
      { isScanning: false, scanner: armedScanner() },
      { now }
    );
    assert.strictEqual(view.last, '3 minutes ago');
    assert.strictEqual(view.next, '14:45 · in 2m 37s');
    assert.strictEqual(view.schedule, 'Every 5 minutes');
    assert.strictEqual(view.scheduleTitle, '*/5 * * * *');
    assert.strictEqual(view.counting, true);
  });

  await test('A running scan is said, not counted down', () => {
    for (const data of [
      { isScanning: true, scanner: armedScanner() },
      { isScanning: false, scanner: armedScanner({ running: true }) },
    ]) {
      const view = describeScanSchedule(data, { now });
      assert.strictEqual(view.next, 'Scanning now');
      assert.strictEqual(view.counting, false);
      assert.strictEqual(view.schedule, 'Every 5 minutes');
    }
  });

  await test('Automatic scanning off shows no next time', () => {
    const view = describeScanSchedule(
      {
        scanner: {
          automaticProcessingEnabled: false,
          armed: false,
          running: false,
          scanInterval: null,
          lastRunFinishedAt: null,
          nextRunAt: null,
        },
      },
      { now }
    );
    assert.strictEqual(view.next, 'Not scheduled');
    assert.strictEqual(view.schedule, 'Automatic scanning is off');
    assert.strictEqual(view.counting, false);
    assert.doesNotMatch(view.next, /\d/, 'no invented time');
  });

  await test('An unarmed scheduler shows no invented time', () => {
    const view = describeScanSchedule(
      {
        scanner: armedScanner({
          armed: false,
          scanInterval: null,
          // Even a stray value must not be shown while nothing is armed.
          nextRunAt: new Date(now + MINUTE).toISOString(),
        }),
      },
      { now }
    );
    assert.strictEqual(view.next, 'Not scheduled');
    assert.strictEqual(view.schedule, 'Scheduler not running');
    assert.strictEqual(view.counting, false);
  });

  await test('Armed without a known next run says so instead of counting', () => {
    const view = describeScanSchedule(
      { scanner: armedScanner({ nextRunAt: null }) },
      { now }
    );
    assert.strictEqual(view.next, 'Not scheduled');
    assert.strictEqual(view.schedule, 'Every 5 minutes');
    assert.strictEqual(view.counting, false);
  });

  await test('Never scanned says "No scan yet"', () => {
    const view = describeScanSchedule(
      {
        scanner: armedScanner({ lastRunFinishedAt: null, lastRunStatus: null }),
      },
      { now }
    );
    assert.strictEqual(view.last, 'No scan yet');
    assert.strictEqual(view.counting, true);
  });

  await test('A failed last run does not look like a good one', () => {
    const view = describeScanSchedule(
      { scanner: armedScanner({ lastRunStatus: 'paperless_unreachable' }) },
      { now }
    );
    assert.strictEqual(view.last, '3 minutes ago (failed)');
  });

  await test('A passed next run is due until the next poll corrects it', () => {
    const view = describeScanSchedule(
      { scanner: armedScanner() },
      { now: new Date(2026, 10, 18, 14, 45, 2).getTime() }
    );
    assert.strictEqual(view.next, '14:45 · due now');
    assert.doesNotMatch(view.next, /-/);
  });

  await test('An unusual expression is shown raw, with no duplicate title', () => {
    const view = describeScanSchedule(
      { scanner: armedScanner({ scanInterval: '0 9 * * 1-5' }) },
      { now }
    );
    assert.strictEqual(view.schedule, '0 9 * * 1-5');
    assert.strictEqual(view.scheduleTitle, '');
  });

  await test('A payload without the scanner block shows dashes, not a crash', () => {
    for (const data of [{}, null, undefined]) {
      const view = describeScanSchedule(data, { now });
      assert.deepStrictEqual(
        [view.last, view.next, view.schedule, view.counting],
        ['—', '—', '—', false]
      );
    }
  });

  // ────────────────────────────────────────────────────────────────────────
  // 4. Markup and module lifecycle
  // ────────────────────────────────────────────────────────────────────────

  const card = read('views', 'partials', 'widgets', 'task-runner.ejs');
  const dashboardSource = read('public', 'js', 'modules', 'dashboard.js');

  await test('The Task runner card carries the three scan lines', () => {
    for (const id of [
      'scanClock',
      'scanLastRun',
      'scanNextRun',
      'scanSchedule',
    ]) {
      assert.ok(card.includes(`id="${id}"`), `#${id} missing`);
    }
    for (const label of ['Last scan', 'Next scan', 'Schedule']) {
      assert.ok(card.includes(`>${label}<`), `label "${label}" missing`);
    }
    // The donut and its legend stay in Processing status.
    const status = read(
      'views',
      'partials',
      'widgets',
      'processing-status.ejs'
    );
    assert.ok(status.includes('id="processingDonut"'));
    assert.ok(status.includes('id="processingLegend"'));
  });

  await test('The countdown is not a live region', () => {
    assert.doesNotMatch(
      card,
      /aria-live|role="(status|alert|timer)"/,
      'A ticking countdown in a live region is announced every second'
    );
  });

  await test('The dashboard ticks from the last poll and stops its timer', () => {
    assert.ok(
      dashboardSource.includes(
        "import { describeScanSchedule } from './scan-schedule.js';"
      )
    );
    assert.ok(dashboardSource.includes('updateScanClock(data);'));
    assert.match(
      dashboardSource,
      /addEventListener\('visibilitychange', onVisibilityChange\)/,
      'A hidden tab must stop the tick'
    );
    const destroy = dashboardSource.slice(
      dashboardSource.indexOf('destroy() {')
    );
    assert.ok(
      destroy.includes('syncScanTick(false);'),
      'destroy() stops the tick'
    );
    assert.ok(
      destroy.includes(
        "removeEventListener('visibilitychange', onVisibilityChange)"
      ),
      'destroy() removes the visibility listener'
    );
    assert.ok(
      !/setInterval\([^)]*fetch/.test(dashboardSource),
      'The tick must not fetch'
    );
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
})();
