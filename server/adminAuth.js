/**
 * Minimal admin auth: every admin route (and any other route that
 * moves real house funds) must be gated behind this. Client sends
 * the key in the `x-admin-key` header.
 *
 * Set ADMIN_API_KEY in .env before deploying. If it's unset, admin
 * routes are locked out entirely (fail closed) rather than silently
 * left open, except in local dev where an unset key just logs a
 * loud warning and allows a hardcoded dev key through — devnet only,
 * never rely on that in anything user-facing.
 */

const DEV_FALLBACK_KEY = 'dev-only-change-me';

function requireAdmin(req, res, next) {
  const configuredKey = process.env.ADMIN_API_KEY;
  const providedKey = req.get('x-admin-key');

  if (!configuredKey) {
    console.warn(
      '[adminAuth] ADMIN_API_KEY is not set — falling back to a dev-only key. ' +
        'Set ADMIN_API_KEY in .env before this ever leaves your machine.'
    );
    if (providedKey === DEV_FALLBACK_KEY) return next();
    return res.status(401).json({ error: 'unauthorized (ADMIN_API_KEY not configured)' });
  }

  if (!providedKey || providedKey !== configuredKey) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  next();
}

module.exports = { requireAdmin, DEV_FALLBACK_KEY };
