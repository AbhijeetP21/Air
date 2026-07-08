import { Suspense } from 'react'
import Link from 'next/link'

import { AuthForm } from '@/components/auth/AuthForm'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

export default function LoginPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm space-y-6">
        <Link
          href="/"
          className="flex items-center justify-center gap-2 text-lg font-semibold tracking-tight"
        >
          <span className="inline-block size-2.5 rounded-full bg-primary" />
          Air
        </Link>

        <Card>
          <CardHeader className="text-center">
            <CardTitle>Sign in to Air</CardTitle>
            <CardDescription>
              Active Interaction Rooms — large-group video calls for up to 50
              people.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Suspense fallback={<div className="h-48" />}>
              <AuthForm />
            </Suspense>
          </CardContent>
        </Card>

        <p className="px-6 text-center text-xs text-muted-foreground">
          Heads up: Air relays your audio and video through a media server so
          rooms can scale — calls are not peer-to-peer private.
        </p>
      </div>
    </main>
  )
}
