import { avatarColorFor } from '../cameraAvatar'

const SIZE_CLASSES = {
  sm: 'size-6',
  md: 'size-8',
  lg: 'size-12',
} as const

// A camera's photo if one's been uploaded (Settings page), otherwise a
// colored car icon — color derived deterministically from `id` so the same
// camera always gets the same default color, matching the iOS app's
// CameraAvatar.swift.
export function CameraAvatar({
  id,
  name,
  avatarUrl,
  size = 'md',
  className,
  ...rest
}: {
  id: string
  name: string
  avatarUrl?: string | null
  size?: keyof typeof SIZE_CLASSES
  className?: string
} & React.ComponentPropsWithoutRef<'div'>) {
  const sizeClass = SIZE_CLASSES[size]

  if (avatarUrl) {
    return (
      <img
        src={avatarUrl}
        alt={name}
        {...rest}
        className={`${sizeClass} shrink-0 rounded-full object-cover outline -outline-offset-1 outline-black/10 dark:outline-white/10 ${className ?? ''}`}
      />
    )
  }

  return (
    <div
      {...rest}
      className={`flex ${sizeClass} shrink-0 items-center justify-center rounded-full ${className ?? ''}`}
      style={{ backgroundColor: avatarColorFor(id) }}
      role="img"
      aria-label={name}
    >
      <svg viewBox="0 0 24 24" fill="none" className="size-[60%] text-white">
        <path
          d="M4 16v-3.2a1 1 0 0 1 .1-.44l1.55-3.32A2 2 0 0 1 7.46 8h9.08a2 2 0 0 1 1.81 1.14l1.55 3.42a1 1 0 0 1 .1.44V16a1 1 0 0 1-1 1h-1a1 1 0 0 1-1-1v-.5H7v.5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1Z"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
        <circle cx="7.5" cy="16" r="1.4" fill="currentColor" />
        <circle cx="16.5" cy="16" r="1.4" fill="currentColor" />
        <path d="M4.5 12.5h15" stroke="currentColor" strokeWidth="1.6" />
      </svg>
    </div>
  )
}
