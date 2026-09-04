/**
 * Minimal profanity filter for user-facing text (currently: display names).
 *
 * This is intentionally simple — a normalized substring match against a
 * moderate word list — not a comprehensive content-moderation system. It
 * catches common cases (plus basic leetspeak substitutions like "@" for
 * "a") without pulling in a third-party dependency. If this app grows a
 * real moderation need later, swap this out for a proper service; don't
 * try to make this list exhaustive by hand.
 */

const BLOCKED_WORDS = [
  'fuck',
  'shit',
  'bitch',
  'asshole',
  'bastard',
  'dick',
  'piss',
  'cunt',
  'slut',
  'whore',
  'nigger',
  'nigga',
  'faggot',
  'retard',
  'rape',
];

// Common leetspeak substitutions so "fuck" -> "fuk"/"f*ck"/"f@ck" etc.
// still get caught, while keeping the check simple and fast.
const SUBSTITUTIONS = {
  '@': 'a',
  '4': 'a',
  '3': 'e',
  '1': 'i',
  '!': 'i',
  '0': 'o',
  '$': 's',
  '5': 's',
  '7': 't',
};

function normalize(text) {
  return text
    .toLowerCase()
    .split('')
    .map((ch) => SUBSTITUTIONS[ch] || ch)
    .join('')
    .replace(/[^a-z0-9]/g, ''); // drop spaces/punctuation so "f u c k" still matches
}

function containsProfanity(text) {
  if (!text) return false;
  const normalized = normalize(text);
  return BLOCKED_WORDS.some((word) => normalized.includes(word));
}

module.exports = { containsProfanity };
