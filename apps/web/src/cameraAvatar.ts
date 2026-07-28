// Deterministic default color for a camera's avatar (car icon) when no
// photo has been uploaded — same palette and hash as the iOS app's
// CameraAvatar.swift, so a given camera shows the same color on both
// platforms without needing to store a color anywhere.
const AVATAR_PALETTE = [
  '#ef4444', // red
  '#f97316', // orange
  '#f59e0b', // amber
  '#84cc16', // lime
  '#10b981', // emerald
  '#06b6d4', // cyan
  '#3b82f6', // blue
  '#8b5cf6', // violet
  '#ec4899', // pink
]

// 32-bit FNV-ish rolling hash over the string's UTF-16 code units — only
// needs to be deterministic and cheap, not cryptographically sound. Mirror
// exactly in Swift (byte-for-byte, since camera ids are plain ASCII) if
// this ever changes.
function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0
  }
  return Math.abs(h)
}

export function avatarColorFor(id: string): string {
  return AVATAR_PALETTE[hashString(id) % AVATAR_PALETTE.length]
}
