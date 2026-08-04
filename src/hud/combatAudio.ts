// Two UI cues: your round landed, and you were hit.
//
// NOT a third positional pool. `RemoteFireEffects` owns world audio — reports and
// impacts that belong to a place and attenuate with distance — and these do not:
// a hitmarker is feedback about your own action, and the damage cue carries a
// bearing precisely because the wire refuses to carry a position. Mixing them
// into the world pool would mean giving them coordinates they do not have.
//
// Synthesised rather than sampled, like the report buffers, so this ships no
// assets and needs no loading state.

/** Panning at full deflection. Not 1: a hard-panned cue reads as a headphone
 *  fault rather than as direction, and the bearing is deliberately coarse. */
const MAX_PAN = 0.7;

let context: AudioContext | null = null;

/**
 * The shared context, created on first use.
 *
 * Lazy because a browser refuses to start one before a gesture, and the HUD
 * mounts long before the player has clicked anything. Returns null when audio is
 * unavailable at all, which is a silent HUD rather than a thrown render.
 */
function audio(): AudioContext | null {
  if (context !== null) return context;
  try {
    context = new AudioContext();
  } catch {
    return null;
  }
  return context;
}

/**
 * A short shaped blip.
 *
 * One oscillator through a gain envelope and a stereo panner. The envelope is
 * what makes it read as a tick rather than a beep — an abrupt attack and a fast
 * exponential decay, the same shape a real click has.
 */
function blip(
  frequency: number,
  seconds: number,
  gain: number,
  pan: number,
  type: OscillatorType
): void {
  const ctx = audio();
  if (ctx === null) return;
  // A context suspended by autoplay policy resumes on the first cue after a
  // gesture; before that the sound is simply dropped rather than queued, because
  // a burst of stale hitmarkers on first click is worse than silence.
  if (ctx.state === "suspended") void ctx.resume();

  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const envelope = ctx.createGain();
  const panner = ctx.createStereoPanner();

  osc.type = type;
  osc.frequency.setValueAtTime(frequency, now);
  // A slight downward sweep. Flat tones read as UI chrome; a falling one reads
  // as an impact.
  osc.frequency.exponentialRampToValueAtTime(frequency * 0.72, now + seconds);

  envelope.gain.setValueAtTime(0.0001, now);
  envelope.gain.exponentialRampToValueAtTime(gain, now + 0.004);
  envelope.gain.exponentialRampToValueAtTime(0.0001, now + seconds);

  panner.pan.setValueAtTime(Math.max(-1, Math.min(1, pan)), now);

  osc.connect(envelope).connect(panner).connect(ctx.destination);
  osc.start(now);
  osc.stop(now + seconds + 0.02);
}

/** Your round landed. A kill is lower and longer, so the two are told apart. */
export function playHitCue(fatal: boolean): void {
  if (fatal) blip(420, 0.16, 0.14, 0, "triangle");
  else blip(1180, 0.055, 0.09, 0, "square");
}

/**
 * You were hit, from roughly that way.
 *
 * The bearing is the wire's: 0 dead ahead, positive to the LEFT. Panning is the
 * sine of it, so a shot from directly ahead or behind is centred and the flanks
 * deflect — which is all the resolution the concealment rule allows anyway, and
 * the reason this is a pan rather than a positional source.
 */
export function playDamageCue(bearingRadians: number): void {
  blip(180, 0.22, 0.16, -Math.sin(bearingRadians) * MAX_PAN, "sawtooth");
}
