import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
export function IconButton({ label, children, onClick, className, disabled = false }: { label: string; children: ReactNode; onClick?: () => void; className?: string; disabled?: boolean }) {
  return <Tooltip><TooltipTrigger asChild><Button type="button" variant="ghost" size="icon" aria-label={label} onClick={onClick} disabled={disabled} className={cn('icon-button', className)}>{children}</Button></TooltipTrigger><TooltipContent side="left">{label}</TooltipContent></Tooltip>
}
