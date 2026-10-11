import { initials, nameHue, useEmailAvatar, type AvatarSource } from '../lib/avatars'

/** Author avatar: the hosting service's picture when available, otherwise colored initials. */
export function Avatar({ name, email, source, size = 20 }: { name: string; email: string; source: AvatarSource; size?: number }) {
  const src = useEmailAvatar(email, source)
  if (src) return <img src={src} alt="" width={size} height={size} className="shrink-0 rounded-full" />
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
      style={{ width: size, height: size, fontSize: size * 0.42, background: `hsl(${nameHue(name)} 45% 45%)` }}
    >
      {initials(name)}
    </span>
  )
}
