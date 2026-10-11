import { memo } from 'react'
import type { GraphRow, Segment } from '@git-graph/layout'
import { laneColor } from './graph-colors'

export const ROW_HEIGHT = 28
export const LANE_WIDTH = 18

const x = (col: number): number => col * LANE_WIDTH + LANE_WIDTH / 2
const H = ROW_HEIGHT
const MID = H / 2

function incomingPath(s: Segment): string {
  const x1 = x(s.from)
  const x2 = x(s.to)
  if (x1 === x2) return `M${x1} 0 V${MID}`
  return `M${x1} 0 C${x1} ${MID * 0.8} ${x2} ${MID * 0.4} ${x2} ${MID}`
}

function outgoingPath(s: Segment): string {
  const x1 = x(s.from)
  const x2 = x(s.to)
  if (x1 === x2) return `M${x1} ${MID} V${H}`
  return `M${x1} ${MID} C${x1} ${MID + MID * 0.6} ${x2} ${MID + MID * 0.2} ${x2} ${H}`
}

interface Props {
  row: GraphRow
  width: number
  isHead: boolean
  /** Author picture (or initials) drawn as the commit node; merges keep a small dot. */
  avatar?: { src: string | null; initials: string; hue: number }
}

export const GraphCell = memo(function GraphCell({ row, width, isHead, avatar }: Props) {
  const w = Math.max(width, 1) * LANE_WIDTH
  const cx = x(row.column)
  const color = laneColor(row.color)
  return (
    <svg width={w} height={H} className="shrink-0" aria-hidden data-column={row.column}>
      {row.passThrough.map((s) => (
        <line key={`p${s.from}`} x1={x(s.from)} y1={0} x2={x(s.to)} y2={H} stroke={laneColor(s.color)} strokeWidth={2} />
      ))}
      {row.incoming.map((s) => (
        <path key={`i${s.from}`} d={incomingPath(s)} stroke={laneColor(s.color)} strokeWidth={2} fill="none" />
      ))}
      {row.outgoing.map((s, i) => (
        <path key={`o${i}`} d={outgoingPath(s)} stroke={laneColor(s.color)} strokeWidth={2} fill="none" />
      ))}
      {row.isMerge ? (
        <circle cx={cx} cy={MID} r={4} fill={color} stroke="var(--gb-bg)" strokeWidth={1.5} />
      ) : avatar ? (
        <g data-testid="avatar-node">
          <clipPath id={`av-${row.sha}`}>
            <circle cx={cx} cy={MID} r={8} />
          </clipPath>
          {avatar.src ? (
            <image href={avatar.src} x={cx - 8} y={MID - 8} width={16} height={16} clipPath={`url(#av-${row.sha})`} preserveAspectRatio="xMidYMid slice" />
          ) : (
            <>
              <circle cx={cx} cy={MID} r={8} fill={`hsl(${avatar.hue} 45% 45%)`} />
              <text x={cx} y={MID + 2.6} textAnchor="middle" fontSize={7} fontWeight={600} fill="#fff">
                {avatar.initials}
              </text>
            </>
          )}
          <circle cx={cx} cy={MID} r={8.5} fill="none" stroke={color} strokeWidth={2} />
        </g>
      ) : (
        <circle cx={cx} cy={MID} r={6} fill={color} stroke="var(--gb-bg)" strokeWidth={2} />
      )}
      {isHead && <circle cx={cx} cy={MID} r={9} fill="none" stroke="var(--gb-fg)" strokeWidth={1.5} />}
    </svg>
  )
})
