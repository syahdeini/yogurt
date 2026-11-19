import markUrl from '../assets/mark.png'
import { BOOT } from '../../../shared/onboarding'

/**
 * While PBN Whisper starts: the mark fades in only after BOOT.showAfterMs from the
 * page's start (not from this mount), so a quick start never flashes it; App keeps it up for BOOT.minShownMs once seen.
 */
export function BootScreen() {
  const delay = Math.max(0, BOOT.showAfterMs - performance.now())
  return (
    <div data-testid="boot-screen" className="boot-screen" style={{ animationDelay: `${delay}ms` }} role="status" aria-label="PBN Whisper">
      <img src={markUrl} alt="" width={52} height={52} className="boot-mark" draggable={false} />
    </div>
  )
}
