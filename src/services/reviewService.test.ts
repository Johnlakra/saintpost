import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toManifest, withManifest, ScriptStage } from '../engine/pipeline.js';
import { reviewService, Review } from './reviewService.js';
import { editService } from './editService.js';
import { LENGTHS } from '../config/lengths.js';
import type { GeneratedContent } from './llmService.js';

const stage = (): ScriptStage => ({
  saint: { name: 'St. Test', feast_month: 1, feast_day: 1 } as ScriptStage['saint'],
  lang: 'hi', preset: LENGTHS.standard, wantRoman: false, dossier: null, brief: null,
  content: {
    caption: 'cap', hashtags: '#a',
    video_script: [1, 2, 3].map(n => ({ scene_number: n, duration: 5, visual: `v${n}`, voiceover: `V${n}`, text_overlay: `T${n}`, image_prompt: `P${n}`, safe_prompt: `S${n}`, must_include: [`m${n}`], risk: 'low' as const, uses_main: true })),
  } as unknown as GeneratedContent,
});

test('approved script edits are written back into what the pipeline builds from', async () => {
  const s = stage();
  const m = toManifest(s);
  const draft = { projectId: 0, videoUrl: '', coverUrl: '', manifest: m, assets: { scenes: [], audios: [], aiClips: {} }, dirtyImg: new Set<number>(), dirtyAud: new Set<number>(), instructions: new Map(), editInPlace: new Set<number>(), freshPrompt: new Set<number>(), needsRender: false, summary: [] };
  await editService.applyScriptChanges(draft, [
    { kind: 'scene', idx: 0, field: 'narration', value: 'New narration' },
    { kind: 'scene', idx: 1, field: 'prompt', value: 'New prompt' },
    { kind: 'scene', idx: 2, field: 'title', value: '' },
    { kind: 'caption', value: 'New caption' },
  ]);
  const out = withManifest(s, draft.manifest);
  const [a, b, c] = out.content.video_script;
  assert.equal(a.voiceover, 'New narration');
  assert.equal(b.image_prompt, 'New prompt');
  assert.equal(b.safe_prompt, undefined);
  assert.deepEqual(b.must_include, []);
  assert.equal(c.text_overlay, '');
  assert.equal(out.content.caption, 'New caption');
  assert.equal(a.visual, 'v1'); // fields the admin does not edit are kept
  assert.equal(s.content.video_script[0].voiceover, 'V1'); // the original stage is not modified
});

test('the video cannot be built before the pictures exist, or while changed pictures are not redrawn', async () => {
  const s = stage();
  const r: Review = { phase: 'script', draft: { projectId: 0, videoUrl: '', coverUrl: '', manifest: toManifest(s), assets: { scenes: [], audios: [], aiClips: {} }, dirtyImg: new Set(), dirtyAud: new Set(), instructions: new Map(), editInPlace: new Set(), freshPrompt: new Set(), needsRender: false, summary: [] }, stage: s, dateMode: false, length: 'standard', working: false };
  await assert.rejects(reviewService.build(r, () => {}), /not been painted/);
  r.pictures = { ...s, cover: { localPath: '', url: '' }, scenes: [], characterSheetUrl: '', report: { reused: [], byProvider: {}, qa: { checked: 0, retried: 0, flagged: [] } } };
  editService.setPicturePrompt(r.draft, 1, 'changed');
  await assert.rejects(reviewService.build(r, () => {}), /not redrawn/);
});
