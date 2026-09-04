import '@solana/wallet-adapter-react-ui/styles.css';
import '../styles/globals.css';
import WalletContextProvider from '../components/WalletContextProvider';

export default function App({ Component, pageProps }) {
  return (
    <WalletContextProvider>
      <Component {...pageProps} />
    </WalletContextProvider>
  );
}
