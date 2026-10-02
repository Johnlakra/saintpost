import fs from 'fs';
import os from 'os';
import path from 'path';
import { db } from '../db/index.js';
import { ffmpeg } from '../utils/media.js';

/**
 * A "project" is everything needed to rebuild a finished video WITHOUT paying for the AI again:
 * the script (manifest) and the expensive assets (scene pictures, cover, narration, AI motion clips).
 * Stored in Neon so it survives Render restarts. Editing one scene re-makes only that scene.
 */
export interface SceneState {
  voiceover: string;
  subtitle?: string; // Hinglish/Pinglish version when used
  overlay: string; // on-screen title
  visual: string;
  image_prompt?: string;
  safe_prompt?: string;
  must_include?: string[];
  risk?: 'low' | 'medium' | 'high';
  uses_main?: boolean;
}

export interface Manifest {
  saint: { name: string; feast_month: number; feast_day: number; appearance?: string; reference_image_url?: string };
  lang: 'hi' | 'pa' | 'en';
  length: string;
  romanSubs: boolean;
  scenes: SceneState[];
  caption: string;
  hashtags: string;
  version: number;
}

export interface ProjectAssets {
  cover?: Buffer;
  scenes: Array<Buffer | undefined>; // JPEG per scene
  audios: Array<Buffer | undefined>; // MP3 per scene
  aiClips: Record<number, Buffer>; // raw AI motion clip per scene index (optional)
}

const KEEP = () => Math.max(2, parseInt(process.env.PROJECTS_KEEP || '10', 10));
let ready = false;

export class ProjectService {
  private async ensure() {
    if (ready) return;
    await db.query(`CREATE TABLE IF NOT EXISTS projects (
      id SERIAL PRIMARY KEY, saint_name TEXT, lang TEXT, manifest JSONB NOT NULL, video_url TEXT, cover_url TEXT,
      created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW())`);
    await db.query(`CREATE TABLE IF NOT EXISTS project_assets (
      project_id INT REFERENCES projects(id) ON DELETE CASCADE, kind TEXT NOT NULL, idx INT NOT NULL, mime TEXT, data BYTEA NOT NULL,
      PRIMARY KEY (project_id, kind, idx))`);
    ready = true;
  }

  /** Any image -> compact JPEG (~300 KB at 1080x1920) so a project is a few MB. */
  static async toJpeg(file: string): Promise<Buffer> {
    const out = path.join(os.tmpdir(), `pj_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`);
    try {
      await ffmpeg(['-i', file, '-frames:v', '1', '-q:v', '3', out]);
      return fs.readFileSync(out);
    } finally {
      fs.rmSync(out, { force: true });
    }
  }

  async create(manifest: Manifest, assets: ProjectAssets, videoUrl: string, coverUrl: string): Promise<number> {
    await this.ensure();
    const r = await db.query(
      `INSERT INTO projects (saint_name, lang, manifest, video_url, cover_url) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [manifest.saint.name, manifest.lang, JSON.stringify(manifest), videoUrl, coverUrl]
    );
    const id: number = r.rows[0].id;
    await this.writeAssets(id, assets);
    await this.prune();
    return id;
  }

  private async writeAssets(id: number, a: ProjectAssets) {
    await db.query(`DELETE FROM project_assets WHERE project_id = $1`, [id]);
    const put = (kind: string, idx: number, mime: string, data?: Buffer) =>
      data ? db.query(`INSERT INTO project_assets (project_id, kind, idx, mime, data) VALUES ($1, $2, $3, $4, $5)`, [id, kind, idx, mime, data]) : Promise.resolve();
    await put('cover', 0, 'image/jpeg', a.cover);
    for (let i = 0; i < a.scenes.length; i++) await put('scene', i, 'image/jpeg', a.scenes[i]);
    for (let i = 0; i < a.audios.length; i++) await put('audio', i, 'audio/mpeg', a.audios[i]);
    for (const [i, buf] of Object.entries(a.aiClips)) await put('aiclip', +i, 'video/mp4', buf);
  }

  async load(id: number): Promise<{ manifest: Manifest; assets: ProjectAssets; videoUrl: string; coverUrl: string } | null> {
    await this.ensure();
    const p = await db.query(`SELECT manifest, video_url, cover_url FROM projects WHERE id = $1`, [id]);
    if (!p.rows[0]) return null;
    const manifest: Manifest = p.rows[0].manifest;
    const rows = await db.query(`SELECT kind, idx, data FROM project_assets WHERE project_id = $1`, [id]);
    const assets: ProjectAssets = { scenes: new Array(manifest.scenes.length), audios: new Array(manifest.scenes.length), aiClips: {} };
    for (const r of rows.rows) {
      if (r.kind === 'cover') assets.cover = r.data;
      else if (r.kind === 'scene') assets.scenes[r.idx] = r.data;
      else if (r.kind === 'audio') assets.audios[r.idx] = r.data;
      else if (r.kind === 'aiclip') assets.aiClips[r.idx] = r.data;
    }
    return { manifest, assets, videoUrl: p.rows[0].video_url, coverUrl: p.rows[0].cover_url };
  }

  /** Newest projects first, for the "My videos" screen. */
  async list(limit = 8): Promise<Array<{ id: number; saint_name: string; lang: string; version: number; updated_at: Date }>> {
    await this.ensure();
    const r = await db.query(`SELECT id, saint_name, lang, (manifest->>'version')::int AS version, updated_at FROM projects ORDER BY updated_at DESC LIMIT $1`, [limit]);
    return r.rows;
  }

  async save(id: number, manifest: Manifest, assets: ProjectAssets, videoUrl: string) {
    await this.ensure();
    await db.query(`UPDATE projects SET manifest = $2, lang = $3, video_url = $4, updated_at = NOW() WHERE id = $1`, [id, JSON.stringify(manifest), manifest.lang, videoUrl]);
    await this.writeAssets(id, assets);
  }

  /** Keep only the newest projects so the free Neon database (0.5 GB) never fills up. */
  private async prune() {
    await db.query(`DELETE FROM projects WHERE id NOT IN (SELECT id FROM projects ORDER BY id DESC LIMIT $1)`, [KEEP()]).catch(() => {});
  }
}

export const projectService = new ProjectService();
