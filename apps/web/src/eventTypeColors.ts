export const EVENT_TYPE_HEX: Record<string, string> = {
  impact: '#e74c3c',
  parking: '#e67e22',
  manual: '#3498db',
  other: '#95a5a6',
}

export const EVENT_TYPE_DOT_CLASS: Record<string, string> = {
  impact: 'bg-red-500',
  parking: 'bg-orange-500',
  manual: 'bg-blue-500',
  other: 'bg-zinc-400',
}

export const EVENT_TYPE_BADGE_COLOR: Record<string, 'red' | 'orange' | 'blue' | 'zinc'> = {
  impact: 'red',
  parking: 'orange',
  manual: 'blue',
  other: 'zinc',
}
