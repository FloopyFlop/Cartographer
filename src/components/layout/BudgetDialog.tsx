import { useEffect, useState } from 'react'
import { Wallet } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { imageryDescription } from '@/lib/imagery'
import { searchService } from '@/services/api'
import type { BudgetUsage, ProviderBudget } from '@/services/api'

const money = (value: number) => new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', minimumFractionDigits: 2,
  maximumFractionDigits: value > 0 && value < 0.01 ? 4 : 2,
}).format(value)

function BudgetRow({ name, budget }: { name: string; budget: ProviderBudget }) {
  return <tr className="border-b border-border last:border-0">
    <th scope="row" className="py-4 pr-2 text-left font-medium">
      {name}<span className="mt-1 block text-xs font-normal text-muted-foreground">{money(budget.limitUsd)} ceiling</span>
    </th>
    <td className="px-1 py-4 text-right tabular-nums">{money(budget.usedUsd)}</td>
    <td className="px-1 py-4 text-right tabular-nums">{money(budget.reservedUsd)}</td>
    <td className="py-4 pl-1 text-right tabular-nums">{money(budget.remainingUsd)}</td>
  </tr>
}

export function BudgetDialog() {
  const [open, setOpen] = useState(false)
  const [usage, setUsage] = useState<BudgetUsage | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    void searchService.usage(controller.signal).then(value => {
      if (!controller.signal.aborted) setUsage(value)
    }).catch(reason => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Usage could not be loaded. Please try again.')
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false)
    })
    return () => controller.abort()
  }, [open, attempt])

  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger asChild>
      <Button variant="ghost" size="sm" aria-label="Usage & sources" className="usage-trigger text-muted-foreground hover:text-foreground">
        <Wallet aria-hidden="true"/><span className="hidden sm:inline">Usage &amp; sources</span>
      </Button>
    </DialogTrigger>
    <DialogContent className="w-[calc(100vw-2rem)] max-w-lg max-h-[85dvh] overflow-y-auto rounded-lg bg-background text-foreground">
      <DialogHeader className="text-left">
        <DialogTitle>Usage &amp; sources</DialogTitle>
        <DialogDescription>Search spending and the imagery behind your results.</DialogDescription>
      </DialogHeader>
      {loading ? <p role="status" className="py-6 text-sm text-muted-foreground">Loading usage…</p>
        : error ? <div className="space-y-3 py-3">
          <p role="alert" className="text-sm leading-relaxed text-foreground">{error}</p>
          <Button variant="outline" size="sm" onClick={() => setAttempt(value => value + 1)}>Try again</Button>
        </div>
          : usage && <div className="space-y-5">
            <div>
              <table className="w-full text-xs sm:text-sm">
                <caption className="sr-only">Local provider budgets in US dollars</caption>
                <thead className="border-b border-border text-xs text-muted-foreground">
                  <tr><th scope="col" className="pb-2 text-left font-normal">Provider</th>
                    <th scope="col" className="px-1 pb-2 text-right font-normal">Used (est.)</th>
                    <th scope="col" className="px-1 pb-2 text-right font-normal">Reserved</th>
                    <th scope="col" className="pb-2 text-right font-normal">Remaining</th></tr>
                </thead>
                <tbody><BudgetRow name="Google" budget={usage.google}/><BudgetRow name="OpenAI" budget={usage.openai}/></tbody>
              </table>
              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">These ceilings cover this local Cartographer instance; they do not limit other activity on your provider accounts.</p>
            </div>
            <div className="border-t border-border pt-4 text-sm leading-relaxed">
              <p className="font-medium">Street-level imagery</p>
              <p className="mt-1 text-muted-foreground">{usage.liveSearchAvailable
                ? imageryDescription(usage.imageryProvider || 'google')
                : usage.blockedReason || 'Live search is not configured yet. Demonstration layers remain available.'}</p>
              <p className="mt-3 text-xs text-muted-foreground">Vision model <span className="ml-2 text-foreground">{usage.model || 'Not configured'}</span></p>
            </div>
          </div>}
    </DialogContent>
  </Dialog>
}
