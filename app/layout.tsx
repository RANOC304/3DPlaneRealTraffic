import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: 'Skytrace — Live 3D Air Traffic',
  description: 'Explore live global air traffic around a fully interactive 3D Earth.',
  icons: { icon: '/favicon.svg' },
  openGraph: {
    title: 'Skytrace — Live 3D Air Traffic',
    description: 'Explore real aircraft around a fully interactive 3D Earth with free-flight camera controls.',
    type: 'website',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'Skytrace live 3D air traffic around Earth' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Skytrace — Live 3D Air Traffic',
    description: 'Explore real aircraft around a fully interactive 3D Earth.',
    images: ['/og.png'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
