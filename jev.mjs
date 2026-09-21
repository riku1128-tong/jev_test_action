// Jev (TypeSafe System One) integration — zero dependencies, Node 18+ fetch.
// Owns: the API key, the question definitions, the HTTP call.
// Does NOT own: game rules. Code composes the answers client-side.
import { existsSync, readFileSync, appendFile } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const API_BASE = 'https://api.typesafe.ai/v1';
export const MODEL = 'jev-latest';

// ---------------------------------------------------------------------------
// Usage metering. Every successful call appends one JSON line to usage.jsonl
// ({ts, model, input_tokens, output_tokens}). The Claude Code Task Board
// (claude-board) reads this file and computes cost = input_tokens × $0.042/M —
// the same formula console.typesafe.ai shows as "Estimated". Fire-and-forget:
// a logging failure must never affect the real-time path.
// ---------------------------------------------------------------------------
export const USAGE_LOG = path.join(__dirname, 'usage.jsonl');
function logUsage(usage, model) {
  if (!usage || typeof usage !== 'object') return;
  const line = JSON.stringify({ ts: new Date().toISOString(), model: model || MODEL, input_tokens: usage.input_tokens | 0, output_tokens: usage.output_tokens | 0 }) + '\n';
  appendFile(USAGE_LOG, line, () => {});
}

export function loadApiKey() {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;
  // Fallback: a local .env next to this file (gitignored). Never logged.
  const envPath = path.join(__dirname, '.env');
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*TYPESAFE_API_KEY\s*=\s*"?([^"\s]+)"?\s*$/);
      if (m) return m[1];
    }
  }
  // Fallback (Windows): a User-scope variable set with `setx` after this
  // process's parent started is not in process.env yet — read the registry.
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', 'TYPESAFE_API_KEY'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const m = out.match(/TYPESAFE_API_KEY\s+REG_(?:EXPAND_)?SZ\s+(\S+)/);
      if (m) return m[1];
    } catch { /* not set */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Questions. All four are independent judgments over the same state, so they
// go in ONE request and run in parallel. IDs are for code only; the meaning
// has to be complete inside instructions/criteria.
// ---------------------------------------------------------------------------
export const QUESTIONS = {
  skill: {
    type: 'score',
    instructions: {
      question:
        'How skilled is this player at the platforming described in `game.description`, judging from `recent_attempts` (oldest first, most recent last)?',
      focus:
        'Weigh each attempt against how demanding it was (its `challenge`). Landing near the center of a hard platform with no hesitation is strong evidence of skill; falling on an easy one is strong evidence against. Recent attempts matter more than older ones.',
    },
    criteria: [
      {
        what: 'Falls or gets caught by the wall on most attempts; jumps far too early or too late and rarely reaches the next platform, even when the gap is small.',
      },
      {
        what: 'Reaches the next platform sometimes, but often only barely, and tends to pause for a long time before committing to a jump.',
      },
      {
        what: 'Usually lands, though sometimes near the front edge; jump timing is inconsistent and there is occasional hesitation.',
      },
      {
        what: 'Lands reliably with a decent margin; jump timing is mostly good and there is little hesitation, including on harder layouts.',
      },
      {
        what: 'Lands nearly every jump near the center of the platform with well-timed jumps and no hesitation, even on long gaps, high steps, narrow or moving platforms.',
      },
    ],
  },

  next_platform: {
    type: 'choice',
    instructions: {
      question:
        'Which kind of platform should appear next so that this player stays in flow: challenged, but not overwhelmed?',
      consider:
        'Use `recent_attempts`, `player.current_streak_without_falling`, `player.falls_in_recent_attempts` and `latest_attempt`. A player who just fell should get something forgiving; a player landing every jump with room to spare should get something that demands more. Vary the kind when the player has handled the same kind several times in a row.',
    },
    criteria: {
      breather: {
        what: 'A wide platform placed very close, almost impossible to miss.',
        for: 'A player who just fell, is being caught by the wall, or is clearly struggling on the current layouts.',
      },
      standard: {
        what: 'An ordinary gap and width, matching the current difficulty.',
        for: 'A player performing about as expected: landing most jumps without much drama.',
      },
      long_jump: {
        what: 'Same height, but a noticeably longer gap that needs a full-power jump from near the edge.',
        for: 'A player who consistently lands with plenty of margin and jumps with good timing.',
      },
      high_step: {
        what: 'A platform placed higher than the current one, requiring a full jump started close to the edge.',
        for: 'A player whose jump timing is precise and who does not hesitate.',
      },
      drop: {
        what: 'A platform placed lower and farther away; the player must commit to a long fall.',
        for: 'A confident player who commits to jumps without pausing.',
      },
      narrow: {
        what: 'A short landing surface that punishes imprecise landings.',
        for: 'A player who lands near the center of platforms consistently.',
      },
      moving: {
        what: 'A platform that slides back and forth, so the jump must be anticipated.',
        for: 'An advanced player who has handled long gaps and narrow platforms without trouble.',
      },
    },
  },

  frustrated: {
    type: 'noul',
    instructions:
      'Is this player likely frustrated right now because of repeated recent failures?',
    criteria: {
      true: 'Several falls or wall catches in the last few attempts, or repeated failures on the same kind of challenge.',
      false: 'At most an isolated failure; most recent attempts succeeded.',
    },
  },

  cruising: {
    type: 'noul',
    instructions: 'Is this player clearly under-challenged by the current layouts?',
    criteria: {
      true: 'Recent attempts all landed, mostly with room to spare rather than barely, without long pauses before jumping — even on hard or very hard layouts.',
      false: 'Any recent fall or wall catch, several barely-made-it landings, or long pauses before jumping.',
    },
  },
};

// ---------------------------------------------------------------------------
// HTTP call. One retry on 429/529 with a short backoff — this is on a
// real-time path, so we would rather fall back in the client than wait long.
// ---------------------------------------------------------------------------
export async function askJev(apiKey, state, { signal } = {}) {
  const body = JSON.stringify({ model: MODEL, state, questions: QUESTIONS });
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const t0 = performance.now();
    const res = await fetch(`${API_BASE}/systemone`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body,
      signal,
    });
    const latency_ms = Math.round(performance.now() - t0);
    if (res.ok) {
      const json = await res.json();
      logUsage(json.usage, json.model);
      return { ...json, latency_ms };
    }
    const text = await res.text().catch(() => '');
    lastErr = Object.assign(new Error(`TypeSafe ${res.status}: ${text.slice(0, 300)}`), {
      status: res.status,
    });
    if (res.status === 429 || res.status === 529) {
      await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
      continue;
    }
    throw lastErr;
  }
  throw lastErr;
}

export async function listModels(apiKey) {
  const res = await fetch(`${API_BASE}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`TypeSafe ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}
