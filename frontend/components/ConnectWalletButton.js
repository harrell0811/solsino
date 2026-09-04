import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';

// WalletMultiButton reads browser-only wallet state, so it's loaded client-side only
// to avoid a server/client render mismatch (same reasoning as before in pages/index.js).
const WalletMultiButton = dynamic(
  () => import('@solana/wallet-adapter-react-ui').then((mod) => mod.WalletMultiButton),
  { ssr: false }
);

function isMobileUserAgent() {
  if (typeof navigator === 'undefined') return false;
  return /android|iphone|ipad|ipod/i.test(navigator.userAgent);
}

function hasInjectedSolanaWallet() {
  if (typeof window === 'undefined') return false;
  // Present when already inside Phantom's (or another wallet's) in-app browser,
  // or when a desktop extension is installed.
  return Boolean(window.phantom?.solana || window.solana);
}

// Builds Phantom's "universal link" which opens the given URL inside Phantom's
// own in-app browser. Once there, window.phantom.solana exists and the normal
// wallet-adapter flow (WalletMultiButton, sendTransaction, etc.) works exactly
// as it already does on desktop — no other code needs to change.
function buildPhantomDeepLink(url) {
  const encodedUrl = encodeURIComponent(url);
  const ref = encodeURIComponent(window.location.origin);
  return `https://phantom.app/ul/browse/${encodedUrl}?ref=${ref}`;
}

export default function ConnectWalletButton() {
  // Start as "desktop-ish" so SSR and first client render match; the real
  // check runs client-side right after mount, before the user can interact.
  const [needsDeepLink, setNeedsDeepLink] = useState(false);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    setNeedsDeepLink(isMobileUserAgent() && !hasInjectedSolanaWallet());
    setChecked(true);
  }, []);

  if (!checked) return null;

  if (needsDeepLink) {
    return (
      <button
        className="btn btn-brand"
        onClick={() => {
          window.location.href = buildPhantomDeepLink(window.location.href);
        }}
      >
        Connect
      </button>
    );
  }

  return <WalletMultiButton />;
}
