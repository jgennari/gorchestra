import { Monitor, Moon, Sun } from 'lucide-react'
import type { ResolvedTheme, ThemePreference } from '@/hooks/use-theme'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

type Props = {
  preference: ThemePreference
  resolvedTheme: ResolvedTheme
  onToggle: () => void
  showTooltip?: boolean
}

export function ThemeToggle({ preference, resolvedTheme, onToggle, showTooltip = true }: Props) {
  const Icon = preference === 'system' ? Monitor : resolvedTheme === 'dark' ? Moon : Sun
  const label = `Theme: ${themeLabel(preference)}`
  const button = (
    <Button
      type="button"
      variant="outline"
      size="icon"
      aria-label={label}
      onClick={onToggle}
      className="border-border/70 bg-background/70"
    >
      <Icon />
    </Button>
  )

  if (!showTooltip) {
    return button
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function themeLabel(preference: ThemePreference) {
  if (preference === 'system') return 'System'
  if (preference === 'dark') return 'Dark'
  return 'Light'
}
