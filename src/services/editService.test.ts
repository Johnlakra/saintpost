import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editService, Draft } from './editService.js';

const draft = (): Draft => ({
  projectId: 1, videoUrl: '', coverUrl: '',
  manifest: {
    saint: { name: 'St. Test', feast_month: 1, feast_day: 1 }, lang: 'en', length: 'standard', romanSubs: false, version: 1, hashtags: '', caption: 'c',
    scenes: [1, 2, 3, 4].map(n => ({ voiceover: `V${n}`, overlay: `T${n}`, visual: `v${n}`, image_prompt: `P${n}`, safe_prompt: 'old safe', must_include: ['old item'] })),
  },
  assets: { scenes: [], audios: [], aiClips: {} },
  dirtyImg: new Set(), dirtyAud: new Set(), instructions: new Map(), editInPlace: new Set(), freshPrompt: new Set(), needsRender: false, summary: [],
});

test('a new picture prompt redraws from scratch: no old-image edit, old fallback and checklist dropped', async () => {
  const d = draft();
  editService.redrawScene(d, 1, 'make it evening', true); // an in-place edit queued earlier
  await editService.applyScriptChanges(d, [{ kind: 'scene', idx: 1, field: 'prompt', value: 'A quiet chapel at dawn' }]);
  assert.deepEqual([...d.dirtyImg], [1]);
  assert.equal(d.editInPlace.has(1), false);
  assert.equal(d.instructions.has(1), false);
  assert.equal(d.manifest.scenes[1].image_prompt, 'A quiet chapel at dawn');
  assert.equal(d.manifest.scenes[1].safe_prompt, undefined);
  assert.deepEqual(d.manifest.scenes[1].must_include, []);
});

test('an in-place change requested after a new prompt still draws fresh from that prompt', async () => {
  const d = draft();
  await editService.applyScriptChanges(d, [{ kind: 'scene', idx: 2, field: 'prompt', value: 'A boat on a lake' }]);
  editService.redrawScene(d, 2, 'add a sunset', true);
  assert.equal(d.editInPlace.has(2), false);
  assert.equal(d.instructions.get(2), 'add a sunset');
});

test('fresh-prompt marks follow their scene when an earlier scene is deleted', async () => {
  const d = draft();
  await editService.applyScriptChanges(d, [{ kind: 'scene', idx: 3, field: 'prompt', value: 'New four' }]);
  editService.deleteScene(d, 0);
  assert.deepEqual([...d.freshPrompt], [2]);
});
