import markUrl from '../assets/mark.png'
import wordmarkUrl from '../assets/wordmark.png'

/** The PBN Whisper mark. */
export function Logo({ size = 28, className = '' }: { size?: number; className?: string }) {
  return <img data-testid="logo" src={markUrl} alt="" width={size} height={size} className={`shrink-0 ${className}`} draggable={false} />
}

/** The wordmark. Sized by its height. */
export function Wordmark({ height = 32, className = '' }: { height?: number; className?: string }) {
  return <img data-testid="wordmark" src={wordmarkUrl} alt="PBN Whisper" height={height} className={`shrink-0 w-auto ${className}`} draggable={false} />
}
