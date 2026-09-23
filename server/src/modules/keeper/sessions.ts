// When session-restricted markets close, in New York time (DST from the IANA database via Intl):
//   nyse  US stocks and ETFs: NYSE regular hours end 16:00, 13:00 on early-close days; closed weekends and holidays.
//   fx    forex: the week ends Friday 17:00.
// NYSE holidays and early closes as published on nyse.com for 2026–2027; later dates are not covered (see `covers`).
export type Schedule = 'nyse' | 'fx';

const NYSE_HOLIDAYS = new Set([
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
]);
const NYSE_EARLY_CLOSES = new Set(['2026-11-27', '2026-12-24', '2027-11-26']);
const NYSE_LAST_COVERED = '2027-12-31';

const NY = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
});

/** New York wall-clock fields of an instant. */
function nyFields(at: number) {
  const f = Object.fromEntries(NY.formatToParts(at).map((p) => [p.type, Number(p.value)]));
  return { year: f.year!, month: f.month!, day: f.day!, hour: f.hour!, minute: f.minute! };
}

/** The instant a New York wall-clock time happens. */
export function newYorkTime(year: number, month: number, day: number, hour: number, minute = 0): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const offset = (at: number) => {
    const f = nyFields(at);
    return Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute) - Math.floor(at / 60_000) * 60_000;
  };
  const guess = wall - offset(wall);
  return wall - offset(guess); // second pass: the offset at the answer itself, right across a DST change
}

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

/** False once `at` is past the NYSE dates this calendar knows. */
export const covers = (at: number) => {
  const f = nyFields(at);
  return isoDate(new Date(Date.UTC(f.year, f.month - 1, f.day))) <= NYSE_LAST_COVERED;
};

/** The first session close after `now` (unix ms), or null when the NYSE calendar does not reach it. */
export function nextSessionClose(schedule: Schedule, now: number): number | null {
  const today = nyFields(now);
  for (let i = 0; i < 14; i++) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + i));
    const [y, m, d, weekday] = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCDay()];
    let close: number;
    if (schedule === 'fx') {
      if (weekday !== 5) continue;
      close = newYorkTime(y, m, d, 17);
    } else {
      const iso = isoDate(date);
      if (iso > NYSE_LAST_COVERED) return null;
      if (weekday === 0 || weekday === 6 || NYSE_HOLIDAYS.has(iso)) continue;
      close = newYorkTime(y, m, d, NYSE_EARLY_CLOSES.has(iso) ? 13 : 16);
    }
    if (close > now) return close;
  }
  return null;
}
