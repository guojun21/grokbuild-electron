import {
  Binoculars,
  BookOpen,
  Bot,
  Crown,
  Eye,
  Hammer,
  Monitor,
  Paintbrush,
  Search,
  Settings,
  ShieldCheck,
  SquareTerminal,
  UserRound,
  Wrench,
  Zap
} from 'lucide-react'
import React, { type CSSProperties } from 'react'

interface AgentAvatarProps {
  glyph: string
  color: string
  label?: string
  size?: 'small' | 'medium' | 'large'
  redacted?: boolean
}

export const AGENT_GLYPH_CHOICES = [
  { value: 'person.fill', label: 'Person' },
  { value: 'crown.fill', label: 'Lead' },
  { value: 'binoculars', label: 'Scout' },
  { value: 'hammer.fill', label: 'Builder' },
  { value: 'checkmark.shield.fill', label: 'Verifier' },
  { value: 'desktopcomputer', label: 'Operator' },
  { value: 'magnifyingglass', label: 'Research' },
  { value: 'wrench.and.screwdriver.fill', label: 'Tools' },
  { value: 'book.fill', label: 'Docs' },
  { value: 'bolt.fill', label: 'Fast' },
  { value: 'eye.fill', label: 'Review' },
  { value: 'gearshape.2.fill', label: 'Systems' },
  { value: 'paintbrush.fill', label: 'Design' },
  { value: 'terminal.fill', label: 'Terminal' }
] as const

export const AGENT_COLOR_CHOICES = [
  '#5E5CE6',
  '#0A84FF',
  '#FF9F0A',
  '#30D158',
  '#FF375F',
  '#BF5AF2',
  '#64D2FF',
  '#FFD60A'
] as const

export function AgentAvatar({
  glyph,
  color,
  label,
  size = 'medium',
  redacted = false
}: AgentAvatarProps): React.JSX.Element {
  const style = { '--agent-color': redacted ? '#697181' : color } as CSSProperties
  return (
    <span
      className={`agent-avatar agent-avatar-${size}`}
      style={style}
      {...(label
        ? { role: 'img', 'aria-label': redacted ? label : `Saved Agent ${label}` }
        : { 'aria-hidden': true })}
    >
      <AgentGlyph glyph={redacted ? 'person.fill' : glyph} />
    </span>
  )
}

function AgentGlyph({ glyph }: { glyph: string }): React.JSX.Element {
  switch (glyph) {
    case 'crown.fill': return <Crown />
    case 'binoculars': return <Binoculars />
    case 'hammer.fill': return <Hammer />
    case 'checkmark.shield.fill': return <ShieldCheck />
    case 'desktopcomputer': return <Monitor />
    case 'magnifyingglass': return <Search />
    case 'wrench.and.screwdriver.fill': return <Wrench />
    case 'book.fill': return <BookOpen />
    case 'bolt.fill': return <Zap />
    case 'eye.fill': return <Eye />
    case 'gearshape.2.fill': return <Settings />
    case 'paintbrush.fill': return <Paintbrush />
    case 'terminal.fill': return <SquareTerminal />
    case 'person.fill': return <UserRound />
    default: return <Bot />
  }
}
