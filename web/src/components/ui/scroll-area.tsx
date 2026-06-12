import * as React from 'react'
import { cn } from '@/lib/utils'

export function ScrollArea({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('min-h-0 overflow-auto', className)} {...props} />
}
