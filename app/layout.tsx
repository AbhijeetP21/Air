import type { Metadata, Viewport } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'

import { validateEnv } from '@/lib/env'
import { Toaster } from '@/components/ui/sonner'
import './globals.css'

// Fail fast at startup if required configuration is missing.
validateEnv()

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
})

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
})

export const metadata: Metadata = {
  title: 'Rally: Large-group video calls',
  description:
    'Video calls for groups of up to 50. An SFU forwards one upstream to everyone, so rooms scale far past a peer-to-peer mesh.',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Draw under the notch/home indicator so the call UI can use the full screen
  // (the control bar handles safe-area insets itself).
  viewportFit: 'cover',
  themeColor: '#09090b',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className={`dark ${geistSans.variable} ${geistMono.variable}`}>
      <body className="min-h-dvh bg-background text-foreground antialiased">
        {children}
        <Toaster />
      </body>
    </html>
  )
}
