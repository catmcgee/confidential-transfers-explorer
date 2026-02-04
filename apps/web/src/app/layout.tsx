import type { Metadata } from 'next';
import './globals.css';
import { Header } from '@/components/Header';
import { WalletProvider } from '@/components/WalletProvider';

export const metadata: Metadata = {
  title: 'Confidential Transfer Explorer',
  description: 'Explore Confidential Transfer activity on Solana',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <WalletProvider>
          <Header />
          <main className="container mx-auto px-4 py-8">{children}</main>
        </WalletProvider>
      </body>
    </html>
  );
}
