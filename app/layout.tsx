import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'English Listening',
  description: 'Local, per-sentence English listening trainer',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-canvas text-ink">{children}</body>
    </html>
  )
}
