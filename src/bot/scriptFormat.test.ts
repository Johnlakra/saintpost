import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkBlocks, diffScript, scriptBlocks, startsWithBlock } from './scriptFormat.js';
import type { Manifest } from '../services/projectService.js';

const manifest = (): Manifest => ({
  saint: { name: 'St. Test', feast_month: 1, feast_day: 1 },
  lang: 'en', length: 'standard', romanSubs: false, version: 1, hashtags: '#saint',
  caption: 'Line one\nLine two',
  scenes: [1, 2, 3].map(n => ({ voiceover: `Narration ${n}.`, overlay: `Title ${n}`, visual: `Visual ${n}`, image_prompt: `Prompt ${n} long text` })),
});
const fullText = (m: Manifest) => scriptBlocks(m).join('\n\n');

test('unedited full script produces no changes', () => {
  const m = manifest();
  assert.deepEqual(diffScript(m, fullText(m)), { changes: [], errors: [] });
});

test('only the edited fields of the edited scenes are reported', () => {
  const m = manifest();
  const edited = fullText(m).replace('Narration: Narration 2.', 'Narration: A new line\nthat wraps.').replace('Picture prompt: Prompt 3 long text', 'Picture prompt: A sunrise');
  assert.deepEqual(diffScript(m, edited), {
    errors: [],
    changes: [
      { kind: 'scene', idx: 1, field: 'narration', value: 'A new line that wraps.' },
      { kind: 'scene', idx: 2, field: 'prompt', value: 'A sunrise' },
    ],
  });
});

test('a partial paste with one scene leaves the others alone and whitespace is ignored', () => {
  const m = manifest();
  const { changes, errors } = diffScript(m, '[Scene 2/3]\nTitle:   Title 2  \nNarration: Narration 2.\n');
  assert.deepEqual(errors, []);
  assert.deepEqual(changes, []);
});

test('"-" removes a title and the caption keeps its line breaks', () => {
  const m = manifest();
  const { changes } = diffScript(m, '[Scene 1]\nTitle: -\n\n[Caption]\nNew one\nNew two\n');
  assert.deepEqual(changes, [{ kind: 'scene', idx: 0, field: 'title', value: '' }, { kind: 'caption', value: 'New one\nNew two' }]);
});

test('stale copy, missing scene, empty narration and duplicates are errors', () => {
  const m = manifest();
  assert.match(diffScript(m, '[Scene 1/4]\nTitle: x').errors[0], /now has 3/);
  assert.match(diffScript(m, '[Scene 9]\nTitle: x').errors[0], /does not exist/);
  assert.match(diffScript(m, '[Scene 1]\nNarration:   ').errors[0], /empty/);
  assert.match(diffScript(m, '[Scene 1]\nTitle: a\n[Scene 1]\nTitle: b').errors[0], /twice/);
  assert.match(diffScript(m, 'just some text').errors[0], /No \[Scene N\]/);
});

test('chunks stay under the limit without cutting a block that fits', () => {
  const blocks = ['a'.repeat(30), 'b'.repeat(30), 'c'.repeat(30)];
  assert.deepEqual(chunkBlocks(blocks, 70), [`${'a'.repeat(30)}\n\n${'b'.repeat(30)}`, 'c'.repeat(30)]);
  const long = chunkBlocks([Array.from({ length: 40 }, () => 'word').join(' ')], 50);
  assert.ok(long.length > 1 && long.every(c => c.length <= 50));
  assert.equal(long.join(' '), Array.from({ length: 40 }, () => 'word').join(' '));
});

test('detects whether a message opens with a block header', () => {
  assert.equal(startsWithBlock('  [Scene 3/9]\nTitle: x'), true);
  assert.equal(startsWithBlock('[caption]\nhello'), true);
  assert.equal(startsWithBlock('that wraps.\n[Scene 4/9]'), false);
});
