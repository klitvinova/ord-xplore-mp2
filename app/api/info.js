import { applyCors, ensureSchema } from './_db.js';

/**
 * GET /api/info
 *
 * Deployment health: which intent engine will answer search queries and
 * whether the database has every migration applied. Used by the dashboard
 * header badge, and handy to open by hand right after a Vercel deploy.
 */
export default async function handler(req, res) {
  if (applyCors(req, res, 'GET,OPTIONS')) return;

  const mode = (process.env.ENGINE_MODE || 'llm').toLowerCase();
  const engines = {
    caisi: Boolean(process.env.CAISI_URL),
    gemini: Boolean(process.env.GEMINI_API_KEY),
    openai: Boolean(process.env.OPENAI_API_KEY) && !process.env.OPENAI_API_KEY.includes('dummy'),
  };

  // First engine in the fallback chain (see api/interpret.js) that is configured.
  let engine = 'heuristic';
  if (mode !== 'heuristic') {
    engine = engines.caisi ? 'caisi' : engines.gemini ? 'gemini' : engines.openai ? 'openai' : 'heuristic';
  }
  const ENGINE_NAMES = {
    caisi: 'CaISI service',
    gemini: `Gemini (${process.env.GEMINI_MODEL || 'gemini-3.6-flash'})`,
    openai: 'OpenAI (gpt-4o-mini)',
    heuristic: 'Rule-based heuristic',
  };

  let database = { ok: true, missingTables: [] };
  try {
    const schema = await ensureSchema();
    database.missingTables = schema.missing;
  } catch (err) {
    database = { ok: false, error: err.message, missingTables: [] };
  }

  res.status(200).json({
    mode,
    engine,
    engineName: ENGINE_NAMES[engine],
    engines,
    database,
    runtime: process.env.VERCEL ? 'vercel' : 'local',
    port: process.env.VERCEL ? undefined : process.env.PORT,
  });
}
