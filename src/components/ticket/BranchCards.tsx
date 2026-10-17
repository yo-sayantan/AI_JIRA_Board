import { useEffect, useRef, useState } from 'react'
import { motion } from 'motion/react'
import type { PrState } from '../../types'
import { branchStatusMeta } from '../../lib/format'
import { copyText } from '../common/ui'
import { BranchIcon, CheckIcon, CopyIcon } from '../common/Icons'
import { lift, tint } from '../../lib/tone'
import { PRESS } from '../../lib/motion'

/** A branch with no pull request of its own: a calm indigo, so a plain branch still has a colour of its own. */
const PLAIN = { label: 'branch', color: '#6d7cff' }

/** The card's hue and caption: the PR state colours (`branchStatusMeta`), or PLAIN when no PR comes from it. */
export function branchCardMeta(state?: PrState | null): { label: string; color: string } {
  return !state || state === 'none' ? PLAIN : branchStatusMeta(state)
}

/**
 * The drawer's branches as small glass cards — clicking one copies the branch name. The glass stays neutral (the
 * material's job is light and depth, not colour); the branch's state shows in a thin top edge, the icon chip and the
 * caption. No blur on purpose: cards sit on the drawer's own glass (stacked backdrop-filters are the anti-pattern).
 */
export function BranchCards({ branches, stateOf }: { branches: string[]; stateOf: (branch: string) => PrState | null | undefined }) {
  return (
    <ul className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))' }}>
      {branches.map((b) => (
        <li key={b} className="min-w-0">
          <BranchCard name={b} state={stateOf(b)} />
        </li>
      ))}
    </ul>
  )
}

function BranchCard({ name, state }: { name: string; state?: PrState | null }) {
  const { label, color } = branchCardMeta(state)
  const [copy, setCopy] = useState<'idle' | 'done' | 'failed'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const done = copy === 'done'
  const failed = copy === 'failed'
  return (
    <motion.button
      type="button"
      whileHover={{ y: -2 }}
      whileTap={{ scale: 0.97 }}
      transition={PRESS}
      onClick={() => {
        void copyText(name).then((ok) => {
          setCopy(ok ? 'done' : 'failed')
          clearTimeout(timer.current)
          timer.current = setTimeout(() => setCopy('idle'), ok ? 1300 : 2400)
        })
      }}
      aria-label={`Copy branch name ${name}`}
      title={failed ? `Copy failed — select and copy by hand: ${name}` : `${name}\nClick to copy`}
      className="glass-interactive relative flex h-full w-full min-w-0 flex-col gap-1.5 overflow-hidden rounded-xl border bg-[var(--surface-solid)] px-3 pb-2.5 pt-3 text-left card-shadow"
      style={{ borderColor: done ? tint('#22c55e', 0.6) : tint(color, 0.32) }}
    >
      {/* the state's colour, as light catching the top edge */}
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[2px]" style={{ background: `linear-gradient(90deg, ${color}, ${tint(color, 0.15)} 70%, transparent)` }} />
      <span className="flex items-center gap-1.5">
        <span className="grid h-5 w-5 shrink-0 place-items-center rounded-md" style={{ background: tint(color, 0.14), boxShadow: `inset 0 0 0 1px ${tint(color, 0.22)}` }} aria-hidden>
          <BranchIcon size={11} color={lift(color)} />
        </span>
        <span className="truncate text-[10px] font-bold uppercase tracking-wide" style={{ color: lift(color) }}>
          {label}
        </span>
        <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-[10px] font-semibold" style={{ color: done ? lift('#16a34a') : failed ? lift('#ef4444') : 'var(--muted)' }} aria-live="polite">
          {done ? <CheckIcon size={11} color={lift('#22c55e')} /> : <CopyIcon size={11} color={failed ? lift('#ef4444') : undefined} />}
          {done ? 'Copied' : failed ? 'Copy failed' : 'Copy'}
        </span>
      </span>
      <code className="line-clamp-2 break-all font-mono text-[11.5px] font-medium leading-snug text-[var(--ink)]">{name}</code>
    </motion.button>
  )
}
