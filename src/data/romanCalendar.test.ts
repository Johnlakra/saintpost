import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shortName, pickCelebration, officialCelebration, likelySameCelebration } from './romanCalendar.js';
import { matchOfficialRow, officialAddsSomething } from './saintRows.js';
import { toSaintCheck } from '../services/saintVerifier.js';

const row = (name: string, feast_month: number, feast_day: number) => ({ name, feast_month, feast_day });
const official = (name: string, month: number, day: number) => ({ id: 'x', name, fullName: name, rank: 'Memorial' as const, color: 'White', fixedDate: { month, day } });

test('official names are shortened without losing co-saints', () => {
  assert.equal(shortName('Saint Robert Bellarmine, Bishop and Doctor of the Church'), 'St. Robert Bellarmine');
  assert.equal(shortName('Saints Pontian, Pope, and Hippolytus, Priest, Martyrs'), 'Sts. Pontian and Hippolytus');
  assert.equal(shortName('Saints Martha, Mary and Lazarus'), 'Sts. Martha, Mary and Lazarus');
  assert.equal(shortName('Saint Stephen, the First Martyr'), 'St. Stephen');
});

test('the day\'s celebration is the highest rank; weekdays and Sundays are not saints\' days', () => {
  assert.equal(pickCelebration([{ id: 'w', name: 'Thursday', rank: 'WEEKDAY' }]), null);
  const c = pickCelebration([
    { id: 'w', name: 'Thursday', rank: 'WEEKDAY' },
    { id: 'o', name: 'Saint A, Virgin', rank: 'OPTIONAL_MEMORIAL' },
    { id: 'f', name: 'Saint B, Apostle', rank: 'FEAST', colors: ['RED'] },
  ]);
  assert.deepEqual([c?.name, c?.rank, c?.color], ['St. B', 'Feast', 'Red']);
});

test('the General Roman Calendar gives the Church\'s celebration, also when a Sunday outranks it', async () => {
  assert.equal((await officialCelebration(new Date(2026, 7, 15)))?.rank, 'Solemnity'); // Assumption
  assert.equal((await officialCelebration(new Date(2026, 9, 4)))?.name, 'St. Francis of Assisi'); // a Sunday in 2026
  assert.equal(await officialCelebration(new Date(2026, 9, 8)), null); // ordinary weekday
});

test('a stored row is only reused for the same date, and keeps its clearer name', () => {
  // never another saint on another date
  assert.equal(matchOfficialRow(official('St. Joseph', 3, 19), [row('St. Joseph Cafasso', 6, 23)]), null);
  // same saint, clearer stored name: keep it
  assert.deepEqual(matchOfficialRow(official('St. Anthony', 1, 17), [row('St. Anthony the Abbot', 1, 17)])?.rename, false);
  assert.equal(likelySameCelebration('St. Thérèse of the Child Jesus', 'St. Thérèse of Lisieux'), true);
  assert.deepEqual(matchOfficialRow(official('St. Thérèse of the Child Jesus', 10, 1), [row('St. Thérèse of Lisieux', 10, 1)])?.rename, false);
  // the official celebration adds people or an event: use its name
  assert.equal(officialAddsSomething('Sts. Peter and Paul', 'St. Paul the Apostle'), true);
  assert.equal(officialAddsSomething('The Conversion of St. Paul the Apostle', 'St. Paul the Apostle'), true);
});

test('only canonized saints pass the name check', () => {
  assert.equal(toSaintCheck('Carlo Acutis', { status: 'saint', official_name: 'St. Carlo Acutis' }).accepted, true);
  assert.equal(toSaintCheck('Seraphim of Sarov', { status: 'not_recognized' }).accepted, false);
  assert.equal(toSaintCheck('x', { status: 'blessed' }).accepted, false);
  assert.equal(toSaintCheck('x', { status: 'something odd' }).status, 'not_recognized');
});
