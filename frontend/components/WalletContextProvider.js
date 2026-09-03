import { useMemo } from 'react';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
 
export default function WalletContextProvider({ children }) {
  const endpoint = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || 'https://api.devnet.solana.com';
 
  // Phantom and Solflare both implement the Wallet Standard now, so
  // they're auto-detected without needing explicit adapter classes.
  // Deliberately NOT importing from @solana/wallet-adapter-wallets —
  // that package bundles adapters for many wallets we don't use
  // (Ledger, Torus, etc.), and pulling it in drags in their
  // dependencies too, including a broken one in some versions.
  const wallets = useMemo(() => [], []);
 
  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
