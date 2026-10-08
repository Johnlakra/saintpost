import type { Manifest } from '../services/projectService.js';

/**
 * The editable text form of a video script. The admin gets it (as messages and a .txt file), edits any scenes,
 * and sends it back; only fields whose text really changed are applied, so untouched scenes cost nothing.
 *
 *   [Scene 2/9]
 *   Title: The call
 *   Narration: ...
 *   Picture prompt: ...
 *
 *   [Caption]
 *   ...
 */
const CHUNK_SIZE = 3800; // margin under Telegram's 4096-character message limit

export type ScriptField = 'title' | 'narration' | 'prompt';
export type ScriptChange =
  | { kind: 'scene'; idx: number; field: ScriptField; value: string }
  | { kind: 'caption'; value: string };

const FIELD_LABEL: Record<ScriptField, string> = { title: 'Title', narration: 'Narration', prompt: 'Picture prompt' };
const FIELD_ALIASES: Record<string, ScriptField> = {
  title: 'title', overlay: 'title',
  narration: 'narration', voiceover: 'narration', transcript: 'narration',
  'picture prompt': 'prompt', picture: 'prompt', prompt: 'prompt', 'image prompt': 'prompt',
};
const HEADER_RE = /^\s*\[\s*(?:scene\s*(\d+)\s*(?:\/\s*(\d+))?|(caption))\s*\]\s*$/i;
const FIELD_RE = new RegExp(`^\\s*(${Object.keys(FIELD_ALIASES).sort((a, b) => b.length - a.length).join('|')})\\s*:\\s?(.*)$`, 'i');

/** True when the text opens with a [Scene N] / [Caption] line (a pasted block, not a split-off tail of one). */
export const startsWithBlock = (text: string) => HEADER_RE.test(text.trimStart().split(/\r?\n/)[0] ?? '');

export const picturePrompt = (s: Manifest['scenes'][number]) => s.image_prompt || s.visual;
const oneLine = (t: string) => t.replace(/\s+/g, ' ').trim();

export function formatScene(m: Manifest, i: number): string {
  const s = m.scenes[i];
  return [
    `[Scene ${i + 1}/${m.scenes.length}]`,
    `${FIELD_LABEL.title}: ${s.overlay || '-'}`,
    `${FIELD_LABEL.narration}: ${s.voiceover}`,
    `${FIELD_LABEL.prompt}: ${picturePrompt(s)}`,
  ].join('\n');
}

export const formatCaption = (m: Manifest) => `[Caption]\n${m.caption}`;

/** One block per scene plus the caption, in order. */
export const scriptBlocks = (m: Manifest): string[] => [...m.scenes.map((_, i) => formatScene(m, i)), formatCaption(m)];

/** Packs blocks into as few messages as possible; a block longer than one message is split on line/word boundaries. */
export function chunkBlocks(blocks: string[], max = CHUNK_SIZE): string[] {
  const pieces = blocks.flatMap(b => (b.length <= max ? [b] : splitLong(b, max)));
  return pieces.reduce<string[]>((out, p) => {
    const last = out[out.length - 1];
    return last !== undefined && last.length + 2 + p.length <= max ? [...out.slice(0, -1), `${last}\n\n${p}`] : [...out, p];
  }, []);
}

function splitLong(text: string, max: number): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const cut = Math.max(window.lastIndexOf('\n'), window.lastIndexOf(' '));
    const at = cut > max / 2 ? cut : max;
    parts.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  return rest ? [...parts, rest] : parts;
}

interface ParsedBlock { scene?: number; total?: number; caption: boolean; fields: Partial<Record<ScriptField, string>>; captionText: string }

function parseBlocks(text: string): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  let cur: ParsedBlock | null = null;
  let field: ScriptField | null = null;
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const h = HEADER_RE.exec(line);
    if (h) {
      cur = { scene: h[1] ? +h[1] : undefined, total: h[2] ? +h[2] : undefined, caption: !!h[3], fields: {}, captionText: '' };
      blocks.push(cur);
      field = null;
      continue;
    }
    if (!cur) continue; // anything before the first [Scene]/[Caption] header is instructions
    if (cur.caption) { cur.captionText += `${line}\n`; continue; }
    const f = FIELD_RE.exec(line);
    if (f) {
      field = FIELD_ALIASES[f[1].toLowerCase()];
      cur.fields = { ...cur.fields, [field]: f[2] };
    } else if (field) {
      cur.fields = { ...cur.fields, [field]: `${cur.fields[field] ?? ''}\n${line}` };
    }
  }
  return blocks;
}

/**
 * Compares an edited script with the current one. Returns ONLY real changes (whitespace differences are ignored),
 * or errors when the text cannot be applied safely. Scenes/fields left out of the text are left unchanged.
 */
export function diffScript(m: Manifest, text: string): { changes: ScriptChange[]; errors: string[] } {
  const blocks = parseBlocks(text);
  if (!blocks.length) return { changes: [], errors: ['No [Scene N] or [Caption] blocks found. Copy the script I sent, edit it and send it back.'] };
  const n = m.scenes.length;
  const errors: string[] = [];
  const changes: ScriptChange[] = [];
  const seen = new Set<string>();
  for (const b of blocks) {
    const key = b.caption ? 'caption' : `s${b.scene}`;
    if (seen.has(key)) { errors.push(`${b.caption ? '[Caption]' : `Scene ${b.scene}`} appears twice.`); continue; }
    seen.add(key);
    if (b.caption) {
      const value = b.captionText.trim();
      if (!value) errors.push('The caption is empty.');
      else if (value !== m.caption.trim()) changes.push({ kind: 'caption', value });
      continue;
    }
    const sceneNo = b.scene ?? 0;
    if (b.total !== undefined && b.total !== n) {
      errors.push(`Scene ${sceneNo}/${b.total}: this copy is from when the video had ${b.total} scenes; it now has ${n}. Tap 📋 again for a fresh copy.`);
      continue;
    }
    if (sceneNo < 1 || sceneNo > n) { errors.push(`Scene ${sceneNo} does not exist (the video has ${n} scenes).`); continue; }
    const idx = sceneNo - 1;
    const s = m.scenes[idx];
    const current: Record<ScriptField, string> = { title: s.overlay || '', narration: s.voiceover, prompt: picturePrompt(s) };
    for (const f of Object.keys(b.fields) as ScriptField[]) {
      const raw = oneLine(b.fields[f] ?? '');
      const value = f === 'title' && raw === '-' ? '' : raw;
      if (!value && f !== 'title') { errors.push(`Scene ${sceneNo}: ${FIELD_LABEL[f].toLowerCase()} is empty.`); continue; }
      if (value !== oneLine(current[f])) changes.push({ kind: 'scene', idx, field: f, value });
    }
  }
  return { changes, errors };
}

export const describeChange = (c: ScriptChange) =>
  c.kind === 'caption' ? 'Caption' : `Scene ${c.idx + 1}: ${FIELD_LABEL[c.field].toLowerCase()}`;
