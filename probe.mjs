// Connectivity probe: lists models and fires three sample judgments, printing latency.
import { askJev, listModels, loadApiKey, QUESTIONS } from './jev.mjs';

const key = loadApiKey();
if (!key) {
  console.error('TYPESAFE_API_KEY not set (env var or ./.env)');
  process.exit(1);
}
console.log('models:', JSON.stringify(await listModels(key), null, 2));

const state = {
  game: {
    description:
      'Side-scrolling platformer. The player runs right and jumps across gaps between floating platforms. Falling into a gap or being caught by the wall advancing from the left costs a life.',
  },
  player: { lives_left: 3, platforms_cleared: 4, current_streak_without_falling: 4, falls_in_recent_attempts: 0 },
  current_difficulty: 'moderate',
  recent_attempts: [
    { challenge: { kind: 'standard', gap_px: 110, height_change_px: 0, landing_width_px: 150, difficulty: 'moderate' }, outcome: 'landed', jump_timing: 'well_timed', landing_spot: 'center', hesitation: 'none' },
    { challenge: { kind: 'long_jump', gap_px: 160, height_change_px: 0, landing_width_px: 130, difficulty: 'moderate' }, outcome: 'landed', jump_timing: 'at_the_very_edge', landing_spot: 'deep', hesitation: 'none' },
    { challenge: { kind: 'narrow', gap_px: 120, height_change_px: 0, landing_width_px: 60, difficulty: 'hard' }, outcome: 'landed', jump_timing: 'well_timed', landing_spot: 'center', hesitation: 'none' },
  ],
};
state.latest_attempt = state.recent_attempts.at(-1);

for (let i = 0; i < 3; i++) {
  const out = await askJev(key, state);
  console.log(`#${i + 1} ${out.model} latency=${out.latency_ms}ms usage=${JSON.stringify(out.usage)}`);
  if (i === 0) console.log(JSON.stringify(out.answers, null, 2));
}
console.log(`questions per request: ${Object.keys(QUESTIONS).length}`);
